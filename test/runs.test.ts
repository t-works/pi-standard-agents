/**
 * A run is a directory plus one `Runtime`, and this file proves the four jobs
 * the runtime leaves to its host — with no model, no network and temp dirs.
 *
 * The four assertions are the four risks:
 *  - **Restart.** A thread left `running` by a process that is gone has to be
 *    settled (`execution_lost`) before anything starts again, and the claim on
 *    the directory has to move to the new owner.
 *  - **Single writer.** Two runtimes on one store interleave writes to the same
 *    `messages.json`; a second service is refused while the first is alive, and
 *    its refusal writes nothing.
 *  - **Terminate.** A blocking child is killed by the parent's `terminate()`,
 *    because the runtime cascades — observed in the records, not assumed.
 *  - **Revision.** `spec.json` pins a 12-char hash, and a changed spec is a new
 *    run, so opening a different one into a live run directory is refused.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

import type { ToolSpec, WorkflowSpec } from "../src/registry.ts";
import type { OpenRun, OwnerLock, RunThreadView } from "../src/runs.ts";
import { OWNER_LOCK_FILE, RunError, RunService, SPEC_FILE, STORE_DIR } from "../src/runs.ts";
import type { ScriptedReply } from "./scripted.ts";
import { scriptedProvider } from "./scripted.ts";

const CONFIG_SLOTS: ProviderConfigSlots = {
	// The runtime refuses to build a provider it cannot see an API key for. This
	// one talks to nothing, so the slot carries a fake default.
	apiKey: { type: "text", default: "stalling-provider" },
};

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** A scripted provider that stops answering once the script runs out. */
interface StallingProvider extends ProviderFactory {
	readonly calls: number;
}

/**
 * Answer the script, then never answer again.
 *
 * The call after the script is a promise that never settles: a turn nobody can
 * finish. That is what a killed process leaves on disk, and what `terminate()`
 * has to cut short.
 */
function stallingProvider(script: readonly ScriptedReply[]): StallingProvider {
	const inner = scriptedProvider(script);
	let calls = 0;

	const factory = ((config: unknown) => {
		const instance = inner(config as never);
		const wrapped: ProviderInstance = {
			...instance,
			generate(request: ProviderRequest): Promise<ProviderResponse> {
				calls += 1;
				if (calls > script.length) return new Promise<ProviderResponse>(() => {});
				return instance.generate(request);
			},
		};
		return wrapped;
	}) as unknown as StallingProvider;

	Object.defineProperty(factory, "name", { value: "stalling" });
	Object.defineProperty(factory, "configSlots", { value: CONFIG_SLOTS });
	Object.defineProperty(factory, "calls", { get: () => calls });
	return factory;
}

async function tempRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** A store key per test: no user key file is created or read. */
function storeKey(): string {
	return randomBytes(32).toString("hex");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, so a test never depends on a microtask order. */
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${label}`);
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

/** One agent, one prompt, one model — the smallest run that can take a turn. */
function assistantSpec(
	provider: ProviderFactory,
	options: { prompt?: string; tools?: readonly ToolSpec[] } = {},
): WorkflowSpec {
	const toolNames = (options.tools ?? []).map((tool) => tool.name);
	return {
		id: "runs-test",
		models: [{ name: "scripted", model: "scripted-1", provider }],
		prompts: [
			{
				name: "assistant",
				toolDescription: "Answer the user",
				prompt: options.prompt ?? "You are the assistant. Reply briefly.",
				model: "scripted",
				includeChat: true,
				...(toolNames.length ? { tools: toolNames } : {}),
			},
		],
		agents: [{ name: "assistant", sides: { a: { prompt: "assistant" }, b: { human: true } } }],
		...(options.tools ? { tools: options.tools } : {}),
	};
}

/**
 * A lead that spawns one blocking worker at thread creation.
 *
 * `blocking` is what makes the child a subagent in the parent's registry entry,
 * and `immediate` puts it there before any side takes a turn — so the test can
 * start work on the child directly and observe what terminating the parent does
 * to it.
 */
function delegationSpec(provider: ProviderFactory): WorkflowSpec {
	return {
		id: "runs-terminate",
		models: [{ name: "scripted", model: "scripted-1", provider }],
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

function threadOf(status: { threads: RunThreadView[] }, threadId: string): RunThreadView {
	const found = status.threads.find((thread) => thread.threadId === threadId);
	assert.ok(found, `thread ${threadId} is in the run status`);
	return found;
}

test("restart: a turn abandoned mid-flight is recovered as execution_lost and the lock is taken over", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const ping = pingTool();
	// Step 1 answers with a tool call, so there is a step 2; step 2 never answers.
	const provider = stallingProvider([{ toolCalls: [{ id: "call_ping", name: "ping", arguments: {} }] }]);
	const spec = assistantSpec(provider, { tools: [ping] });

	const first = new RunService({ store: { envKey: key } });
	t.after(() => first.close());
	const created = await first.create(spec, { cwd: root });
	assert.equal(created.runId, created.runDir.split(/[\\/]/).pop(), "the run id names the directory");

	// `start` cannot settle — `settle()` waits for every run in the runtime — so
	// the test asks for the turn and stops waiting. U05 owns the deadline.
	const abandoned: Promise<unknown> = first.start(created.runId, { agentId: "assistant", message: "do the thing" });
	abandoned.catch(() => {});
	await until(() => provider.calls >= 2, "the second model call");
	assert.equal((await first.status(created.runId)).threads[0]?.state, "running", "the record says running");

	// Abandon the service object: no close(), no terminate — the process is gone as
	// far as the next opener can tell. `staleLockMs: 0` is that same rule a day
	// later, applied now.
	const second = new RunService({
		store: { envKey: key },
		staleLockMs: 0,
		providers: { scripted: scriptedProvider([{ content: "second process" }]) },
		tools: [ping],
	});
	t.after(() => second.close());

	const reopened = await second.open(created.runDir);
	assert.equal(reopened.tookOverLock, true, "the stale claim was replaced, not honoured");
	assert.ok(reopened.recovered >= 1, "recoverStale settled the thread the dead owner left running");
	assert.equal(reopened.revision, created.revision);

	const recovered = await second.status(created.runId);
	assert.equal(recovered.threads.length, 1);
	assert.equal(recovered.threads[0]?.phase, "failed");
	assert.equal(recovered.threads[0]?.reason, "execution_lost");
	assert.equal(recovered.threads[0]?.state, "failed");
	assert.equal(recovered.phase, "failed");

	// Recovery settles the thread; it does not resurrect it. New work gets a new one.
	const turn = await second.start(created.runId, { agentId: "assistant", message: "carry on" });
	assert.equal(turn.state, "idle");
	assert.equal((await second.status(created.runId)).threads.length, 2, "the new turn runs on a fresh thread");
});

test("single writer: a live run refuses a second service and writes nothing", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const service = new RunService({ store: { envKey: key } });
	t.after(() => service.close());

	const run = await service.create(assistantSpec(scriptedProvider([{ content: "answer" }])), { cwd: root });
	const turn = await service.start(run.runId, { agentId: "assistant", message: "hello" });
	assert.equal(turn.state, "idle");

	const messagesPath = join(run.runDir, STORE_DIR, "threads", turn.threadId, "messages.json");
	const before = (await stat(messagesPath)).mtimeMs;
	// mtime granularity is not guaranteed: leave room for a write to be visible.
	await sleep(30);

	const second = new RunService({ store: { envKey: key } }); // the default stale window
	t.after(() => second.close());
	await assert.rejects(
		second.open(run.runDir),
		(error: unknown) => error instanceof RunError && error.code === "run_locked",
		"a live pid with a young lock is not taken over",
	);

	const after = (await stat(messagesPath)).mtimeMs;
	assert.equal(after, before, "the refused open wrote no messages.json");

	const lock = JSON.parse(await readFile(join(run.runDir, OWNER_LOCK_FILE), "utf8")) as OwnerLock;
	assert.equal(lock.pid, process.pid);
	assert.match(lock.advisory, /^Advisory lock/, "the lock file itself says it is advisory");
	assert.equal((await service.status(run.runId)).open, true);
});

test("a lock whose pid is gone is taken over at once, whatever its age", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const service = new RunService({ store: { envKey: key } });
	t.after(() => service.close());
	const run = await service.create(assistantSpec(scriptedProvider([{ content: "answer" }])), { cwd: root });

	// Default stale window: only the pid rule can let this open through.
	const other = new RunService({ store: { envKey: key }, pidIsAlive: () => false });
	t.after(() => other.close());
	const reopened = await other.open(run.runDir);

	assert.equal(reopened.tookOverLock, true);
	assert.notEqual(reopened.runtime, run.runtime, "a takeover builds its own Runtime");
});

test("terminate: stop ends the blocking child with its parent, and the parent's entry says so", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	// Call 1 is the lead's turn, call 2 is the child's — and call 2 never answers.
	const provider = stallingProvider([{ content: "lead done" }]);
	const service = new RunService({ store: { envKey: key } });
	t.after(() => service.close());

	const run = await service.create(delegationSpec(provider), { cwd: root });
	const lead = await service.start(run.runId, { agentId: "lead", message: "delegate this" });
	assert.equal(lead.state, "idle");

	const started = await service.status(run.runId);
	assert.equal(started.threads.length, 2, "the immediate child exists as a thread of its own");
	const child = started.threads.find((thread) => thread.parentId === lead.threadId);
	assert.ok(child, "the child's record names its parent");
	assert.equal(child.blocking, true, "the relationship is blocking");
	assert.equal(started.threads.map((thread) => thread.phase).join(","), "idle,idle");

	// Live work on the child: a model call that never answers.
	await service.post(run.runId, child.threadId, "start the work");
	await until(
		async () => threadOf(await service.status(run.runId), child.threadId).phase === "running",
		"the child's turn to be running",
	);

	const stopped = await service.stop(run.runId);
	assert.deepEqual(stopped.terminated, [lead.threadId], "only root threads are terminated explicitly");

	const ended = await service.status(run.runId);
	const parentAfter = threadOf(ended, lead.threadId);
	const childAfter = threadOf(ended, child.threadId);
	assert.equal(parentAfter.phase, "terminated");
	assert.equal(childAfter.phase, "terminated", "the runtime cascaded into the blocking child");
	assert.ok(parentAfter.terminatedAt !== null);
	assert.ok(childAfter.terminatedAt !== null);
	assert.equal(childAfter.reason, "terminated");

	const entry = parentAfter.children.find((candidate) => candidate.reference === child.threadId);
	assert.ok(entry, "the parent still lists the child");
	assert.equal(entry.status, "terminated", "the parent's own entry says the child is gone");
	assert.equal(ended.phase, "terminated");
	assert.equal(parentAfter.lastSessionResult, null, "nothing invented: no session result was exported");
});

test("revision: spec.json pins 12 hex chars and a different spec is refused while the run is live", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const service = new RunService({ store: { envKey: key } });
	t.after(() => service.close());

	const run: OpenRun = await service.create(assistantSpec(scriptedProvider([{ content: "answer" }])), { cwd: root });
	const file = JSON.parse(await readFile(join(run.runDir, SPEC_FILE), "utf8")) as {
		revision: string;
		spec: { models: Array<{ name: string; provider?: unknown }> };
	};

	assert.match(file.revision, /^[0-9a-f]{12}$/, "sha256(spec)[0..12]");
	assert.equal(file.revision, run.revision);
	assert.equal(file.spec.models[0]?.name, "scripted");
	assert.equal(file.spec.models[0]?.provider, undefined, "spec.json carries data only, never a provider");

	// Same data, different provider *code*: the same revision, so the run is
	// reopened into the Runtime it was opened with, not a second one.
	const again = await service.open(run.runDir, { spec: assistantSpec(scriptedProvider([])) });
	assert.equal(again.runtime, run.runtime, "a run keeps the runtime it was opened with");

	// Different data: a different run, and this directory is already pinned.
	const changed = assistantSpec(scriptedProvider([{ content: "answer" }]), { prompt: "You are someone else." });
	await assert.rejects(
		service.open(run.runDir, { spec: changed }),
		(error: unknown) => error instanceof RunError && error.code === "revision_mismatch",
	);
	// Identity is checked before ownership: another service is told the same thing.
	await assert.rejects(
		new RunService({ store: { envKey: key } }).open(run.runDir, { spec: changed }),
		(error: unknown) => error instanceof RunError && error.code === "revision_mismatch",
	);

	const same = await service.open(run.runDir, { spec: assistantSpec(scriptedProvider([{ content: "answer" }])) });
	assert.equal(same.runDir, run.runDir);
	assert.equal((await service.status(run.runId)).revision, file.revision);
});
