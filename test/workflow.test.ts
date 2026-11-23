/**
 * A workflow's agent set is editable: add an agent, add a prompt, retire an
 * agent — without invalidating runs that are already in flight.
 *
 * Five assertions, all with a scripted model and temp dirs, and all about the
 * one rule the runtime makes absolute: a `Runtime` keeps the registry it was
 * built with, so an edit is a new revision and therefore a new run directory.
 *
 *  - **Add.** A third agent changes the revision; the new run has it, the run
 *    that is still open does not, and the two runs share no store.
 *  - **Retire.** On an idle workflow the agent leaves the new registry while the
 *    old run keeps its `spec.json` and its readable `messages.json`.
 *  - **Busy.** Retiring an agent with a live thread is refused with
 *    `agent_busy`, the run id, and no new run directory.
 *  - **Library.** An `include` of a library prompt renders both texts into one
 *    system message; an `include` of an unknown name fails validation with the
 *    path of the offending part.
 *  - **Canonical.** Two edits with the same content produce the same revision,
 *    whatever order their keys are in.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { ProviderConfigSlots, ProviderFactory } from "@standardagents/spec";

import type { AgentSpec, WorkflowSpec } from "../src/registry.ts";
import { buildRegistry, RegistryBuildError } from "../src/registry.ts";
import { RunService, SPEC_FILE, STORE_DIR, revisionOf } from "../src/runs.ts";
import {
	addAgent,
	listWorkflowRuns,
	openOrContinue,
	readLibrary,
	removeAgent,
	validateEdit,
	withLibrary,
	WorkflowError,
} from "../src/workflow.ts";
import { scriptedProvider } from "./scripted.ts";

/** The shipped prompt library: prompts that are never agents. */
const LIBRARY_DIR = fileURLToPath(new URL("../examples/library", import.meta.url));

async function tempRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-workflow-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** One store key per test, so no per-user key file is created or read. */
function storeKey(): string {
	return randomBytes(32).toString("hex");
}

/** A service whose runs live under one temp dir. */
function serviceFor(t: TestContext, cwd: string): RunService {
	const service = new RunService({ cwd, store: { envKey: storeKey() } });
	t.after(() => service.close());
	return service;
}

/**
 * A provider whose first model call never answers, so a thread stays `running`
 * on disk — the only way to have a genuinely live thread without a second
 * process.
 */
function stallingProvider(): ProviderFactory {
	const inner = scriptedProvider([]);
	const factory = ((config: unknown) => {
		const instance = inner(config as never);
		return { ...instance, generate: () => new Promise<never>(() => {}) };
	}) as unknown as ProviderFactory;
	Object.defineProperty(factory, "name", { value: "stalling" });
	Object.defineProperty(factory, "configSlots", {
		value: (inner as unknown as { configSlots: ProviderConfigSlots }).configSlots,
	});
	return factory;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, so the test never depends on a microtask order. */
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${label}`);
}

/**
 * Two agent-backed prompts, one shared prompt, and a library include in the
 * prompt at `prompts[1]` — the index the include-path assertion names.
 */
function baseSpec(provider: ProviderFactory = scriptedProvider([{ content: "scripted reply" }])): WorkflowSpec {
	return {
		id: "workflow-test",
		models: [{ name: "scripted", model: "scripted-1", provider }],
		// The shipped library: prompts that are never agents, composed by name.
		library: readLibrary(LIBRARY_DIR),
		prompts: [
			{ name: "shared_system", prompt: "Shared rules: be brief.\n", model: "scripted" },
			{
				name: "triage",
				toolDescription: "Triage a request",
				prompt: [
					{ type: "text", content: "You triage incoming requests.\n" },
					// [1] is the library include: the position the error path names.
					{ type: "include", prompt: "team_rules" },
					{ type: "include", prompt: "shared_system" },
				],
				model: "scripted",
				includeChat: true,
			},
			{
				name: "billing",
				toolDescription: "Answer billing questions",
				prompt: "You answer billing questions.\n",
				model: "scripted",
				includeChat: true,
			},
		],
		agents: [
			{ name: "triage", sides: { a: { prompt: "triage" }, b: { human: true } } },
			{ name: "billing", sides: { a: { prompt: "billing" }, b: { human: true } } },
		],
	};
}

/** The agent whose addition is the edit under test. */
function auditorAgent(): AgentSpec {
	return {
		name: "auditor",
		title: "Auditor",
		description: "Checks a transcript against policy",
		sides: { a: { prompt: "shared_system" }, b: { human: true } },
	};
}

/** The same value with every object's keys in the opposite order. */
function reorder<T>(value: T): T {
	if (Array.isArray(value)) return value.map(reorder) as T;
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort().reverse()) {
		out[key] = reorder((value as Record<string, unknown>)[key]);
	}
	return out as T;
}

/** A run's pinned `spec.json`, read as a file: nothing here opens the run. */
async function pinnedSpec(runDir: string): Promise<{ revision: string; spec: { agents: AgentSpec[] } }> {
	return JSON.parse(readFileSync(join(runDir, SPEC_FILE), "utf8")) as {
		revision: string;
		spec: { agents: AgentSpec[] };
	};
}

function agentNames(spec: { agents: readonly AgentSpec[] }): string[] {
	return spec.agents.map((agent) => agent.name);
}

test("add: a third agent is a new revision and a new run; the open run keeps its registry", async (t) => {
	const root = await tempRoot(t);
	const service = serviceFor(t, root);
	const spec = baseSpec();

	const first = await openOrContinue({ spec, cwd: root, service });
	assert.equal(first.action, "created");
	assert.equal(first.previous, null, "the first run supersedes nothing");
	const turn = await service.start(first.run.runId, { agentId: "triage", message: "a request" });
	assert.equal(turn.state, "idle");

	const edited = addAgent(spec, auditorAgent());
	assert.notEqual(revisionOf(edited), first.revision, "an added agent changes the revision");

	const second = await openOrContinue({ spec: edited, cwd: root, service });
	assert.equal(second.action, "revised");
	assert.equal(second.revision, revisionOf(edited));
	assert.equal(second.previous?.runId, first.run.runId, "the run the edit supersedes is named");
	assert.notEqual(second.run.runDir, first.run.runDir, "a changed spec is a new run directory");

	// Two registries: the new run has the third agent, the still-open run does not.
	assert.equal(second.run.registry.agents.has("auditor"), true);
	assert.equal(first.run.registry.agents.has("auditor"), false, "a Runtime keeps the registry it was built with");

	// One store per run: the two runs never share messages.json.
	assert.notEqual(second.run.store, first.run.store);
	assert.notEqual(second.run.store.root, first.run.store.root);

	// The old run is not broken by the edit: its runtime still runs, at its own revision.
	const still = await service.start(first.run.runId, { agentId: "billing", message: "still here?" });
	assert.equal(still.state, "idle");
	assert.equal((await service.status(first.run.runId)).revision, first.revision);
	assert.equal((await service.status(second.run.runId)).revision, second.revision);
	await assert.rejects(
		() => service.start(first.run.runId, { agentId: "auditor", message: "no" }),
		(error: unknown) => (error as { code?: string }).code === "agent_unknown",
		"the old run's registry has no such agent",
	);
});

test("retire: an idle workflow drops the agent, and the old run stays readable", async (t) => {
	const root = await tempRoot(t);
	const service = serviceFor(t, root);
	const spec = baseSpec();

	const first = await openOrContinue({ spec, cwd: root, service });
	const turn = await service.start(first.run.runId, { agentId: "billing", message: "what does it cost?" });
	assert.equal(turn.state, "idle");
	const messagesPath = join(first.run.runDir, STORE_DIR, "threads", turn.threadId, "messages.json");

	const removal = removeAgent(spec, "billing");
	assert.ok(removal.retired, "the agent was there to retire");
	assert.equal(removal.retired.name, "billing");
	assert.deepEqual(agentNames(removal.spec), ["triage"]);
	assert.deepEqual(removal.retired.unreferencedPrompts, ["billing"], "the prompt it used is now dead weight");
	assert.deepEqual(removal.retired.removedEdges, [], "nothing pointed at it");
	assert.deepEqual(validateEdit(removal.spec), [], "an edit is validated by the code that will run it");

	// The pure edit is the diff an operator reviews; `retire` is what the run open
	// enforces, so the spec handed over is still the one that has the agent.
	const second = await openOrContinue({ spec, cwd: root, service, retire: "billing" });
	assert.equal(second.action, "revised");
	assert.equal(second.revision, revisionOf(removal.spec), "the run is pinned to the edited spec");
	assert.deepEqual(second.retired.map((retired) => retired.name), ["billing"]);
	assert.equal(second.run.registry.agents.has("billing"), false, "the new registry has no such agent");
	assert.equal(second.run.registry.agents.has("triage"), true);

	// History is still readable: reads go through the old run's own pinned spec.
	const pinned = await pinnedSpec(first.run.runDir);
	assert.equal(pinned.revision, first.revision);
	assert.deepEqual(agentNames(pinned.spec), ["triage", "billing"], "the old spec.json still names the agent");
	const persisted = JSON.parse(readFileSync(messagesPath, "utf8")) as { content?: unknown }[];
	assert.ok(
		persisted.some((message) => message.content === "what does it cost?"),
		"the old run's messages.json is still readable",
	);
	const old = await service.status(first.run.runId);
	assert.equal(old.threads.length, 1);
	assert.equal(old.threads[0]?.agentId, "billing", "and still names the retired agent's thread");
});

test("busy: retiring an agent with a live thread is refused with agent_busy and writes no run", async (t) => {
	const root = await tempRoot(t);
	const service = serviceFor(t, root);
	const spec = baseSpec(stallingProvider());

	const first = await openOrContinue({ spec, cwd: root, service });
	// `start` cannot settle — the model call never answers — so the test asks for
	// the turn and stops waiting. U05 owns the deadline; this test owns the record.
	const abandoned: Promise<unknown> = service.start(first.run.runId, {
		agentId: "billing",
		message: "a turn that never ends",
	});
	abandoned.catch(() => {});
	await until(
		async () => (await service.status(first.run.runId)).threads[0]?.phase === "running",
		"the thread to be running",
	);

	const runsDir = join(root, ".pi", "standard-agents", "runs");
	const runsDirBefore = readdirSync(runsDir).length;
	const specBefore = readFileSync(join(first.run.runDir, SPEC_FILE), "utf8");

	await assert.rejects(
		() => openOrContinue({ spec, cwd: root, service, retire: "billing" }),
		(error: unknown) =>
			error instanceof WorkflowError &&
			error.code === "agent_busy" &&
			error.runIds.length === 1 &&
			error.runIds[0] === first.run.runId &&
			error.agents.includes("billing"),
	);

	assert.equal(readdirSync(runsDir).length, runsDirBefore, "no new run directory was written");
	assert.equal(
		readFileSync(join(first.run.runDir, SPEC_FILE), "utf8"),
		specBefore,
		"the live run's pinned spec is untouched",
	);
	assert.equal((await listWorkflowRuns(spec.id, { cwd: root, service })).length, 1);
});

test("library: an include renders both texts in one system message, and a dangling one is a path", async (t) => {
	const root = await tempRoot(t);
	const service = serviceFor(t, root);
	const provider = scriptedProvider([{ content: "noted" }]);
	const library = readLibrary(LIBRARY_DIR);
	assert.deepEqual(
		library.map((prompt) => prompt.name),
		["answer_style", "team_rules"],
		"the library is read in name order, so a revision never depends on readdir",
	);

	const spec = baseSpec(provider);
	const open = await openOrContinue({ spec, cwd: root, service });
	const turn = await service.start(open.run.runId, { agentId: "triage", message: "where is my invoice?" });
	assert.equal(turn.state, "idle");

	// The model saw one system message carrying both the workflow prompt's text
	// and the library prompt's text: that is composition, not an import.
	const request = provider.requests[0];
	assert.ok(request, "the scripted provider was called");
	const system = request.messages.filter((message) => message.role === "system");
	assert.equal(system.length, 1, "both prompts render into one system message");
	const systemText = String(system[0]?.content);
	assert.match(systemText, /You triage incoming requests\./);
	assert.match(systemText, /You are part of one team\./, "the library prompt's text is in the same message");
	assert.match(systemText, /Shared rules: be brief\./, "and so is the workflow's own shared prompt");
	assert.equal(open.run.registry.agents.has("team_rules"), false, "a library prompt is never an agent");

	// `{{context.x}}` / `{{arguments.x}}` are interpolated inside library text too.
	const threaded = withLibrary(spec, [
		...library,
		{ name: "audience_rule", prompt: "Write for {{context.audience}} about {{arguments.topic}}." },
	]);
	const { registry } = buildRegistry(threaded);
	const thread = await open.run.runtime.createThread({ agentId: "triage", arguments: { topic: "invoices" } });
	thread.context = { audience: "billing" };
	const rendered = await open.run.runtime.renderPrompt(thread, registry.prompts.get("audience_rule")!, new Set());
	assert.equal(rendered, "Write for billing about invoices.");

	// An unknown include is an error, and the path names the offending part.
	const broken = withLibrary(
		{
			...spec,
			prompts: spec.prompts.map((prompt) =>
				prompt.name === "triage"
					? { ...prompt, prompt: [{ type: "text", content: "You triage.\n" }, { type: "include", prompt: "no_such_prompt" }] }
					: prompt,
			),
		},
		library,
	);
	const issues = validateEdit(broken);
	assert.equal(issues.length, 1, "one issue, once");
	assert.equal(issues[0]?.path, "prompts.1.prompt[1].prompt");
	assert.equal(issues[0]?.severity, "error");
	assert.match(issues[0]?.message ?? "", /no_such_prompt/);
	assert.throws(
		() => buildRegistry(broken),
		(error: unknown) => error instanceof RegistryBuildError && /prompts\.1\.prompt\[1\]\.prompt/.test(error.message),
		"a spec that cannot compose never produces a runnable registry",
	);
});

test("canonical: two edits with the same content produce the same revision", () => {
	const spec = baseSpec();
	const edited = addAgent(spec, auditorAgent());
	const revision = revisionOf(edited);

	assert.match(revision, /^[0-9a-f]{12}$/, "sha256(canonical(spec))[0..12]");
	assert.equal(revisionOf(reorder(edited)), revision, "key order cannot churn the revision");
	assert.equal(revisionOf({ ...edited }), revision, "nor can a spread that copies the same data");

	// A real edit is a different revision, and undoing it restores the old one.
	assert.notEqual(revisionOf(addAgent(spec, { ...auditorAgent(), title: "Different" })), revision);
	assert.notEqual(revision, revisionOf(spec));
	assert.equal(revisionOf(removeAgent(edited, "auditor").spec), revisionOf(spec), "the edit is reversible");
});
