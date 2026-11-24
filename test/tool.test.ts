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
import { JOURNAL_FILE, RECORD_FILE, RUNS_DIR, STORE_DIR } from "../src/runs.ts";
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
