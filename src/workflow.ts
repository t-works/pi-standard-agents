/**
 * Editing a workflow's agent set — add an agent, add a prompt, retire an agent —
 * without invalidating runs that are already in flight.
 *
 * The constraint is the runtime's, and it is absolute: a `Runtime` keeps the
 * `Registry` it was constructed with, and `Thread.agent` throws
 * `Unknown agent '<id>'` for an agent that is not in it. So an edit is never
 * applied to a live `Runtime`; it produces a **new revision** (`sha256(canonical
 * (spec))[0..12]`, U04) and therefore a new run directory with its own registry
 * and its own store. A run that is already open keeps the one it was built with,
 * which is why `messages.json` of an old run stays readable: reads go through
 * that run's own pinned `spec.json`, never through the current spec.
 *
 * Everything in the edit half of this file is a pure function
 * `(spec, input) => spec`: no I/O, no clock, no `Date.now()`. That is what makes
 * an edit reviewable as a diff, and what makes two edits with the same content
 * produce the same revision (see `canonicalJson` in `runs.ts`: keys are sorted,
 * so key order cannot churn the hash).
 *
 * "Remove" is a decision about *threads*, not about a file. An agent with a
 * thread that is still running must not vanish from under it, so
 * `openOrContinue({retire})` refuses with `agent_busy` and names the run ids;
 * otherwise the agent is dropped from the *new* registry while every old run
 * keeps the `spec.json` that still names it.
 *
 * One risk worth stating where it is decided: `agent_busy` is judged from the
 * store, which only knows `running` (and `execution_lost` after recovery). A host
 * that crashed without recovering leaves a thread looking busy forever, so the
 * check opens each run first — `store.recoverStale()` runs at open — and only
 * then reads the records. A run another process owns cannot be opened, and its
 * `running` records are believed, which errs on the side of refusing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { DefinitionIssue } from "@standardagents/spec";
import { unqualify } from "@t-works/standardagents-runtime/loader";

import type {
	AgentSpec,
	BuildRegistryOptions,
	LibraryPromptSpec,
	PromptSpec,
	SideSpec,
	WorkflowSpec,
} from "./registry.ts";
import { buildRegistry } from "./registry.ts";
import type { OpenRun, RunPhase, RunService } from "./runs.ts";
import { RUNS_DIR, SPEC_FILE, revisionOf, runService } from "./runs.ts";

/** Where a host's prompt library lives, below the working directory. */
export const LIBRARY_DIR = ["examples", "library"] as const;

/** Why an edit was refused. Closed union: a new reason is a new decision. */
export type WorkflowErrorCode = "agent_busy" | "agent_unknown" | "library_invalid";

/** Thrown for every refusal that is a rule rather than a bug. */
export class WorkflowError extends Error {
	readonly code: WorkflowErrorCode;
	/** Runs that blocked the edit; empty unless `code` is `agent_busy`. */
	readonly runIds: readonly string[];
	/** Agents the refusal is about. */
	readonly agents: readonly string[];

	constructor(
		code: WorkflowErrorCode,
		message: string,
		options: { runIds?: readonly string[]; agents?: readonly string[]; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WorkflowError";
		this.code = code;
		this.runIds = options.runIds ?? [];
		this.agents = options.agents ?? [];
	}
}

// ── pure edits ──────────────────────────────────────────────────────────────

/**
 * Add one agent. The new spec is a new revision, so it is a new run.
 *
 * Pure and append-only: the diff of two specs is exactly the added agent, and a
 * spec that already had it (by name) is reported by {@link validateEdit} rather
 * than silently deduplicated.
 */
export function addAgent(spec: WorkflowSpec, agent: AgentSpec): WorkflowSpec {
	return { ...spec, agents: [...spec.agents, agent] };
}

/**
 * Add one workflow prompt — the prompt, model and tools an agent's side points
 * at. A prompt that exists to be `include`d belongs in the library instead; see
 * {@link withLibrary}.
 */
export function addPrompt(spec: WorkflowSpec, prompt: PromptSpec): WorkflowSpec {
	return { ...spec, prompts: [...spec.prompts, prompt] };
}

/**
 * Replace the workflow's prompt library.
 *
 * Library prompts are data: `buildRegistry` registers them, so an
 * `{type: "include", prompt: "<name>"}` in a workflow prompt resolves and the
 * two texts render into one system message. They are never agents and never
 * called, so they need no model of their own.
 */
export function withLibrary(spec: WorkflowSpec, library: readonly LibraryPromptSpec[]): WorkflowSpec {
	return { ...spec, library };
}

/** One subagent relationship that was removed because its target was retired. */
export interface RemovedEdge {
	/** Agent that owned the relationship. */
	owner: string;
	side: "a" | "b";
	/** The relationship name (`as`), or the retired agent's name when none was declared. */
	as: string;
}

/** One prompt `tools` entry that was removed because it named the retired agent. */
export interface RemovedToolRef {
	prompt: string;
	tool: string;
}

/** What retiring an agent changed, besides dropping the agent itself. */
export interface RetiredAgent {
	name: string;
	/**
	 * Prompts that only this agent's sides referenced and that nothing references
	 * any more. They stay in the spec — a prompt is data and costs nothing — but
	 * naming them is how an operator sees that a prompt is now dead weight.
	 */
	unreferencedPrompts: readonly string[];
	/** Subagent relationships that pointed at the agent; a dangling edge cannot survive the edit. */
	removedEdges: readonly RemovedEdge[];
	/** Prompt `tools` entries that named the agent, so `validateRegistry` stays clean. */
	removedToolRefs: readonly RemovedToolRef[];
}

/** What {@link removeAgent} produced. */
export interface RemoveAgentResult {
	/** The spec without the agent (and without the references that would dangle). */
	spec: WorkflowSpec;
	/** What was retired, or `null` when the spec has no such agent. */
	retired: RetiredAgent | null;
}

function promptsOfSide(side: SideSpec | undefined): string[] {
	return side?.prompt === undefined ? [] : [unqualify(side.prompt)];
}

function stripSide(side: SideSpec, owner: string, key: "a" | "b", target: string, removed: RemovedEdge[]): SideSpec {
	const relationships = side.subagents ?? [];
	const kept = relationships.filter((relationship) => {
		if (unqualify(relationship.agent) !== target) return true;
		removed.push({ owner, side: key, as: relationship.as ?? unqualify(relationship.agent) });
		return false;
	});
	if (kept.length === relationships.length) return side;
	// An empty `subagents` array would be noise in every later diff; dropping the
	// key says "this side has no relationships" exactly once.
	const { subagents: _dropped, ...rest } = side;
	return kept.length ? { ...rest, subagents: kept } : rest;
}

/**
 * Drop one agent from a spec: the agent, the edges that pointed at it, and the
 * prompt `tools` entries that named it.
 *
 * Pure, so the caller sees the whole edit before anything is opened, and so a
 * refused edit (an agent with a live thread, see {@link openOrContinue}) leaves
 * the spec it was given untouched. The prompts the agent used are *not* deleted:
 * a prompt is reusable data, and deleting one would make an old run's include
 * unrenderable, which is the same trap as deleting definition files under the
 * runtime.
 */
export function removeAgent(spec: WorkflowSpec, name: string): RemoveAgentResult {
	const target = unqualify(name);
	const index = spec.agents.findIndex((agent) => unqualify(agent.name) === target);
	if (index === -1) return { spec, retired: null };

	const retiring = spec.agents[index] as AgentSpec;
	const agents = spec.agents.filter((_, position) => position !== index);

	const removedEdges: RemovedEdge[] = [];
	const rewritten = agents.map((agent) => ({
		...agent,
		sides: {
			a: stripSide(agent.sides.a, agent.name, "a", target, removedEdges),
			b: stripSide(agent.sides.b, agent.name, "b", target, removedEdges),
		},
	}));

	const removedToolRefs: RemovedToolRef[] = [];
	const rewriteTools = (toolNames: readonly string[] | undefined, owner: string): readonly string[] | undefined => {
		if (!toolNames) return undefined;
		const kept = toolNames.filter((tool) => {
			if (unqualify(tool) !== target) return true;
			removedToolRefs.push({ prompt: owner, tool });
			return false;
		});
		return kept.length === toolNames.length ? toolNames : kept;
	};
	const prompts = spec.prompts.map((prompt) => {
		const tools = rewriteTools(prompt.tools, prompt.name);
		return tools === undefined || tools === prompt.tools ? prompt : { ...prompt, tools };
	});

	// Which prompts the retired agent used and nothing else does any more.
	const usedByRetiring = new Set([
		...promptsOfSide(retiring.sides.a),
		...promptsOfSide(retiring.sides.b),
	]);
	for (const agent of rewritten) {
		for (const prompt of [...promptsOfSide(agent.sides.a), ...promptsOfSide(agent.sides.b)]) {
			usedByRetiring.delete(prompt);
		}
	}

	return {
		spec: { ...spec, agents: rewritten, prompts },
		retired: {
			name: unqualify(retiring.name),
			unreferencedPrompts: [...usedByRetiring].sort(),
			removedEdges,
			removedToolRefs,
		},
	};
}

/**
 * Validate a spec the way `buildRegistry` will when a run is opened.
 *
 * The same single pass as U02 — duplicate names, dangling agent edge, dangling
 * `include`, a side with neither prompt/handler/human, a duplicate tool name,
 * a model with no provider — so an edit is checked by the code that will run it
 * rather than by a second, weaker set of rules.
 *
 * A spec whose models carry no provider *code* (a file, or a diff under review)
 * reports those models; pass `providers` if you want that quiet.
 */
export function validateEdit(spec: WorkflowSpec, options: BuildRegistryOptions = {}): DefinitionIssue[] {
	return buildRegistry(spec, { ...options, strict: false }).issues;
}

// ── the prompt library ──────────────────────────────────────────────────────

/**
 * Read `examples/library/*.json` into library prompts.
 *
 * One prompt per file, named by its `name` field, not by the file name — so a
 * library can be reorganised without changing a single `include`. Files are read
 * in name order so the resulting spec (and its revision) does not depend on the
 * order a directory happens to list.
 *
 * A file that is not a prompt is refused here rather than at run open: this is
 * the one place that knows which file it failed on.
 */
export function readLibrary(dir: string): LibraryPromptSpec[] {
	const root = resolve(dir);
	let entries: string[];
	try {
		entries = readdirSync(root).filter((entry) => entry.endsWith(".json")).sort();
	} catch (error) {
		throw new WorkflowError("library_invalid", `No prompt library at '${root}'`, { cause: error });
	}
	const prompts: LibraryPromptSpec[] = [];
	for (const entry of entries) {
		const path = join(root, entry);
		let parsed: Partial<LibraryPromptSpec>;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LibraryPromptSpec>;
		} catch (error) {
			throw new WorkflowError("library_invalid", `'${path}' is not JSON`, { cause: error });
		}
		if (typeof parsed.name !== "string" || !parsed.name) {
			throw new WorkflowError("library_invalid", `'${path}' declares no prompt name`);
		}
		if (parsed.prompt === undefined) {
			throw new WorkflowError("library_invalid", `Library prompt '${parsed.name}' in '${path}' has no 'prompt'`);
		}
		prompts.push(parsed as LibraryPromptSpec);
	}
	return prompts;
}

// ── runs: which one does this revision belong to ────────────────────────────

/** One run directory as `spec.json` describes it, without opening it. */
export interface PinnedRun {
	runId: string;
	runDir: string;
	/** The revision the run was created with. */
	revision: string;
	createdAt: string;
	workflowId: string;
}

/** `spec.json` as this file needs it: it is read here, never written. */
interface PinnedRunFile {
	runId?: unknown;
	revision?: unknown;
	createdAt?: unknown;
	spec?: { id?: unknown };
}

function runsRoot(cwd: string): string {
	return join(resolve(cwd), ...RUNS_DIR);
}

/**
 * Every run directory under `cwd`, newest first, read from `spec.json` alone.
 *
 * The directory name is not trusted to be the run id (`spec.json` carries it), and
 * a directory without a readable `spec.json` is skipped: it is not a run this
 * workflow can reason about.
 */
export function pinnedRuns(cwd: string): PinnedRun[] {
	const root = runsRoot(cwd);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const runs: PinnedRun[] = [];
	for (const entry of entries) {
		const runDir = join(root, entry);
		let parsed: PinnedRunFile;
		try {
			parsed = JSON.parse(readFileSync(join(runDir, SPEC_FILE), "utf8")) as PinnedRunFile;
		} catch {
			continue;
		}
		if (typeof parsed.runId !== "string" || typeof parsed.revision !== "string") continue;
		if (typeof parsed.spec?.id !== "string") continue;
		runs.push({
			runId: parsed.runId,
			runDir,
			revision: parsed.revision,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
			workflowId: parsed.spec.id,
		});
	}
	// Newest first. Two runs created in the same millisecond tie on `createdAt`; the
	// run id then decides, so the order never depends on how the directory listed.
	return runs.sort((left, right) =>
		left.createdAt === right.createdAt
			? (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0)
			: left.createdAt < right.createdAt
				? 1
				: -1,
	);
}

/** One run of a workflow, with the phase its records are in. */
export interface WorkflowRunSummary extends PinnedRun {
	phase: RunPhase;
}

/** Options for {@link listWorkflowRuns}. */
export interface ListRunsOptions {
	cwd?: string;
	/** The service to ask for a phase. Defaults to the shared one. */
	service?: RunService;
}

/**
 * The runs of one workflow under `cwd`, newest first.
 *
 * `phase` comes from the records on disk (`service.status`), not from a
 * `Runtime`: a run this process does not own is exactly what a restart has to
 * look like. A run whose records cannot be read reports `idle` — nothing on disk
 * claims a turn, and pretending it is `running` would make its agents
 * permanently unretirable.
 */
export async function listWorkflowRuns(
	workflowId: string,
	options: ListRunsOptions = {},
): Promise<WorkflowRunSummary[]> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const service = options.service ?? runService({ cwd });
	const runs = pinnedRuns(cwd).filter((run) => run.workflowId === workflowId);
	const summaries: WorkflowRunSummary[] = [];
	for (const run of runs) {
		let phase: RunPhase = "idle";
		try {
			phase = (await service.status(run.runId)).phase;
		} catch {
			// A corrupt run has no claim on a live thread; see the doc comment.
		}
		summaries.push({ ...run, phase });
	}
	return summaries;
}

/** A run that refuses an edit because one of its threads is still working. */
export interface BusyRun {
	runId: string;
	runDir: string;
	/** Threads of the retiring agents that are still `running`. */
	threadIds: readonly string[];
}

/**
 * Which runs would lose a thread if these agents were retired.
 *
 * Each run is opened first, because recovery runs there: a thread left `running`
 * by a dead host is settled (`execution_lost`) at open, and without that the
 * check would report a crash as live work forever. A run another process owns
 * refuses the open; its records are then believed as they stand, which is the
 * conservative answer and the one that cannot lose a turn.
 */
async function busyRuns(
	service: RunService,
	runs: readonly WorkflowRunSummary[],
	agents: readonly string[],
): Promise<BusyRun[]> {
	const busy: BusyRun[] = [];
	for (const run of runs) {
		try {
			await service.open(run.runDir);
		} catch {
			// Locked by another process, or unreadable: fall through to the records.
		}
		let threads: { threadId: string; agentId: string; phase: RunPhase }[];
		try {
			threads = (await service.status(run.runId)).threads;
		} catch {
			continue;
		}
		const live = threads
			.filter((thread) => thread.phase === "running" && agents.includes(unqualify(thread.agentId)))
			.map((thread) => thread.threadId);
		if (live.length) busy.push({ runId: run.runId, runDir: run.runDir, threadIds: live });
	}
	return busy;
}

/** Options for {@link openOrContinue}. */
export interface OpenOrContinueOptions {
	/** The spec to run — already edited, or the one on disk. */
	spec: WorkflowSpec;
	/** Where the `.pi/standard-agents/runs` tree lives. Defaults to the process's cwd. */
	cwd?: string;
	/**
	 * Agents to retire as part of this open.
	 *
	 * This is the gated half of `removeAgent`: the pure edit says what the diff
	 * should be, and this says "make it so, unless a thread is still using it". The
	 * agents are dropped from `spec` here, *after* the live-thread check, so a
	 * refused retirement never reaches a run directory — which means the spec handed
	 * over may be the one that still has them.
	 */
	retire?: string | readonly string[];
	/** The service to open runs with. Defaults to the shared one, bound to `cwd`. */
	service?: RunService;
}

/** What {@link openOrContinue} decided. */
export type WorkflowOpenAction = "created" | "continued" | "revised";

/** The result of {@link openOrContinue}. */
export interface WorkflowOpen {
	/** `created` (no run existed), `continued` (same revision), `revised` (new revision). */
	action: WorkflowOpenAction;
	/** The run work belongs to now: the newest one at this revision. */
	run: OpenRun;
	revision: string;
	/**
	 * The run this open left behind, when the edit produced a new revision. It
	 * keeps its own `spec.json`, registry and store, so its threads stay readable.
	 */
	previous: WorkflowRunSummary | null;
	/** Agents retired by this open, in the order they were named. */
	retired: readonly RetiredAgent[];
}

function retireNames(retire: OpenOrContinueOptions["retire"]): string[] {
	if (retire === undefined) return [];
	const names = Array.isArray(retire) ? retire : [retire as string];
	return [...new Set(names.map((name) => unqualify(name)).filter((name) => name !== ""))];
}

/**
 * Open the newest run of this workflow at this revision, or create one, and
 * apply any retirement first.
 *
 * The rule is one line: a run is pinned to a revision, so a spec whose revision
 * differs is a **new** run directory — never an edit to a live one. That holds
 * whether the newest run is idle or still working, which is why an edit cannot
 * invalidate a run in flight: the old run keeps the `Runtime`, the registry and
 * the store it was built with.
 *
 * Two refusals, both before anything is written:
 *  - `agent_unknown` — a name in `retire` that the spec does not have;
 *  - `agent_busy` — a thread of an agent being retired is still `running`, with
 *    the run ids that hold it (see {@link busyRuns}).
 *
 * A run owned by another process is opened as-is and the lock refusal
 * (`run_locked`) is left to `RunService.open`: the caller decides whether to wait
 * or to `create` a second run on purpose.
 */
export async function openOrContinue(options: OpenOrContinueOptions): Promise<WorkflowOpen> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const service = options.service ?? runService({ cwd });

	let spec = options.spec;
	const retired: RetiredAgent[] = [];
	const retiring = retireNames(options.retire);
	for (const name of retiring) {
		const result = removeAgent(spec, name);
		if (!result.retired) {
			throw new WorkflowError("agent_unknown", `Workflow '${spec.id}' has no agent '${name}'`, {
				agents: [name],
			});
		}
		spec = result.spec;
		retired.push(result.retired);
	}

	const runs = await listWorkflowRuns(spec.id, { cwd, service });
	if (retiring.length) {
		const busy = await busyRuns(service, runs, retiring);
		if (busy.length) {
			throw new WorkflowError(
				"agent_busy",
				`Cannot retire ${retiring.map((name) => `'${name}'`).join(", ")}: thread(s) still running in ` +
					`${busy.map((run) => run.runId).join(", ")}. Stop the run first — an agent cannot be dropped ` +
					"from a registry a live thread is using",
				{ runIds: busy.map((run) => run.runId), agents: retiring },
			);
		}
	}

	const revision = revisionOf(spec);
	// Addressed by revision, not by "the newest directory": two runs created in the
	// same millisecond are indistinguishable by `createdAt`, and reverting an edit
	// should land on the run that already has this revision rather than on a third.
	// A terminated run is finished, whatever its revision — `stop()` ended it, so
	// new work gets a new run directory, not a thread appended to a run somebody
	// deliberately ended.
	const matching = runs.find((run) => run.revision === revision && run.phase !== "terminated");
	if (matching) {
		const run = await service.open(matching.runDir, { spec });
		return { action: "continued", run, revision, previous: null, retired };
	}

	const previous = runs[0] ?? null;
	const run = await service.create(spec, { cwd });
	return { action: previous ? "revised" : "created", run, revision, previous, retired };
}
