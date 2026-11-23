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
import { join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProviderFactory } from "@standardagents/spec";
import { unqualify } from "@t-works/standardagents-runtime/loader";
import type { Static } from "typebox";
import { Type } from "typebox";

import type { JournalTotal } from "./journal.ts";
import type { ModelCall } from "./models.ts";
import { piModel, withUsage } from "./models.ts";
import type { ModelSpec, ToolSpec, WorkflowSpec } from "./registry.ts";
import type { RunPhase, RunStatus } from "./runs.ts";
import { JOURNAL_FILE, RunError, RunService, shutdownRunService } from "./runs.ts";

/** Name of the walking-skeleton tool. */
export const PING_TOOL_NAME = "std_smoke";

/** Fixed text the ping tool returns. */
export const PING_RESULT = "pong from pi-standard-agents";

/** Name of the tool that drives the runtime. */
export const STANDARD_AGENT_TOOL_NAME = "standard_agent";

/** `customType` of the completion wake; U06 registers the renderer for it. */
export const COMPLETION_CUSTOM_TYPE = "standard-agent-run";

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
	 * Provider factories by model name, for models a workflow file declares without
	 * one. A workflow file is data — it cannot carry a function — so this is also
	 * how a test supplies a scripted model.
	 */
	providers?: Readonly<Record<string, ProviderFactory>>;
	/** Tool implementations by name, for tools a workflow file only declares. */
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
		Type.String({ description: "Path to a workflow JSON file, or a name/id under examples/." }),
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

	async function start(params: StandardAgentParams, ctx: ToolContext) {
		const cwd = resolve(options.cwd ?? ctx?.cwd ?? process.cwd());
		const path = resolveWorkflowPath(required(params, "workflow"), cwd);
		const loaded = loadWorkflow(path, { tools: options.tools });
		const agent = unqualify(params.agent ?? loaded.spec.agents[0]?.name ?? "");
		if (!agent) {
			throw new ToolError("workflow_invalid", `'${path}' declares no agent and none was named`);
		}
		if (!loaded.spec.agents.some((declared) => unqualify(declared.name) === agent)) {
			throw new ToolError(
				"agent_unknown",
				`Workflow '${loaded.spec.id}' has no agent '${params.agent ?? agent}'`,
			);
		}
		const task = required(params, "task");

		// The journal does not exist until the run does, and the runtime builds each
		// provider on first use — after `create` — so the sink is a slot filled in
		// immediately afterwards. Every model call of this run, nested prompt tools
		// included, then lands in one journal.
		let sink: ((call: ModelCall) => void) | null = null;
		const spec: WorkflowSpec = {
			...loaded.spec,
			models: loaded.spec.models.map((model) => {
				const provider = providerFor(model, ctx);
				if (!provider) return model;
				return { ...model, provider: withUsage(provider, (call) => sink?.(call)) };
			}),
		};

		const runService = serviceFor(cwd);
		const open = await runService.create(spec, { cwd });
		sink = open.journal.modelCallSink();

		const thread = await open.runtime.createThread({ agentId: agent });
		await thread.queueMessage({ role: "user", content: task }, { trigger: false });

		const run: DetachedRun = {
			runId: open.runId,
			runDir: open.runDir,
			revision: open.revision,
			threadId: thread.threadId,
			agent,
			timer: undefined,
			woken: false,
		};
		runs.set(run.runId, run);

		/** The single completion wake of this run. */
		const wake = (phase: RunPhase): void => {
			if (run.woken) return;
			run.woken = true;
			if (run.timer !== undefined) {
				clearTimeout(run.timer);
				run.timer = undefined;
			}
			const usage = journalUsage(run.runDir);
			const cost = usage.cost === null ? "" : ` $${usage.cost.toFixed(4)}`;
			try {
				pi.sendMessage(
					{
						customType: COMPLETION_CUSTOM_TYPE,
						content:
							`standard-agent run ${run.runId} ${phase}: ` +
							`${usage.totalTokens} tokens over ${usage.calls} call(s)${cost}`,
						display: true,
						details: { runId: run.runId, threadId: run.threadId, agent: run.agent, phase, usage },
					},
					{ triggerTurn: true },
				);
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
		return {
			content: [
				text(stopped.terminated.length ? `terminated ${stopped.terminated.join(", ")}` : "no live root thread"),
			],
			details: { terminated: stopped.terminated, runId },
		};
	}

	return {
		name: STANDARD_AGENT_TOOL_NAME,
		label: "Standard Agent",
		description:
			"Start, inspect, message and stop a Standard Agents run. `start` returns immediately with a run id " +
			"and a thread id; the run continues in the background and reports completion as a message.",
		promptSnippet: `${STANDARD_AGENT_TOOL_NAME}: start/inspect/message/stop a Standard Agents run`,
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

	pi.registerTool(pingTool());
	pi.registerTool(createStandardAgentTool(pi, { ...options, service }));

	// Lifecycle wiring. Nothing runs at factory time: `close()` releases a claim
	// only for a run that actually took one, so a reload never leaves an orphan
	// owner.lock behind.
	pi.on("session_start", () => {
		// A run is opened on demand, never at session start.
	});
	pi.on("session_shutdown", () => {
		service.close();
		shutdownRunService();
	});
}
