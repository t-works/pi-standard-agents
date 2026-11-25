/**
 * The PI extension: two tools and the session lifecycle.
 *
 * `standard_agent` is four actions over one harness. It exists because a PI turn
 * must never block on an agent run:
 *
 *  - `start` opens a run (U04), creates the thread and queues the first message,
 *    then hands the turn to the runtime *detached*. The tool answers as soon as
 *    there is a thread id, because a PI turn that waits for a multi-step agent is
 *    a PI turn nobody can interrupt.
 *  - `status` reports what is on disk (the thread records) plus the usage the
 *    journal holds, so "how far did it get and what did it cost" is answerable
 *    from a later turn.
 *  - `message` queues a human message on a thread the run still owns.
 *  - `stop` terminates the root threads and lets the runtime cascade to children.
 *
 * Two host duties the runtime deliberately leaves open live here as well: the
 * wall-clock deadline (the runtime has no cap of its own) and the completion wake
 * (a custom message with `triggerTurn`, exactly once per run — a deadline and a
 * late settle race, and only the first of them may speak).
 *
 * Nothing here runs at import time (README invariant 6): `registerTool` only
 * stores a definition, and the run service behind the tool is built (an empty
 * constructor, no I/O) before any lock is taken or any file written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProviderFactory } from "@standardagents/spec";
import type { Registry } from "@t-works/standardagents-runtime/loader";
import { formatIssues, hasErrors, loadSource, unqualify } from "@t-works/standardagents-runtime/loader";
import type { Static } from "typebox";
import { Type } from "typebox";

import type { EventLine, EventSink, RunReport } from "./events.ts";
import {
	LINE_MESSAGE_TYPE,
	LineLog,
	RUN_MESSAGE_TYPE,
	RunSubscriptions,
	registerStandardAgentCommand,
	runMessageRenderer,
} from "./events.ts";
import type { JournalTotal } from "./journal.ts";
import type { ModelCall } from "./models.ts";
import { piModel, withUsage } from "./models.ts";
import type { ModelSpec, ToolSpec, WorkflowSpec } from "./registry.ts";
import { withBuiltinTools } from "./builtin-tools.ts";
import type { OpenRun, RunPhase, RunStatus } from "./runs.ts";
import { JOURNAL_FILE, RUNS_DIR, RunError, RunService, shutdownRunService } from "./runs.ts";

/** Name of the walking-skeleton tool. */
export const PING_TOOL_NAME = "std_smoke";

/** Fixed text the ping tool returns. */
export const PING_RESULT = "pong from pi-standard-agents";

/** Name of the tool that drives the runtime. */
export const STANDARD_AGENT_TOOL_NAME = "standard_agent";

/**
 * `customType` of the completion wake. The value is `events.ts`'s, so the
 * renderer, the wake and a followed line can never drift apart.
 */
export const COMPLETION_CUSTOM_TYPE = RUN_MESSAGE_TYPE;

/** Where the host's default deadline comes from. Unset means "no horizon". */
export const DEADLINE_ENV = "PI_STANDARD_AGENTS_DEADLINE_MS";

/** Sub-directory a bare `workflow` name is resolved against. */
export const EXAMPLES_DIR = "examples";

/**
 * Why a tool call failed. Closed union: every code is a decision the model can
 * act on (`unknown_run` means "start one"), and the service's own refusals are
 * carried through rather than flattened into one.
 */
export type ToolErrorCode =
	| "invalid_arguments"
	| "workflow_not_found"
	| "workflow_invalid"
	| "unknown_run"
	| "unknown_thread"
	| "run_locked"
	| "revision_mismatch"
	| "run_exists"
	| "agent_unknown"
	| "thread_terminated"
	| "run_from_source"
	| "internal_error";

/** A refusal the tool reports as `isError`, never as a thrown error. */
export class ToolError extends Error {
	readonly code: ToolErrorCode;

	constructor(code: ToolErrorCode, message: string) {
		super(message);
		this.name = "ToolError";
		this.code = code;
	}
}

/** Options for {@link createStandardAgentTool}. Everything a host supplies lives here. */
export interface StandardAgentToolOptions {
	/** Where runs, workflow files and `examples/` live. Defaults to the PI session's cwd. */
	cwd?: string;
	/**
	 * The tool's own name. A host that supplies its own tool set registers it under
	 * its own name, so the package's `/sa` surface and the host's tool coexist.
	 * Defaults to `standard_agent`.
	 */
	name?: string;
	/**
	 * Provider factories by model name, for models a workflow file declares without
	 * one. A workflow file is data — it cannot carry a function — so this is also
	 * how a test supplies a scripted model.
	 */
	providers?: Readonly<Record<string, ProviderFactory>>;
	/** Tool implementations by name, for tools a workflow file only declares. These win
	 * over the built-ins (`builtin-tools.ts`) when both carry a name. */
	tools?: readonly ToolSpec[];
	/**
	 * Wall-clock cap for one run. The default comes from
	 * `PI_STANDARD_AGENTS_DEADLINE_MS`; unset means no horizon at all, which is the
	 * runtime's own position and the honest one for an unattended run.
	 */
	deadlineMs?: number;
	/** Store key material, passed to every run this tool opens. */
	store?: { envKey?: string; keyFile?: string };
	/** The service to open runs with. The extension factory supplies one so it can close it. */
	service?: RunService;
	/**
	 * Where this session keeps the live lines of each run (U06). The factory
	 * supplies one; a wake then carries the last few lines without a second
	 * subscription or a polling timer.
	 */
	lines?: LineLog;
	/**
	 * Called once per run this tool opens, before anything is generated — so a
	 * session subscribes before the first event exists and never misses one.
	 */
	onOpen?: (run: OpenRun) => void;
	/**
	 * Called once a run has spoken to the transcript (its completion wake). From
	 * then on its live lines are visible too: a run already on screen should stay
	 * readable, and a run nobody is watching stays quiet.
	 */
	onScreen?: (runId: string) => void;
}

/** The slice of context every action reads: cwd plus PI's model registry. */
type ToolContext = ExtensionToolContext;

// ── workflow files ──────────────────────────────────────────────────────────

/** A workflow file, plus the path it came from (for error text and logs). */
export interface LoadedWorkflow {
	path: string;
	spec: WorkflowSpec;
}

/** What a workflow file can declare: definitions minus the code JSON cannot hold. */
interface WorkflowFileData {
	id: string;
	agents: WorkflowSpec["agents"];
	prompts: WorkflowSpec["prompts"];
	models: WorkflowSpec["models"];
	tools?: readonly Omit<ToolSpec, "execute">[];
}

function readWorkflowFile(path: string): WorkflowFileData {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new ToolError("workflow_not_found", `No workflow file at '${path}'`);
	}
	let parsed: Partial<WorkflowFileData>;
	try {
		parsed = JSON.parse(raw) as Partial<WorkflowFileData>;
	} catch {
		throw new ToolError("workflow_invalid", `'${path}' is not JSON`);
	}
	if (
		typeof parsed.id !== "string" ||
		!Array.isArray(parsed.agents) ||
		!Array.isArray(parsed.prompts) ||
		!Array.isArray(parsed.models)
	) {
		throw new ToolError(
			"workflow_invalid",
			`'${path}' must carry an id and agents/prompts/models arrays`,
		);
	}
	return parsed as WorkflowFileData;
}

/** What `start` was pointed at: a workflow file, or a directory package. */
type WorkflowSource = { kind: "file"; path: string } | { kind: "directory"; dir: string };

/**
 * A workflow may be a JSON file or a directory package.
 *
 * A directory in the conventional layout is the only form that can carry a
 * handler, and a handler is the only place an order can be code — so this is the
 * difference between running a team and running a conversation with a schema.
 */
function resolveSource(workflow: string, cwd: string): WorkflowSource {
	const root = resolve(cwd);
	for (const candidate of [resolve(root, workflow), join(root, EXAMPLES_DIR, workflow)]) {
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return { kind: "directory", dir: candidate };
	}
	return { kind: "file", path: resolveWorkflowPath(workflow, cwd) };
}

/**
 * Resolve a `workflow` argument to a file.
 *
 * Three shapes are accepted, in this order: a path (relative to the session), a
 * name inside `examples/` (`triage.json`, `examples/triage.json`, `triage`), and
 * the spec `id` of one of them — so `start({workflow: "support-triage"})` finds
 * the shipped example whatever its file happens to be called.
 */
export function resolveWorkflowPath(workflow: string, cwd: string): string {
	const root = resolve(cwd);
	const direct = [
		resolve(root, workflow),
		join(root, EXAMPLES_DIR, workflow),
		join(root, EXAMPLES_DIR, `${workflow}.json`),
	];
	for (const candidate of direct) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}

	const examples = join(root, EXAMPLES_DIR);
	let entries: string[] = [];
	try {
		entries = readdirSync(examples).filter((entry) => entry.endsWith(".json"));
	} catch {
		// No examples/ directory: the three shapes above were the whole contract.
	}
	for (const entry of entries) {
		const candidate = join(examples, entry);
		try {
			if (readWorkflowFile(candidate).id === workflow) return candidate;
		} catch {
			// A malformed example is not this lookup's problem.
		}
	}
	throw new ToolError("workflow_not_found", `No workflow '${workflow}' under '${root}' or '${examples}'`);
}

/**
 * Read a workflow file and attach the host's tool implementations.
 *
 * A declared tool with no implementation is dropped rather than faked, so the
 * registry names the missing reference instead of a turn failing halfway through
 * — the same rule `hydrate()` applies when a run is reopened.
 */
export function loadWorkflow(path: string, code: { tools?: readonly ToolSpec[] } = {}): LoadedWorkflow {
	const data = readWorkflowFile(path);
	const tools = (data.tools ?? []).flatMap((declared) => {
		const implementation = code.tools?.find((tool) => tool.name === declared.name);
		return implementation ? [{ ...declared, ...implementation }] : [];
	});
	return {
		path,
		spec: {
			id: data.id,
			agents: data.agents,
			prompts: data.prompts,
			models: data.models,
			...(tools.length ? { tools } : {}),
		},
	};
}

// ── journal and record reads ────────────────────────────────────────────────

const ZERO_USAGE: JournalTotal = {
	calls: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cost: null,
	partial: false,
};

/**
 * Sum a run's `journal.jsonl` the way `Journal.total()` does, from disk.
 *
 * A run opened by another process has no in-memory journal here, so the file is
 * the only honest source. A `usage_total` row is a fallback for a journal closed
 * elsewhere; counting it alongside `model_call` rows would double-count.
 */
export function journalUsage(runDir: string): JournalTotal {
	let raw: string;
	try {
		raw = readFileSync(join(runDir, JOURNAL_FILE), "utf8");
	} catch {
		return { ...ZERO_USAGE };
	}

	const total: JournalTotal = { ...ZERO_USAGE };
	let closed: JournalTotal | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let row: {
			kind?: string;
			usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number } | null;
		};
		try {
			row = JSON.parse(line) as typeof row;
		} catch {
			continue; // A torn last line is skipped, never repaired.
		}
		const usage = (row.usage ?? null) as NonNullable<typeof row.usage> | null;
		if (row.kind === "usage_total") {
			const closedRow = row as unknown as Record<string, unknown>;
			closed = {
				calls: Number(closedRow.calls ?? 0),
				promptTokens: Number(closedRow.promptTokens ?? 0),
				completionTokens: Number(closedRow.completionTokens ?? 0),
				totalTokens: Number(closedRow.totalTokens ?? 0),
				cost: typeof closedRow.cost === "number" ? closedRow.cost : null,
				partial: closedRow.partial === true,
			};
			continue;
		}
		if (row.kind !== "model_call") continue;
		total.calls += 1;
		if (!usage) {
			total.partial = true;
			continue;
		}
		total.promptTokens += usage.promptTokens ?? 0;
		total.completionTokens += usage.completionTokens ?? 0;
		total.totalTokens += usage.totalTokens ?? 0;
		if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
			total.cost = (total.cost ?? 0) + usage.cost;
		}
	}
	return total.calls === 0 && closed ? closed : total;
}

/**
 * Every run on disk, as `/sa` reports it.
 *
 * Read through `status()` (records, revision, phase) plus the journal total, so
 * `/sa` answers with no run open — which is the state an operator is in when a
 * run matters most. A directory that is not a run is skipped, not reported as
 * one: a half-written run is not a run.
 */
export async function listRuns(service: RunService, cwd: string): Promise<RunReport[]> {
	const root = join(resolve(cwd), ...RUNS_DIR);
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return []; // No runs directory yet: nothing has ever run here.
	}
	const reports: RunReport[] = [];
	for (const name of names.sort()) {
		try {
			const view = await service.status(name);
			reports.push({
				runId: view.runId,
				revision: view.revision,
				phase: view.phase,
				threads: view.threads.length,
				usage: journalUsage(view.runDir),
			});
		} catch {
			// Not a run (or no longer readable): `/sa` lists runs, it does not repair them.
		}
	}
	return reports;
}

/** Where a thread stands once the runtime has stopped running it. */
function endedPhase(record: { terminated?: number | null; status?: { state: string } } | null): RunPhase {
	if (!record) return "idle";
	if (record.terminated) return "terminated";
	const state = record.status?.state ?? "idle";
	// A turn that ended leaves `idle`; a `running` record at this point was not
	// rewritten, and reporting it as running would be a lie.
	return state === "running" ? "idle" : (state as RunPhase);
}

// ── the tool ────────────────────────────────────────────────────────────────

/** The deadline in force: the option, then the environment, then none. */
function deadlineFrom(options: StandardAgentToolOptions): number | undefined {
	if (typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs)) {
		return Math.max(0, options.deadlineMs);
	}
	const raw = process.env[DEADLINE_ENV];
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/** One run this tool started, and what it needs to end cleanly. */
interface DetachedRun {
	runId: string;
	runDir: string;
	revision: string;
	threadId: string;
	agent: string;
	/** The deadline timer, cleared by whichever ending comes first. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** True once the completion wake has been sent: exactly once per run. */
	woken: boolean;
	/**
	 * Resolves the run's completion, for a caller that asked to wait. Idempotent:
	 * the settle, the deadline and `stop` may all reach it, and only the first
	 * phase survives.
	 */
	finish: (phase: RunPhase) => void;
}

function required(params: unknown, name: string): string {
	const value = (params as Record<string, unknown> | undefined)?.[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new ToolError("invalid_arguments", `'${name}' is required for this action`);
	}
	return value;
}

function text(value: string) {
	return { type: "text" as const, text: value };
}

/** Map a service refusal onto the code the model is told about. */
function errorCodeFor(error: unknown): ToolErrorCode {
	if (error instanceof ToolError) return error.code;
	if (error instanceof RunError) {
		if (error.code === "run_not_found" || error.code === "run_not_open" || error.code === "run_corrupt") {
			return "unknown_run";
		}
		if (error.code === "thread_not_found") return "unknown_thread";
		// `run_locked`, `revision_mismatch`, `run_exists`, `thread_terminated`,
		// `agent_unknown`: the service's own words are the model's words.
		return error.code;
	}
	return "internal_error";
}

function asResultError(error: unknown, action: string) {
	const code = errorCodeFor(error);
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [text(`${action} failed (${code}): ${message}`)],
		details: { code, message },
		isError: true,
	};
}

const STANDARD_AGENT_PARAMETERS = Type.Object({
	action: Type.Union(
		[Type.Literal("start"), Type.Literal("status"), Type.Literal("message"), Type.Literal("stop")],
		{ description: "What to do with the run." },
	),
	workflow: Type.Optional(
		Type.String({
			description:
				"Path to a workflow JSON file, a directory package in the conventional layout (agents/, prompts/, …), or a name/id under examples/. A directory is the only form that can carry a handler, so the only form that runs an order rather than a conversation.",
		}),
	),
	wait: Type.Optional(
		Type.Boolean({
			description:
				"Block this turn until the run ends, then answer with its phase, tokens and cost. An unattended drain uses it; an interactive turn does not, because a turn that waits cannot be interrupted.",
		}),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent to run. Defaults to the workflow's first agent." }),
	),
	task: Type.Optional(Type.String({ description: "First user message, for `start`." })),
	runId: Type.Optional(Type.String({ description: "Run to report, message or stop." })),
	threadId: Type.Optional(Type.String({ description: "Thread to report or message." })),
	text: Type.Optional(Type.String({ description: "Message text, for `message`." })),
});

type StandardAgentParams = Static<typeof STANDARD_AGENT_PARAMETERS>;

/**
 * Build the `standard_agent` tool.
 *
 * One instance per PI session: it owns one `RunService` and the runs it started,
 * which is what `status` without a `runId` and `stop` address.
 */
export function createStandardAgentTool(
	pi: ExtensionAPI,
	options: StandardAgentToolOptions = {},
): ToolDefinition<typeof STANDARD_AGENT_PARAMETERS> {
	let service: RunService | null = options.service ?? null;
	const runs = new Map<string, DetachedRun>();

	function serviceFor(cwd: string): RunService {
		service ??= new RunService({
			cwd: options.cwd ?? cwd,
			...(options.store === undefined ? {} : { store: options.store }),
		});
		return service;
	}

	/** The provider for one model: the spec's own, the host's, or PI's. */
	function providerFor(model: ModelSpec, ctx: ToolContext): ProviderFactory | undefined {
		if (model.provider) return model.provider;
		const supplied = options.providers?.[model.name];
		if (supplied) return supplied;
		// Last resort: PI owns models and credentials, so a real workflow file with no
		// injected factory still runs on the model the session resolved.
		if (!ctx?.modelRegistry) return undefined;
		return piModel({ modelRegistry: ctx.modelRegistry }, { name: model.name, model: model.model }).provider;
	}

	/**
	 * The package's models, every provider wrapped so its usage lands in the journal.
	 *
	 * Same three sources as the JSON path: the package's own factory, one the host
	 * supplied by name, then PI's registry. Wrapping is unconditional here because a
	 * package's provider is code the run's record cannot see — the journal is the
	 * only place its cost is written down.
	 */
	function modelsWithUsage(
		registry: Registry,
		ctx: ToolContext,
		sinkSlot: () => ((call: ModelCall) => void) | null,
	): Registry["models"] {
		const models = new Map(registry.models);
		for (const [name, definition] of models) {
			const provider =
				definition.provider ??
				options.providers?.[name] ??
				(ctx?.modelRegistry
					? piModel({ modelRegistry: ctx.modelRegistry }, { name, model: definition.model }).provider
					: undefined);
			if (!provider) continue;
			models.set(name, { ...definition, provider: withUsage(provider, (call) => sinkSlot()?.(call)) });
		}
		return models;
	}

	async function start(params: StandardAgentParams, ctx: ToolContext) {
		const cwd = resolve(options.cwd ?? ctx?.cwd ?? process.cwd());
		const source = resolveSource(required(params, "workflow"), cwd);
		const task = required(params, "task");

		// The journal does not exist until the run does, and the runtime builds each
		// provider on first use — after `create` — so the sink is a slot filled in
		// immediately afterwards. Every model call of this run, nested prompt tools
		// included, then lands in one journal.
		let sink: ((call: ModelCall) => void) | null = null;
		const sinkSlot = () => sink;
		const runService = serviceFor(cwd);
		let agent: string;
		let open: OpenRun;

		if (source.kind === "directory") {
			// A package is validated before a run directory exists, so a typo never
			// leaves half a run behind for a later process to recover.
			const loaded = await loadSource(source.dir);
			// A portable package should not have to import a provider: the host owns
			// models and keys. `loadSource` calls a model with no factory an error, so
			// the host's providers are attached first and only the issues that survive
			// that repair are reported — a model nobody can supply still fails, in the
			// loader's own words.
			const models = modelsWithUsage(loaded.registry, ctx, sinkSlot);
			const supplied = new Set(
				[...models]
					.filter(([name, definition]) => definition.provider && !loaded.registry.models.get(name)?.provider)
					.map(([name]) => name),
			);
			const issues = loaded.issues.filter(
				(issue) => !(issue.path && supplied.has(issue.path.replace(/\.provider$/, ""))),
			);
			if (hasErrors(issues)) {
				throw new ToolError("workflow_invalid", formatIssues(issues));
			}
			agent = unqualify(String(params.agent ?? loaded.registry.agents.keys().next().value ?? ""));
			if (!agent) {
				throw new ToolError("workflow_invalid", `'${source.dir}' declares no agent and none was named`);
			}
			if (!loaded.registry.agents.has(agent)) {
				throw new ToolError("agent_unknown", `Package '${loaded.id}' has no agent '${params.agent ?? agent}'`);
			}
			// A local package has no manifest id to inherit, so the loader hands back its
			// path: the basename is what names the run in a log line and in a run id.
			const id = isAbsolute(loaded.id) ? basename(loaded.id) : loaded.id;
			// The package's tools are its own: the built-ins implement declarations a
			// JSON file can only name, and injecting them here would shadow a package
			// that ships a `shell` of its own.
			open = await runService.createFromRegistry({ ...loaded.registry, models }, { id, dir: source.dir, cwd });
		} else {
			// The built-ins are the implementation side of a workflow's tool declarations:
			// a file can name `shell`, only code can run it.
			const loaded = loadWorkflow(source.path, { tools: withBuiltinTools(cwd, options.tools) });
			agent = unqualify(params.agent ?? loaded.spec.agents[0]?.name ?? "");
			if (!agent) {
				throw new ToolError("workflow_invalid", `'${source.path}' declares no agent and none was named`);
			}
			if (!loaded.spec.agents.some((declared) => unqualify(declared.name) === agent)) {
				throw new ToolError(
					"agent_unknown",
					`Workflow '${loaded.spec.id}' has no agent '${params.agent ?? agent}'`,
				);
			}
			const spec: WorkflowSpec = {
				...loaded.spec,
				models: loaded.spec.models.map((model) => {
					const provider = providerFor(model, ctx);
					if (!provider) return model;
					return { ...model, provider: withUsage(provider, (call) => sinkSlot()?.(call)) };
				}),
			};
			open = await runService.create(spec, { cwd });
		}

		sink = open.journal.modelCallSink();
		// Before the first thread, before the first turn: a subscription attached
		// later would miss the events that matter most (the run's opening lines).
		options.onOpen?.(open);

		const thread = await open.runtime.createThread({ agentId: agent });
		await thread.queueMessage({ role: "user", content: task }, { trigger: false });

		// One resolver per run, so a `wait`ed turn learns the same ending the wake
		// reports — and learns it even when `stop` ends the run instead.
		let resolveFinished: (phase: RunPhase) => void = () => {};
		const finished = new Promise<RunPhase>((resolvePhase) => {
			resolveFinished = resolvePhase;
		});

		const run: DetachedRun = {
			runId: open.runId,
			runDir: open.runDir,
			revision: open.revision,
			threadId: thread.threadId,
			agent,
			timer: undefined,
			woken: false,
			finish: (phase) => resolveFinished(phase),
		};
		runs.set(run.runId, run);

		/** The single completion wake of this run. */
		const wake = (phase: RunPhase): void => {
			run.finish(phase);
			if (run.woken) return;
			run.woken = true;
			if (run.timer !== undefined) {
				clearTimeout(run.timer);
				run.timer = undefined;
			}
			const usage = journalUsage(run.runDir);
			const cost = usage.cost === null ? "" : ` $${usage.cost.toFixed(4)}`;
			// The renderer needs the last lines now: a message is plain data, and a
			// timer that refreshed it would be a timer this extension does not want.
			const lines: readonly EventLine[] = options.lines?.recent(run.runId) ?? [];
			try {
				pi.sendMessage(
					{
						customType: COMPLETION_CUSTOM_TYPE,
						content:
							`standard-agent run ${run.runId} ${phase}: ` +
							`${usage.totalTokens} tokens over ${usage.calls} call(s)${cost}`,
						display: true,
						details: {
							runId: run.runId,
							threadId: run.threadId,
							agent: run.agent,
							phase,
							revision: run.revision,
							// Each model call is one turn of the loop: the journal is the count.
							turns: usage.calls,
							usage,
							lines,
						},
					},
					{ triggerTurn: true },
				);
				// The run is in the transcript now, so its lines may be shown from here
				// on. Before this point a line would be a message about nothing.
				options.onScreen?.(run.runId);
			} catch {
				// A host that cannot take the message must not lose the run: the journal
				// and the thread store are the durable answer.
			}
		};

		// Detached on purpose — this is the whole point of the tool. `start()` is
		// called synchronously so the thread record already says `running` when the
		// tool answers.
		const started = open.runtime.start(thread, "a");
		const settled = (async () => {
			await started;
			// `settle()` is global to the runtime, which is why one run owns one
			// `Runtime` (U04): a detached settle never waits for somebody else's work.
			await open.runtime.settle();
		})();
		settled.then(
			() => wake(endedPhase(open.store.load(run.threadId))),
			() => wake("failed"),
		);

		const deadlineMs = deadlineFrom(options);
		if (deadlineMs !== undefined) {
			run.timer = setTimeout(() => {
				run.timer = undefined;
				void (async () => {
					// `failed`/`deadline` is the run's own record: the runtime has no
					// wall-clock cap, so "who ended this" can only come from the host.
					open.journal.append({
						kind: "status",
						at: new Date().toISOString(),
						status: "failed",
						detail: "deadline",
					});
					try {
						// Terminating aborts the execution: a tool that started and never
						// finished stays unfinished in the journal, never synthesised.
						await thread.terminate();
					} catch {
						// Already gone: the deadline still owns the outcome.
					}
					wake("failed");
				})();
			}, deadlineMs);
		}

		// The same four verbs, one of them optionally blocking. A drain is one
		// process per run, and a process that answers and exits kills the run it
		// started, so "wait" is the unattended form of `start`, not a convenience.
		if (params.wait === true) {
			const ended = await finished;
			const usage = journalUsage(run.runDir);
			const cost = usage.cost === null ? "" : ` $${usage.cost.toFixed(4)}`;
			return {
				content: [
					text(
						`${run.runId} ${run.agent} ${ended}: ` +
							`${usage.totalTokens} tokens over ${usage.calls} call(s)${cost}`,
					),
				],
				details: { runId: run.runId, revision: run.revision, threadId: run.threadId, phase: ended, usage },
			};
		}

		const phase: RunPhase = thread.data.status.state === "running" ? "running" : "idle";
		return {
			content: [text(`${run.runId} ${run.agent} ${phase}`)],
			details: { runId: run.runId, revision: run.revision, threadId: run.threadId, phase },
		};
	}

	async function status(params: StandardAgentParams, ctx: ToolContext) {
		const runService = serviceFor(resolve(options.cwd ?? ctx?.cwd ?? process.cwd()));
		const requestedRun = params.runId;
		const requestedThread = params.threadId;
		const known = requestedRun ? [requestedRun] : [...runs.keys()];

		const reported: Array<{ status: RunStatus; threads: RunStatus["threads"] }> = [];
		let matchedThread = false;
		for (const runId of known) {
			const view = await runService.status(runId);
			if (requestedThread === undefined) {
				reported.push({ status: view, threads: view.threads });
				continue;
			}
			const thread = view.threads.find((candidate) => candidate.threadId === requestedThread);
			if (thread) matchedThread = true;
			// A named run is reported either way; a thread filter only narrows it.
			if (thread || requestedRun) reported.push({ status: view, threads: thread ? [thread] : view.threads });
		}
		if (requestedThread !== undefined && !matchedThread && requestedRun === undefined) {
			throw new ToolError(
				"unknown_thread",
				`No thread '${requestedThread}' in the runs this session started`,
			);
		}

		let usage: JournalTotal = { ...ZERO_USAGE };
		for (const entry of reported) {
			const runUsage = journalUsage(entry.status.runDir);
			usage = {
				calls: usage.calls + runUsage.calls,
				promptTokens: usage.promptTokens + runUsage.promptTokens,
				completionTokens: usage.completionTokens + runUsage.completionTokens,
				totalTokens: usage.totalTokens + runUsage.totalTokens,
				cost: runUsage.cost === null ? usage.cost : (usage.cost ?? 0) + runUsage.cost,
				partial: usage.partial || runUsage.partial,
			};
		}

		const lines: string[] = [];
		for (const { status: view, threads } of reported) {
			lines.push(`${view.runId} ${view.phase}`);
			for (const thread of threads) {
				const reason = thread.reason ? ` (${thread.reason})` : "";
				const last = thread.lastSessionResult
					? ` -> ${thread.lastSessionResult.split("\n")[0]?.slice(0, 120)}`
					: "";
				lines.push(`  ${thread.threadId} ${thread.agentId} ${thread.phase}${reason}${last}`);
			}
		}
		lines.push(
			`usage: ${usage.totalTokens} tokens over ${usage.calls} call(s)${usage.partial ? " (partial)" : ""}`,
		);

		return {
			content: lines.map(text),
			details: {
				runs: reported.map(({ status: view, threads }) => ({
					runId: view.runId,
					runDir: view.runDir,
					revision: view.revision,
					phase: view.phase,
					open: view.open,
					threads,
				})),
				usage,
			},
		};
	}

	async function message(params: StandardAgentParams, ctx: ToolContext) {
		const runId = required(params, "runId");
		const threadId = required(params, "threadId");
		const body = required(params, "text");
		// `post()` queues and lets the runtime start the turn: the tool answers
		// before anything is generated, exactly like `start`.
		await serviceFor(resolve(options.cwd ?? ctx?.cwd ?? process.cwd())).post(runId, threadId, body);
		return { content: [text("queued")], details: { queued: true, runId, threadId } };
	}

	async function stop(params: StandardAgentParams, ctx: ToolContext) {
		const runId = required(params, "runId");
		const stopped = await serviceFor(resolve(options.cwd ?? ctx?.cwd ?? process.cwd())).stop(runId);
		const run = runs.get(runId);
		if (run && run.timer !== undefined) {
			clearTimeout(run.timer);
			run.timer = undefined;
		}
		// A turn waiting on this run must not wait for a settle that will never come.
		run?.finish("terminated");
		return {
			content: [
				text(stopped.terminated.length ? `terminated ${stopped.terminated.join(", ")}` : "no live root thread"),
			],
			details: { terminated: stopped.terminated, runId },
		};
	}

	return {
		name: options.name ?? STANDARD_AGENT_TOOL_NAME,
		label: "Standard Agent",
		description:
			"Start, inspect, message and stop a Standard Agents run. `start` returns immediately with a run id " +
			"and a thread id; the run continues in the background and reports completion as a message.",
		promptSnippet: `${options.name ?? STANDARD_AGENT_TOOL_NAME}: start/inspect/message/stop a Standard Agents run`,
		parameters: STANDARD_AGENT_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			try {
				if (action === "start") return await start(params, ctx);
				if (action === "status") return await status(params, ctx);
				if (action === "message") return await message(params, ctx);
				if (action === "stop") return await stop(params, ctx);
				throw new ToolError("invalid_arguments", `Unknown action '${String(action)}'`);
			} catch (error) {
				// Errors are results, never throws: a thrown tool error costs the model
				// the context it needs to recover.
				return asResultError(error, `standard_agent/${String(action)}`);
			}
		},
	};
}

/** The walking-skeleton ping, kept so the extension path stays provable on its own. */
function pingTool(): ToolDefinition {
	return {
		name: PING_TOOL_NAME,
		label: "Standard Agents Ping",
		description:
			"Return a fixed string. Used to verify that the pi-standard-agents extension is loaded and reachable.",
		promptSnippet: `${PING_TOOL_NAME}: verify the pi-standard-agents extension is loaded`,
		parameters: Type.Object({
			note: Type.Optional(
				Type.String({ description: "Free-form note echoed back in the tool details." }),
			),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [text(PING_RESULT)],
				details: { note: (params as { note?: string }).note ?? null },
			};
		},
	};
}

/**
 * PI's extension entry point: a *default factory* (sync or async).
 *
 * The second argument is the host's own configuration and is optional, because
 * PI's `ExtensionFactory` calls this with `pi` alone; tests and embedders pass it.
 */
export default function standardAgentsExtension(
	pi: ExtensionAPI,
	options: StandardAgentToolOptions = {},
): void {
	// An empty constructor: no store, no lock, no file until a run is created.
	const service = new RunService({
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.store === undefined ? {} : { store: options.store }),
	});

	// The session's live view: a bounded ring per run and the runs the user asked
	// to follow. Neither is a setting — a line per tool call in the transcript is
	// noise nobody opted into.
	const lines = options.lines ?? new LineLog();
	const following = new Set<string>();
	let subscriptions: RunSubscriptions | null = null;

	const sink: EventSink = (line) => {
		// Every line is kept, because the completion wake carries the last few of
		// them; only a run the user is watching is also written to the transcript.
		lines.append(line);
		if (!following.has(line.runId)) return;
		try {
			pi.sendMessage(
				{ customType: LINE_MESSAGE_TYPE, content: line.text, display: true, details: line },
				{},
			);
		} catch {
			// A host that cannot take a line is not a reason to stop the run.
		}
	};

	pi.registerTool(pingTool());
	pi.registerTool(
		createStandardAgentTool(pi, {
			...options,
			service,
			lines,
			onOpen: (run) => subscriptions?.attach(run),
			onScreen: (runId) => following.add(runId),
		}),
	);

	// The renderer is registered here, unconditionally: the wake it draws is sent
	// by the tool, and a renderer registered later would miss the first wake.
	pi.registerMessageRenderer(COMPLETION_CUSTOM_TYPE, runMessageRenderer());

	registerStandardAgentCommand(pi, {
		runs: () => listRuns(service, options.cwd ?? process.cwd()),
		stop: (runId) => service.stop(runId),
		follow: (runIds) => {
			for (const runId of runIds) following.add(runId);
		},
	});

	// Lifecycle wiring. Nothing runs at factory time: `close()` releases a claim
	// only for a run that actually took one, so a reload never leaves an orphan
	// owner.lock behind.
	pi.on("session_start", () => {
		// The subscription window opens here and every run this session opens is
		// attached as it opens; a run is never opened at session start.
		subscriptions = new RunSubscriptions(sink);
	});
	pi.on("session_shutdown", () => {
		subscriptions?.close();
		subscriptions = null;
		service.close();
		shutdownRunService();
	});
}
