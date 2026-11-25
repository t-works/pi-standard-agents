/**
 * The `standard_agent` tool: four actions, no blocking turn, one wake.
 *
 * The four assertions are the four promises the tool makes:
 *  - **`start` is detached.** It answers in under 100 ms while the scripted model
 *    is still 300 ms into its second step, and the run id it returns is a real
 *    directory under `.pi/standard-agents/runs/`.
 *  - **`status` tells the truth.** `running` while the turn is live, `idle` once
 *    the background settle finished, with the tokens the journal measured.
 *  - **`message` and `stop` reach the run.** A posted message is persisted as a
 *    user message on that thread, and stopping the run leaves parent *and* child
 *    `terminated` in `thread.json`.
 *  - **The deadline is the host's.** `deadlineMs: 100` against a provider that
 *    never answers records `failed`/`deadline` in the journal and fires exactly
 *    one completion wake.
 *
 * Everything runs offline: a scripted provider stands in for the model, temp
 * directories for the run tree, and no PI session is started.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type {
	ProviderConfigSlots,
	ProviderFactory,
	ProviderInstance,
	ProviderRequest,
	ProviderResponse,
} from "@standardagents/spec";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { StandardAgentToolOptions } from "../src/extension.ts";
import extension, {
	COMPLETION_CUSTOM_TYPE,
	STANDARD_AGENT_TOOL_NAME,
} from "../src/extension.ts";
import type { ToolSpec } from "../src/registry.ts";
import { JOURNAL_FILE, RECORD_FILE, RUNS_DIR, RunService, STORE_DIR } from "../src/runs.ts";
import type { FakePi, RecordedMessage } from "./fake-pi.ts";
import { createFakePi } from "./fake-pi.ts";
import type { ScriptedReply } from "./scripted.ts";
import { scriptedProvider } from "./scripted.ts";

const CONFIG_SLOTS: ProviderConfigSlots = {
	// The runtime refuses to build a provider it cannot see an API key for. This
	// one talks to nothing, so the slot carries a fake default.
	apiKey: { type: "text", default: "tool-test-provider" },
};

const TOKENS = { promptTokens: 11, completionTokens: 5, totalTokens: 16 };

// ── providers ───────────────────────────────────────────────────────────────

/**
 * A scripted provider that can be slow, so a test can prove the tool call does
 * *not* wait for the turn. `delays[i]` is how long call `i` takes; the last delay
 * repeats.
 */
function delayingProvider(
	script: readonly ScriptedReply[],
	delays: readonly number[] = [],
): ProviderFactory & { readonly calls: number } {
	const inner = scriptedProvider(script);
	let calls = 0;

	const factory = ((config: unknown) => {
		const instance = inner(config as never);
		const wrapped: ProviderInstance = {
			...instance,
			async generate(request: ProviderRequest): Promise<ProviderResponse> {
				const delay = delays[Math.min(calls, delays.length - 1)] ?? 0;
				calls += 1;
				if (delay > 0) await sleep(delay);
				return instance.generate(request);
			},
		};
		return wrapped;
	}) as unknown as ProviderFactory & { readonly calls: number };

	Object.defineProperty(factory, "name", { value: "scripted" });
	Object.defineProperty(factory, "configSlots", { value: CONFIG_SLOTS });
	Object.defineProperty(factory, "calls", { get: () => calls });
	return factory;
}

/** A provider whose every answer never comes: the case a deadline exists for. */
function neverProvider(): ProviderFactory {
	const factory = ((_config: unknown) => ({
		name: "scripted",
		specificationVersion: "1",
		generate: () => new Promise<ProviderResponse>(() => {}),
		async stream(): Promise<AsyncIterable<never>> {
			throw new Error("never provider stream() is not used by the runtime");
		},
	})) as unknown as ProviderFactory;
	Object.defineProperty(factory, "name", { value: "scripted" });
	Object.defineProperty(factory, "configSlots", { value: CONFIG_SLOTS });
	return factory;
}

function pingTool(): ToolSpec {
	return {
		name: "ping",
		description: "Ping the runtime.",
		args: null,
		async execute() {
			return "pong";
		},
	};
}

// ── harness ─────────────────────────────────────────────────────────────────

interface StartDetails {
	runId: string;
	revision: string;
	threadId: string;
	phase: string;
}

interface ThreadReport {
	threadId: string;
	agentId: string;
	parentId: string | null;
	phase: string;
	reason: string | null;
	children: Array<{ reference: string; status: string }>;
}

interface RunReport {
	runId: string;
	phase: string;
	threads: ThreadReport[];
}

interface StatusDetails {
	runs: RunReport[];
	usage: { calls: number; totalTokens: number; promptTokens: number; completionTokens: number };
}

interface ToolResult<T> {
	content: Array<{ type: string; text: string }>;
	details: T;
	isError?: boolean;
}

interface Harness {
	fakePi: FakePi;
	tool: ToolDefinition;
}

async function tempRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-tool-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** A workflow file under `<root>/examples/`, which is how a bare name resolves. */
async function writeWorkflow(root: string, name: string, spec: unknown): Promise<string> {
	const dir = join(root, "examples");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${name}.json`);
	await writeFile(path, `${JSON.stringify(spec, null, "\t")}\n`, "utf8");
	return path;
}

/**
 * Register the extension against the fake PI and hand back the tool.
 *
 * `deadlineMs`/`providers`/`tools` are the host's own configuration: a workflow
 * file is data, so code arrives through the options — exactly what a PI session
 * supplies from its model registry instead of a script.
 */
async function harness(
	t: TestContext,
	root: string,
	options: Omit<StandardAgentToolOptions, "cwd" | "store"> = {},
): Promise<Harness> {
	const fakePi = createFakePi();
	await extension(fakePi.api, {
		cwd: root,
		// One key per test: no per-user key file is created or read.
		store: { envKey: randomBytes(32).toString("hex") },
		...options,
	});
	const tool = fakePi.tools.find((candidate) => candidate.name === STANDARD_AGENT_TOOL_NAME);
	assert.ok(tool, `the extension registers ${STANDARD_AGENT_TOOL_NAME}`);
	t.after(async () => {
		// Release the run claims the way a PI session's shutdown would.
		for (const handler of fakePi.handlersFor("session_shutdown")) await handler.handler();
	});
	return { fakePi, tool };
}

async function call<T>(h: Harness, params: Record<string, unknown>): Promise<ToolResult<T>> {
	return (await h.tool.execute("call-1", params, undefined, undefined, h.fakePi.ctx)) as unknown as ToolResult<T>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, so a test never depends on a microtask order. */
async function until(
	predicate: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${label}`);
}

function runDirOf(root: string, runId: string): string {
	return join(root, ...RUNS_DIR, runId);
}

function threadDir(runDir: string, threadId: string): string {
	return join(runDir, STORE_DIR, "threads", threadId);
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function journalRows(runDir: string): Promise<Array<Record<string, unknown>>> {
	const raw = await readFile(join(runDir, JOURNAL_FILE), "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every completion wake the recorder saw, by custom type. */
function wakes(fakePi: FakePi): RecordedMessage[] {
	return fakePi.messages.filter(
		(message) => (message.message as { customType?: string }).customType === COMPLETION_CUSTOM_TYPE,
	);
}

/** One agent, one prompt, one model: the smallest workflow that takes a turn. */
function assistantWorkflow(id = "tool-assistant"): {
	id: string;
	models: Array<{ name: string; model: string }>;
	prompts: unknown[];
	agents: unknown[];
	tools?: unknown[];
} {
	return {
		id,
		models: [{ name: "scripted", model: "scripted-1" }],
		prompts: [
			{
				name: "assistant",
				toolDescription: "Answer the user",
				prompt: "You are the assistant. Reply briefly.",
				model: "scripted",
				includeChat: true,
			},
		],
		agents: [{ name: "assistant", sides: { a: { prompt: "assistant" }, b: { human: true } } }],
	};
}

/** A lead that spawns one blocking worker at thread creation (the stop cascade). */
function delegationWorkflow(): {
	id: string;
	models: Array<{ name: string; model: string }>;
	prompts: unknown[];
	agents: unknown[];
} {
	return {
		id: "tool-delegation",
		models: [{ name: "scripted", model: "scripted-1" }],
		prompts: [
			{ name: "lead", toolDescription: "Lead the work", prompt: "You lead.", model: "scripted", includeChat: true },
			{ name: "worker", toolDescription: "Do the work", prompt: "You work.", model: "scripted", includeChat: true },
		],
		agents: [
			{
				name: "lead",
				sides: {
					a: {
						prompt: "lead",
						subagents: [{ agent: "worker", as: "worker", blocking: true, immediate: true }],
					},
					b: { human: true },
				},
			},
			{ name: "worker", sides: { a: { prompt: "worker" }, b: { human: true } } },
		],
	};
}

// ── start ───────────────────────────────────────────────────────────────────

test("start returns while the turn is still on its slow second step", async (t) => {
	const root = await tempRoot(t);
	await writeWorkflow(root, "two-step", {
		...assistantWorkflow(),
		prompts: [
			{
				name: "assistant",
				toolDescription: "Answer the user",
				prompt: "You are the assistant.",
				model: "scripted",
				includeChat: true,
				tools: ["ping"],
			},
		],
		tools: [{ name: "ping", description: "Ping the runtime." }],
	});
	// Step 1 calls `ping` at once; step 2 is the slow one, so the tool call would
	// have to wait 300 ms if `start` ran the turn inline.
	const provider = delayingProvider(
		[{ toolCalls: [{ id: "call_ping", name: "ping", arguments: {} }] }, { content: "done", usage: TOKENS }],
		[0, 300],
	);
	const h = await harness(t, root, { providers: { scripted: provider }, tools: [pingTool()] });

	const began = Date.now();
	const started = await call<StartDetails>(h, { action: "start", workflow: "two-step", task: "go" });
	const elapsed = Date.now() - began;

	assert.equal(started.isError, undefined, started.content[0]?.text);
	assert.ok(elapsed < 100, `execute returned in ${elapsed}ms while the model waits 300ms`);
	assert.equal(started.details.phase, "running", "the record says running before the tool answers");
	assert.ok(started.details.threadId, "the result names the thread to message later");
	assert.match(started.details.revision, /^[0-9a-f]{12}$/);
	assert.ok(started.content[0]?.text.includes(started.details.runId), "the model-facing line names the run");

	// `details.runId` is a real directory, not an id to look up later.
	const runDir = runDirOf(root, started.details.runId);
	assert.equal((await stat(runDir)).isDirectory(), true);

	// The turn kept going: the slow step was taken, and it did finish.
	await until(() => provider.calls >= 2, "the slow second step");
	await until(() => wakes(h.fakePi).length >= 1, "the completion wake");

	const row = (
		await journalRows(runDir)
	).find((candidate) => candidate.kind === "usage_total" || candidate.kind === "model_call");
	assert.ok(row, "the journal measured the calls");
	assert.equal((await call<StatusDetails>(h, { action: "status", runId: started.details.runId })).details.runs[0]?.phase, "idle");
});

// ── status ──────────────────────────────────────────────────────────────────

test("status reports running, then idle, with the tokens the journal measured", async (t) => {
	const root = await tempRoot(t);
	await writeWorkflow(root, "assistant", assistantWorkflow());
	const provider = delayingProvider([{ content: "answered", usage: TOKENS }], [150]);
	const h = await harness(t, root, { providers: { scripted: provider } });

	const started = await call<StartDetails>(h, { action: "start", workflow: "assistant", task: "hello" });
	assert.equal(started.isError, undefined, started.content[0]?.text);

	const live = await call<StatusDetails>(h, { action: "status", runId: started.details.runId });
	assert.equal(live.isError, undefined);
	assert.equal(live.details.runs.length, 1);
	assert.equal(live.details.runs[0]?.phase, "running", "the turn is live while the model answers");
	assert.equal(live.details.runs[0]?.threads[0]?.threadId, started.details.threadId);
	assert.equal(live.details.runs[0]?.threads[0]?.phase, "running");
	assert.equal(live.details.usage.calls, 0, "nothing is measured yet, and zero is not an estimate");

	// The background settle is what ends the run, and it fires the wake.
	await until(() => wakes(h.fakePi).length === 1, "the completion wake");

	const ended = await call<StatusDetails>(h, { action: "status", runId: started.details.runId });
	assert.equal(ended.details.runs[0]?.phase, "idle");
	assert.equal(ended.details.runs[0]?.threads[0]?.phase, "idle");
	assert.equal(ended.details.usage.calls, 1);
	assert.deepEqual(
		{
			promptTokens: ended.details.usage.promptTokens,
			completionTokens: ended.details.usage.completionTokens,
			totalTokens: ended.details.usage.totalTokens,
		},
		TOKENS,
		"the tokens are the journal's, not the runtime's in-memory count",
	);

	// `status` without a run id addresses the runs this session started.
	const all = await call<StatusDetails>(h, { action: "status" });
	assert.deepEqual(
		all.details.runs.map((run) => run.runId),
		[started.details.runId],
	);
});

// ── message and stop ────────────────────────────────────────────────────────

test("message persists a user message on the run's thread and stop terminates parent and child", async (t) => {
	const root = await tempRoot(t);
	await writeWorkflow(root, "delegation", delegationWorkflow());
	const h = await harness(t, root, { providers: { scripted: delayingProvider([{ content: "lead done" }]) } });

	const started = await call<StartDetails>(h, { action: "start", workflow: "delegation", agent: "lead", task: "delegate" });
	assert.equal(started.isError, undefined, started.content[0]?.text);
	await until(() => wakes(h.fakePi).length === 1, "the lead's turn to settle");

	const runDir = runDirOf(root, started.details.runId);
	const view = await call<StatusDetails>(h, { action: "status", runId: started.details.runId });
	const child = view.details.runs[0]?.threads.find((thread) => thread.parentId === started.details.threadId);
	assert.ok(child, "the immediate blocking child exists as a thread of its own");

	const posted = await call<{ queued: boolean }>(h, {
		action: "message",
		runId: started.details.runId,
		threadId: child.threadId,
		text: "hello child",
	});
	assert.equal(posted.isError, undefined, posted.content[0]?.text);
	assert.equal(posted.details.queued, true);
	assert.equal(posted.content[0]?.text, "queued");

	// The queued message is durable: the runtime drains the queue into messages.json.
	await until(async () => {
		const messages = await readJson<Array<{ role: string; content: unknown }>>(
			join(threadDir(runDir, child.threadId), "messages.json"),
		).catch(() => []);
		return messages.some((message) => message.role === "user" && message.content === "hello child");
	}, "the posted message to be persisted");

	const stopped = await call<{ terminated: string[] }>(h, { action: "stop", runId: started.details.runId });
	assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
	assert.deepEqual(stopped.details.terminated, [started.details.threadId], "only root threads are named");

	const parent = await readJson<{ terminated: number | null; children: Array<{ reference: string; status: string }> }>(
		join(threadDir(runDir, started.details.threadId), RECORD_FILE),
	);
	const childRecord = await readJson<{ terminated: number | null; status: { reason: string | null } }>(
		join(threadDir(runDir, child.threadId), RECORD_FILE),
	);
	assert.ok(parent.terminated !== null, "the parent is terminated on disk");
	assert.ok(childRecord.terminated !== null, "the runtime cascaded into the child");
	assert.equal(childRecord.status.reason, "terminated");
	assert.equal(
		parent.children.find((entry) => entry.reference === child.threadId)?.status,
		"terminated",
		"the parent's own entry says the child is gone",
	);
});

// ── deadline ────────────────────────────────────────────────────────────────

test("a deadline records failed/deadline and wakes once, even though the provider never answers", async (t) => {
	const root = await tempRoot(t);
	await writeWorkflow(root, "assistant", assistantWorkflow());
	const h = await harness(t, root, { providers: { scripted: neverProvider() }, deadlineMs: 100 });

	const started = await call<StartDetails>(h, { action: "start", workflow: "assistant", task: "hang" });
	assert.equal(started.isError, undefined, started.content[0]?.text);
	const runDir = runDirOf(root, started.details.runId);

	await until(async () => {
		const rows = await journalRows(runDir).catch(() => []);
		return rows.some((row) => row.kind === "status" && row.status === "failed" && row.detail === "deadline");
	}, "the deadline row in the journal");

	await until(() => wakes(h.fakePi).length === 1, "the completion wake");
	const wake = wakes(h.fakePi)[0]?.message as { customType: string; content: string; details?: { phase?: string } };
	assert.equal(wake.customType, COMPLETION_CUSTOM_TYPE);
	assert.equal(wake.details?.phase, "failed");
	assert.ok(wake.content.includes(started.details.runId), "the wake names the run");

	// The deadline both aborted the turn and ended the run: no second wake.
	await sleep(200);
	assert.equal(wakes(h.fakePi).length, 1, "exactly one completion wake per run");
	assert.deepEqual(
		h.fakePi.messages
			.filter((message) => (message.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true)
			.length,
		1,
		"the wake is what asks PI for a turn",
	);

	const ended = await call<StatusDetails>(h, { action: "status", runId: started.details.runId });
	assert.equal(ended.details.runs[0]?.phase, "terminated", "terminate() is what ended the thread");
});

// ── built-in tools ──────────────────────────────────────────────────────────

test("a workflow that declares 'shell' runs it with no host tools supplied", async (t) => {
	const root = await tempRoot(t);
	await writeWorkflow(root, "declares-shell", {
		...assistantWorkflow(),
		prompts: [
			{
				name: "assistant",
				toolDescription: "Answer the user",
				prompt: "You are the assistant.",
				model: "scripted",
				includeChat: true,
				tools: ["shell"],
			},
		],
		// The declaration is the grant; the implementation comes from the package, so
		// a bare PI session (no `tools` option) can run it.
		tools: [{ name: "shell", description: "Run one command in the working directory." }],
	});
	const provider = delayingProvider([
		{ toolCalls: [{ id: "call_shell", name: "shell", arguments: { command: "echo built-in" } }] },
		{ content: "ran it", usage: TOKENS },
	]);
	const h = await harness(t, root, { providers: { scripted: provider } });

	const started = await call<StartDetails>(h, { action: "start", workflow: "declares-shell", task: "list something" });
	assert.equal(started.isError, undefined, started.content[0]?.text);

	await until(() => wakes(h.fakePi).length === 1, "the completion wake");

	// `echo built-in` is a string only the built-in could have produced: the scripted
	// model never says it, so its presence in the thread is the execution's own mark.
	const messages = await readFile(
		join(threadDir(runDirOf(root, started.details.runId), started.details.threadId), "messages.json"),
		"utf8",
	);
	assert.match(messages, /exit: 0[\s\S]*built-in/, "the declared tool ran, and it was the built-in");
});

test("wait: start blocks until the run ends and answers with the journal total", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "std-agents-wait-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeWorkflow(root, "talks", {
		id: "talks",
		models: [{ name: "scripted", model: "scripted" }],
		prompts: [
			{ name: "main", toolDescription: "Answer the user", prompt: "Answer briefly.", model: "scripted" },
		],
		agents: [{ name: "main", sides: { a: { prompt: "main" }, b: { human: true } } }],
	});
	const h = await harness(t, root, {
		providers: { scripted: scriptedProvider([{ content: "done", usage: TOKENS }]) },
	});

	const result = await call<StartDetails & { usage: { totalTokens: number; calls: number } }>(h, {
		action: "start",
		workflow: "talks",
		task: "say done",
		wait: true,
	});

	assert.equal(result.isError, undefined, result.content[0]?.text);
	// The answer describes the ending, not the opening: an unattended caller has no
	// later turn in which to ask.
	assert.equal(result.details.phase, "idle");
	assert.equal(result.details.usage.totalTokens, TOKENS.totalTokens);
	assert.equal(result.details.usage.calls, 1);
	assert.match(result.content[0]?.text ?? "", /idle: 16 tokens over 1 call\(s\)/);
});

test("a directory package runs its handler, pins its files, and cannot be reopened from spec.json", async (t) => {
	// Inside the repository, so the fixture's `.ts` files resolve `@standardagents/spec`
	// the same way a real package does.
	const root = await mkdtemp(join(process.cwd(), ".tmp-directory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = join(root, "order");
	for (const dir of ["agents", "prompts", "models", "handlers"]) {
		await mkdir(join(pkg, dir), { recursive: true });
	}
	await writeFile(
		join(pkg, "agents", "order.ts"),
		[
			'import { defineAgent } from "@standardagents/spec";',
			"",
			"export default defineAgent({",
			'\tname: "order",',
			'\tdescription: "The order, as code.",',
			'\tsideA: { label: "order", handler: "run_order" },',
			'\tsideB: { human: true },',
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "handlers", "run_order.ts"),
		[
			'import { defineHandler } from "@standardagents/spec";',
			"",
			"export default defineHandler({",
			'\tdescription: "Record a step and end the session.",',
			"\texecute: async (state) => {",
			'\t\tawait state.setValue("order.step", 1);',
			'\t\tawait state.stopSession({ result: "handled by code" });',
			"\t},",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "prompts", "order.ts"),
		[
			'import { definePrompt } from "@standardagents/spec";',
			"",
			"export default definePrompt({",
			'\tname: "order",',
			'\ttoolDescription: "Never called: the order side is a handler.",',
			'\tprompt: "Unused.",',
			'\tmodel: "unused",',
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "models", "unused.ts"),
		[
			'import { defineModel } from "@standardagents/spec";',
			"",
			"export default defineModel({",
			'\tname: "unused",',
			'\tmodel: "unused-model",',
			"\tprovider: () => ({",
			'\t\tname: "unused",',
			'\t\tspecificationVersion: "1",',
			"\t\tasync generate() {",
			'\t\t\tthrow new Error("the order handler makes no model call");',
			"\t\t},",
			"\t\tasync stream() {",
			'\t\t\tthrow new Error("the order handler makes no model call");',
			"\t\t},",
			"\t}),",
			"});",
			"",
		].join("\n"),
		"utf8",
	);

	const h = await harness(t, root);
	const first = await call<StartDetails>(h, { action: "start", workflow: pkg, task: "go", wait: true });
	assert.equal(first.isError, undefined, first.content[0]?.text);
	assert.equal(first.details.phase, "idle");

	// The order ran as code: no model answered, and the session's result is the
	// handler's own words.
	const spec = JSON.parse(await readFile(join(runDirOf(root, first.details.runId), "spec.json"), "utf8")) as {
		spec: { id: string; source: { kind: string; files: { path: string; sha: string }[] } };
	};
	assert.equal(spec.spec.id, "order", "a local package is named by its directory, not its path");
	assert.equal(spec.spec.source.kind, "directory");
	assert.ok(spec.spec.source.files.length >= 4, `every definition file is pinned: ${spec.spec.source.files.length}`);
	for (const file of spec.spec.source.files) assert.match(file.sha, /^[0-9a-f]{12}$/);

	// Same package, same revision, a different run: a revision is what the package
	// *is*, not when it was started.
	const second = await call<StartDetails>(h, { action: "start", workflow: pkg, task: "go again", wait: true });
	assert.notEqual(second.details.runId, first.details.runId);
	assert.equal(second.details.revision, first.details.revision);

	// And the record cannot rebuild it: the handler is not in `spec.json`.
	const service = new RunService({ cwd: root });
	await assert.rejects(
		() => service.open(runDirOf(root, first.details.runId)),
		/reopen it by loading that directory/,
	);
	service.close();
});

test("a package's own provider answers, is measured, and gets its credential from the host", async (t) => {
	// The doctrine path: the package binds its model to a provider it ships, and the
	// consumer supplies the credential. No `providers` option: if the package's own
	// factory did not run, this test could not pass.
	const root = await mkdtemp(join(process.cwd(), ".tmp-vendor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = join(root, "vendor");
	for (const dir of ["agents", "prompts", "models"]) await mkdir(join(pkg, dir), { recursive: true });

	await writeFile(
		join(pkg, "agents", "assistant.ts"),
		[
			'import { defineAgent } from "@standardagents/spec";',
			"",
			"export default defineAgent({",
			'\tname: "assistant",',
			'\tdescription: "Answers with the package\'s own provider.",',
			'\tsideA: { prompt: "assistant", label: "assistant" },',
			"\tsideB: { human: true },",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "prompts", "assistant.ts"),
		[
			'import { definePrompt } from "@standardagents/spec";',
			"",
			"export default definePrompt({",
			'\tname: "assistant",',
			'\ttoolDescription: "Answer once",',
			'\tprompt: "Answer in one sentence.",',
			'\tmodel: "vendor",',
			"\tincludeChat: true,",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	// The key never appears in this file: the factory declares a slot and the host
	// fills it, which is what makes the package portable.
	await writeFile(
		join(pkg, "models", "vendor.ts"),
		[
			'import { defineModel } from "@standardagents/spec";',
			"",
			'const EXPECTED = "host-supplied-key";',
			"",
			"function provider(config) {",
			"\treturn {",
			'\t\tname: "vendor",',
			'\t\tspecificationVersion: "1",',
			"\t\tasync generate() {",
			"\t\t\tif (config?.apiKey !== EXPECTED) {",
			'\t\t\t\tthrow new Error("the host never supplied the credential slot");',
			"\t\t\t}",
			"\t\t\treturn {",
			'\t\t\t\tcontent: "answered by the package\'s provider",',
			"\t\t\t\treasoning: null,",
			'\t\t\t\tfinishReason: "stop",',
			"\t\t\t\tusage: { promptTokens: 31, completionTokens: 11, totalTokens: 42 },",
			"\t\t\t};",
			"\t\t},",
			"\t\tasync stream() {",
			'\t\t\tthrow new Error("not used");',
			"\t\t},",
			"\t};",
			"}",
			'provider.configSlots = { apiKey: { type: "secret", defaultEnv: "STAG_TEST_HOST_KEY" } };',
			"",
			"export default defineModel({",
			'\tname: "vendor",',
			'\tmodel: "vendor-1",',
			"\tprovider,",
			"});",
			"",
		].join("\n"),
		"utf8",
	);

	process.env.STAG_TEST_HOST_KEY = "host-supplied-key";
	t.after(() => {
		delete process.env.STAG_TEST_HOST_KEY;
	});

	const h = await harness(t, root);
	const result = await call<StartDetails & { usage: { totalTokens: number; calls: number } }>(h, {
		action: "start",
		workflow: pkg,
		task: "go",
		wait: true,
	});
	assert.equal(result.isError, undefined, result.content[0]?.text);
	assert.equal(result.details.phase, "idle");
	// The package's factory reported 42 tokens: `withUsage` wrapped it, so the journal
	// measures a provider the package owns, not just one the host injected.
	assert.equal(result.details.usage.totalTokens, 42);
	assert.equal(result.details.usage.calls, 1);

	const runDir = runDirOf(root, result.details.runId);
	const rows = (await readFile(join(runDir, JOURNAL_FILE), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { kind: string; model?: string; usage?: { totalTokens: number } });
	const call0 = rows.find((row) => row.kind === "model_call");
	assert.ok(call0, "the call reached the journal");
	assert.equal(call0?.model, "vendor-1");
	assert.equal(call0?.usage?.totalTokens, 42);

	const messages = await readFile(join(threadDir(runDir, result.details.threadId), "messages.json"), "utf8");
	assert.match(messages, /answered by the package's provider/, "the package's provider produced the answer");
});

test("a host-owned model with no factory anywhere fails by name, not at the first stack trace", async (t) => {
	// The escape path's failure mode: the loader warns and the package loads, so the
	// refusal has to come from the runtime, naming the model and both remedies.
	const root = await mkdtemp(join(process.cwd(), ".tmp-orphan-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = await orphanPackage(root);

	const h = await harness(t, root);
	const result = await call<StartDetails>(h, { action: "start", workflow: pkg, task: "go", wait: true });
	assert.equal(result.isError, undefined, result.content[0]?.text);
	assert.equal(result.details.phase, "failed");
	// The loader's warning is not dropped: the answer says which model nobody can
	// supply, before a turn dies of it.
	assert.match(
		result.content.map((part) => part.text).join("\n"),
		/warning: Model 'nobody' has no provider factory/,
	);
	const rows = await journalRows(runDirOf(root, result.details.runId));
	assert.match(String(rows.find((row) => row.status === "warning")?.detail), /Model 'nobody' has no provider factory/);
	// The refusal lands as a failed row, not a silent idle. No session subscribed
	// here, so this row is the tool's own.
	assert.equal(rows.filter((row) => row.status === "failed").length, 1, "one failed row");
});

test("a subscribed run journals one failed row, not the tool's and the runtime's", async (t) => {
	const root = await mkdtemp(join(process.cwd(), ".tmp-subscribed-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = await orphanPackage(root);

	const h = await harness(t, root);
	// The production shape: the session's subscription is what journals a run's rows.
	for (const handler of h.fakePi.handlersFor("session_start")) await handler.handler();
	const result = await call<StartDetails>(h, { action: "start", workflow: pkg, task: "go", wait: true });
	assert.equal(result.details.phase, "failed");
	const failed = (await journalRows(runDirOf(root, result.details.runId))).filter(
		(row) => row.status === "failed",
	);
	assert.equal(failed.length, 1, "one failed row, not two");
	assert.equal(String(failed[0]?.detail), "step_error", "the runtime's own reason, from its status event");
});

/** A package whose only model is one the host never supplies: the 0.1.3 escape path. */
async function orphanPackage(root: string): Promise<string> {
	const pkg = join(root, "orphan");
	for (const dir of ["agents", "prompts", "models"]) await mkdir(join(pkg, dir), { recursive: true });
	await writeFile(
		join(pkg, "agents", "assistant.ts"),
		[
			'import { defineAgent } from "@standardagents/spec";',
			"",
			"export default defineAgent({",
			'\tname: "assistant",',
			'\tsideA: { prompt: "assistant" },',
			"\tsideB: { human: true },",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "prompts", "assistant.ts"),
		[
			'import { definePrompt } from "@standardagents/spec";',
			"",
			"export default definePrompt({",
			'\tname: "assistant",',
			'\ttoolDescription: "Answer",',
			'\tprompt: "Answer.",',
			'\tmodel: "nobody",',
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(pkg, "models", "nobody.ts"),
		['// The host never supplies this one.', '\texport default { name: "nobody", model: "nobody-1" };', ""].join("\n"),
		"utf8",
	);
	return pkg;
}
