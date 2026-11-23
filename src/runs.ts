/**
 * A run is a directory plus one `Runtime`.
 *
 * The runtime deliberately leaves four jobs to its host, and they are what this
 * file is:
 *
 *  - **Open/close.** A run directory carries everything a process needs to pick
 *    the work back up: `spec.json` (the pinned spec and its revision),
 *    `journal.jsonl` (U03's usage rows) and `store/` (the thread store).
 *  - **Restart recovery.** `Runtime` keeps executions in memory and
 *    `ThreadStore` has no lease, so a thread left `running` by a dead process is
 *    a lie on disk. `store.recoverStale()` settles those, and it must run before
 *    the first `start` in this process — never while an execution here is live.
 *  - **The single-writer rule.** Two runtimes on one thread id interleave writes
 *    to the same `messages.json`, so one run directory has one owner:
 *    `owner.lock` names a pid, and a run this process already holds is never
 *    opened twice.
 *  - **Revisions.** `revision` is data on the run, not global state. A run keeps
 *    the `Runtime` it was opened with; the next revision (U07) is a new run
 *    directory, because a run whose spec changed underneath it is not the same
 *    run.
 *
 * Nothing here runs at import time (README invariant 6): `runService()` is a
 * lazy singleton and `shutdownRunService()` is what a PI `session_shutdown`
 * handler calls, so a reload never leaves an orphan claim behind.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
	DefinitionIssue,
	HookName,
	ProviderFactory,
	ThreadRunState,
} from "@standardagents/spec";
import { Runtime } from "@t-works/standardagents-runtime";
import type { RuntimeEvent } from "@t-works/standardagents-runtime/contract";
import type { Registry } from "@t-works/standardagents-runtime/loader";
import { unqualify } from "@t-works/standardagents-runtime/loader";
import { ThreadStore } from "@t-works/standardagents-runtime/store";
import type { ThreadRecord } from "@t-works/standardagents-runtime/store";

import type { Journal } from "./journal.ts";
import { openJournal } from "./journal.ts";
import type {
	AgentSpec,
	HookSpec,
	LibraryPromptSpec,
	ModelSpec,
	PromptSpec,
	ToolSpec,
	WorkflowSpec,
} from "./registry.ts";
import { buildRegistry } from "./registry.ts";

/** Path segments below the working directory a run directory lives under. */
export const RUNS_DIR = [".pi", "standard-agents", "runs"] as const;
/** The pinned spec and its revision. */
export const SPEC_FILE = "spec.json";
/** U03's append-only usage log. */
export const JOURNAL_FILE = "journal.jsonl";
/** The thread store, so one run never shares `messages.json` with another. */
export const STORE_DIR = "store";
/** The advisory owner claim. */
export const OWNER_LOCK_FILE = "owner.lock";
/** One thread record, as the store writes it. */
export const RECORD_FILE = "thread.json";
/** Hex characters of the spec hash that name a revision. */
export const REVISION_LENGTH = 12;
/** A lock younger than this and owned by a live pid is honoured. */
export const DEFAULT_STALE_LOCK_MS = 900_000;

/**
 * Written into `owner.lock` itself, not only into a comment: an operator who
 * finds the file in a run directory has to know what it does and does not
 * promise.
 */
const LOCK_ADVISORY =
	"Advisory lock, checked by pid and age only. The owner counts as live while its pid exists and " +
	"the lock is younger than staleLockMs; a reused pid, a container with a shared volume, or a " +
	"clock jump defeats that. The worst case is a stale lock, never silent corruption.";

/** Why a run operation was refused. Closed union: a new reason is a new decision. */
export type RunErrorCode =
	| "run_not_found"
	| "run_corrupt"
	| "run_exists"
	| "run_locked"
	| "revision_mismatch"
	| "agent_unknown"
	| "thread_not_found"
	| "thread_terminated"
	| "run_not_open";

/** Thrown for every refusal that is a rule rather than a bug. */
export class RunError extends Error {
	readonly code: RunErrorCode;
	readonly runDir: string | null;

	constructor(
		code: RunErrorCode,
		message: string,
		options: { runDir?: string; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RunError";
		this.code = code;
		this.runDir = options.runDir ?? null;
	}
}

/**
 * The spec as a file can hold it: `provider` factories, hook and tool `execute`
 * functions are host code, not data, so they never reach `spec.json`.
 */
export interface RunSpecData {
	id: string;
	agents: readonly AgentSpec[];
	prompts: readonly PromptSpec[];
	/**
	 * Shared prompts the workflow's own prompts compose by name (U07). Pinned with
	 * the rest of the spec: a library prompt is part of what the run was built
	 * from, so changing one is a new revision, not a silent edit to a live run.
	 */
	library?: readonly LibraryPromptSpec[];
	models: readonly Omit<ModelSpec, "provider">[];
	hooks?: readonly { id: string; hook: HookName }[];
	tools?: readonly Omit<ToolSpec, "execute">[];
}

/** `spec.json`: what the run is pinned to, plus how to name it in a log line. */
export interface RunSpecFile {
	runId: string;
	/** `sha256(data)[0..12]`: the run's identity, so a changed spec is a new run. */
	revision: string;
	createdAt: string;
	/** Working directory the run was created under. */
	cwd: string;
	spec: RunSpecData;
}

/** `owner.lock`: the advisory claim. Its own text says it is advisory. */
export interface OwnerLock {
	pid: number;
	startedAt: string;
	advisory: string;
}

/** One thread as `status()` reports it: the record, not an in-memory guess. */
export interface RunThreadView {
	threadId: string;
	agentId: string;
	parentId: string | null;
	relationship: string | null;
	/** True when this thread was spawned by a blocking relationship. */
	blocking: boolean;
	/** `terminated` wins over the stored run state, which terminate leaves `idle`. */
	phase: RunPhase;
	state: ThreadRunState;
	reason: string | null;
	terminatedAt: number | null;
	/** The parent's own view of each child, so a cascade is observable from the record. */
	children: RunChildView[];
	/**
	 * The last session result this thread exported. Held in memory by `Thread`, so
	 * a run reopened in another process reports `null` rather than inventing one.
	 */
	lastSessionResult: string | null;
}

/** One entry of a parent record's `children[]`. */
export interface RunChildView {
	reference: string;
	relationship: string;
	name: string;
	status: string;
	blocking: boolean;
}

/** Where a run, or one thread in it, stands. */
export type RunPhase = "idle" | "running" | "failed" | "terminated";

/** What `status(runId)` answers. */
export interface RunStatus {
	runId: string;
	runDir: string;
	revision: string;
	phase: RunPhase;
	/** True when this service holds the run's lock and `Runtime`. */
	open: boolean;
	threads: RunThreadView[];
}

/** What one `start()` produced. */
export interface RunTurn {
	threadId: string;
	state: ThreadRunState;
	reason: string | null;
	result: string | null;
}

/** What `stop()` ended: the root threads it terminated; children cascade. */
export interface RunStopResult {
	terminated: string[];
}

/** An open run: the directory, the registry built for it, and its one `Runtime`. */
export interface OpenRun {
	runId: string;
	runDir: string;
	/** `sha256(spec)[0..12]`, the value pinned in `spec.json`. */
	revision: string;
	/** The spec this runtime was built from, host code included. */
	spec: WorkflowSpec;
	registry: Registry;
	store: ThreadStore;
	runtime: Runtime;
	journal: Journal;
	/**
	 * Issues the registry build reported. Non-empty only when a run was reopened
	 * from `spec.json` alone: the file cannot carry provider or tool code.
	 */
	issues: readonly DefinitionIssue[];
	/** Threads `store.recoverStale()` settled while opening this run. */
	recovered: number;
	/** True when this open replaced someone else's (or a stale) claim. */
	tookOverLock: boolean;
	/** The lock this service wrote. `close()` releases it only while it still matches. */
	lock: OwnerLock;
	/** Runtime events seen since the run was opened. */
	events(): number;
	/**
	 * Subscribe to this run's runtime events (U06). The run's `Runtime` owns one
	 * `onEvent` wrapper, created when the run was opened; every listener is fanned
	 * out from it, so a session can watch a run without reaching into the runtime.
	 * Returns the unsubscribe; a listener that throws never ends a turn.
	 */
	listen(listener: (event: RuntimeEvent) => void): () => void;
}

/** Options for {@link RunService}. Everything a host has to supply in code lives here. */
export interface RunServiceOptions {
	/** Where runs are created. Defaults to the process's working directory. */
	cwd?: string;
	/** How old a live-looking lock must be before it is taken over. */
	staleLockMs?: number;
	/**
	 * Provider factories, keyed by model name, for models a spec declares without
	 * one. `spec.json` can only hold data, so this is how a reopened run gets its
	 * providers back (U03's `piModel`, a scripted provider in tests).
	 */
	providers?: Readonly<Record<string, ProviderFactory>>;
	/** Tool and hook code, by name/id, for a run reopened from `spec.json`. */
	tools?: readonly ToolSpec[];
	hooks?: readonly HookSpec[];
	/** Runtime event sink. Without it a run only counts events. */
	onEvent?: (event: RuntimeEvent) => void;
	/** Passed straight to `Runtime`; per-turn step cap when a side declares none. */
	maxSteps?: number;
	/** Passed straight to `Runtime`; hard execution step cap across both sides. */
	maxTotalSteps?: number;
	/** Passed straight to `Runtime`; the host's environment. */
	instanceEnv?: (name: string) => string | undefined;
	/**
	 * Store key material. Left empty, the runtime uses its per-user key file —
	 * which is what makes a run directory reusable after a restart.
	 */
	store?: { envKey?: string; keyFile?: string };
	/** Injectable clock, so lock age is testable without waiting. */
	now?: () => number;
	/** Injectable pid probe, so the dead-pid rule is testable without killing a process. */
	pidIsAlive?: (pid: number) => boolean;
}

/** Options for {@link RunService.create}. */
export interface CreateRunOptions {
	/** Working directory the `.pi/standard-agents/runs` tree is created under. */
	cwd?: string;
	/** Pick the run id yourself; the default is derived from the spec id. */
	runId?: string;
}

/** Options for {@link RunService.open}. */
export interface OpenRunOptions {
	/**
	 * The spec the host is resuming with. When its revision differs from the one
	 * in `spec.json` the open is refused: a run is pinned. When it matches, its
	 * code (providers, tools, hooks) builds the registry, so a resumed run keeps
	 * working tool calls.
	 */
	spec?: WorkflowSpec;
}

// ── spec → data → revision ──────────────────────────────────────────────────

/**
 * Strip host code from a spec, leaving what a JSON file can hold.
 *
 * `JSON.stringify` drops functions on its own; going through it is deliberate,
 * so `spec.json` is exactly the data the revision was computed over.
 */
export function projectSpec(spec: WorkflowSpec): RunSpecData {
	return JSON.parse(JSON.stringify(spec)) as RunSpecData;
}

/**
 * A stable JSON encoding: object keys sorted, `undefined` and functions dropped.
 *
 * The revision has to survive a round trip through `spec.json` and be
 * independent of the order a host happened to build its objects in — otherwise a
 * resumed run would look like a different revision for no reason.
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined && typeof entry !== "function")
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** `sha256(data)[0..12]`, the run's revision. */
function revisionOfData(data: RunSpecData): string {
	return createHash("sha256").update(canonicalJson(data)).digest("hex").slice(0, REVISION_LENGTH);
}

/**
 * The revision of a spec: the hash of its *data*, not of its host code.
 *
 * A provider factory is a closure; hashing it would make the value meaningless
 * across processes and would change on every reload. Two hosts running the same
 * workflow with different providers are running the same revision, which is what
 * "the run's spec did not change" is supposed to mean.
 */
export function revisionOf(spec: WorkflowSpec): string {
	return revisionOfData(projectSpec(spec));
}

/**
 * Rebuild a usable spec from `spec.json` plus whatever code the host supplies.
 *
 * A declaration with no implementation is dropped rather than faked: `buildRegistry`
 * then reports the reference issue (callers pass `strict: false` here), and the
 * model request for that prompt simply has one tool fewer. Inventing an
 * `execute` that throws would move the failure from a legible issue to the
 * middle of a turn.
 */
function hydrate(data: RunSpecData, code: { tools?: readonly ToolSpec[]; hooks?: readonly HookSpec[] }): WorkflowSpec {
	const tools = (data.tools ?? []).flatMap((declared) => {
		const implementation = code.tools?.find((tool) => tool.name === declared.name);
		return implementation ? [{ ...declared, ...implementation }] : [];
	});
	const hooks = (data.hooks ?? []).flatMap((declared) => {
		const implementation = code.hooks?.find((hook) => hook.id === declared.id);
		return implementation ? [implementation] : [];
	});
	return {
		id: data.id,
		agents: data.agents,
		prompts: data.prompts,
		// Kept apart from `prompts` on purpose: a library prompt is included by
		// name, so a reopened run must resolve the same includes the pinned spec had.
		...(data.library === undefined ? {} : { library: data.library }),
		models: data.models,
		tools,
		hooks,
	};
}

// ── run directory I/O ───────────────────────────────────────────────────────

function runsRoot(cwd: string): string {
	return join(resolve(cwd), ...RUNS_DIR);
}

function runIdFor(workflowId: string, now: number): string {
	const slug = workflowId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 40);
	return `${slug || "run"}-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
}

function writeSpecFile(runDir: string, file: RunSpecFile): void {
	writeFileSync(join(runDir, SPEC_FILE), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
}

function readSpecFile(runDir: string): RunSpecFile {
	let raw: string;
	try {
		raw = readFileSync(join(runDir, SPEC_FILE), "utf8");
	} catch (error) {
		throw new RunError("run_not_found", `No run at '${runDir}': ${SPEC_FILE} is missing`, {
			runDir,
			cause: error,
		});
	}
	let parsed: Partial<RunSpecFile>;
	try {
		parsed = JSON.parse(raw) as Partial<RunSpecFile>;
	} catch (error) {
		throw new RunError("run_corrupt", `'${join(runDir, SPEC_FILE)}' is not JSON`, { runDir, cause: error });
	}
	if (typeof parsed.runId !== "string" || typeof parsed.revision !== "string" || !parsed.spec) {
		throw new RunError("run_corrupt", `'${join(runDir, SPEC_FILE)}' is not a run record`, { runDir });
	}
	return parsed as RunSpecFile;
}

function readOwnerLock(runDir: string): OwnerLock | null {
	let raw: string;
	try {
		raw = readFileSync(join(runDir, OWNER_LOCK_FILE), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<OwnerLock>;
		if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
		return {
			pid: parsed.pid,
			startedAt: parsed.startedAt,
			advisory: typeof parsed.advisory === "string" ? parsed.advisory : LOCK_ADVISORY,
		};
	} catch {
		// An unreadable lock is treated as absent: a stale lock is the failure mode
		// this file accepts, and refusing every run after a torn write is worse.
		return null;
	}
}

function writeOwnerLock(runDir: string, now: number): OwnerLock {
	const lock: OwnerLock = {
		pid: process.pid,
		startedAt: new Date(now).toISOString(),
		advisory: LOCK_ADVISORY,
	};
	writeFileSync(join(runDir, OWNER_LOCK_FILE), `${JSON.stringify(lock, null, "\t")}\n`, "utf8");
	return lock;
}

/**
 * Is the pid still around?
 *
 * `kill(pid, 0)` only probes: EPERM means the process exists but belongs to
 * somebody else, which is still "alive" for our purpose.
 */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Read every thread record a run directory holds, without touching the store.
 *
 * `ThreadStore.list()` is the same read with env decryption on top, and its
 * constructor may create a per-user key file. Status needs neither, so it reads
 * `thread.json` files: the answer is what is on disk, which is exactly what a
 * restart or a terminate has to be judged by.
 */
function readRecords(storeRoot: string): ThreadRecord[] {
	let ids: string[];
	try {
		ids = readdirSync(join(storeRoot, "threads"));
	} catch {
		return [];
	}
	const records: ThreadRecord[] = [];
	for (const id of ids) {
		try {
			records.push(JSON.parse(readFileSync(join(storeRoot, "threads", id, RECORD_FILE), "utf8")) as ThreadRecord);
		} catch {
			// A half-written record is skipped, not repaired: recovery is the store's job.
		}
	}
	return records.sort((left, right) => left.created_at - right.created_at);
}

function viewOf(record: ThreadRecord, open: OpenRun | undefined): RunThreadView {
	const state: ThreadRunState = record.status?.state ?? "idle";
	const children: RunChildView[] = (record.children ?? []).map((child) => ({
		reference: child.reference,
		relationship: child.relationship,
		name: child.name,
		status: child.status ?? "",
		blocking: child.blocking === true,
	}));
	return {
		threadId: record.id,
		agentId: record.agent_id,
		parentId: record.parent_id,
		relationship: record.relationship,
		blocking: record.blocking,
		phase: record.terminated ? "terminated" : state,
		state,
		reason: record.status?.reason ?? null,
		terminatedAt: record.terminated,
		children,
		// Only a live runtime knows this: `Thread.lastSessionResult` never reaches disk.
		lastSessionResult: open ? open.runtime.threadFor(record).lastSessionResult : null,
	};
}

function phaseOf(threads: readonly RunThreadView[]): RunPhase {
	if (threads.some((thread) => thread.phase === "running")) return "running";
	if (threads.some((thread) => thread.phase === "failed")) return "failed";
	if (threads.length > 0 && threads.every((thread) => thread.phase === "terminated")) return "terminated";
	return "idle";
}

// ── the service ─────────────────────────────────────────────────────────────

/**
 * Owns the run directories one process has open.
 *
 * One instance per process is the intent (see {@link runService}), but the class
 * is public because a test — and any host that wants a second, isolated view —
 * has to be able to build one explicitly.
 */
export class RunService {
	private readonly options: RunServiceOptions;
	/** Open runs, keyed by resolved run directory. */
	private readonly runs = new Map<string, OpenRun>();

	constructor(options: RunServiceOptions = {}) {
		this.options = options;
	}

	private clock(): number {
		return this.options.now?.() ?? Date.now();
	}

	private staleLockMs(): number {
		return this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
	}

	private alive(pid: number): boolean {
		return (this.options.pidIsAlive ?? pidExists)(pid);
	}

	/**
	 * Is somebody else's claim on this directory still good?
	 *
	 * A lock whose age cannot be read counts as held while its pid lives: an
	 * unreadable timestamp is a reason to refuse an open, not to invent a second
	 * writer.
	 */
	private lockIsHeld(lock: OwnerLock | null): lock is OwnerLock {
		if (!lock || !this.alive(lock.pid)) return false;
		const startedAt = Date.parse(lock.startedAt);
		if (!Number.isFinite(startedAt)) return true;
		return this.clock() - startedAt < this.staleLockMs();
	}

	/** Create a run directory and open it. */
	async create(spec: WorkflowSpec, options: CreateRunOptions = {}): Promise<OpenRun> {
		const data = projectSpec(spec);
		const revision = revisionOfData(data);
		// Build first: a spec that cannot produce a registry must not leave a
		// half-written run directory (or a lock) behind.
		const { registry, issues } = buildRegistry(spec, { providers: this.options.providers });

		const cwd = resolve(options.cwd ?? this.options.cwd ?? process.cwd());
		const runId = options.runId ?? runIdFor(data.id, this.clock());
		const root = runsRoot(cwd);
		mkdirSync(root, { recursive: true });
		const runDir = join(root, runId);
		if (existsSync(join(runDir, SPEC_FILE))) {
			throw new RunError("run_exists", `Run '${runId}' already exists at '${runDir}'`, { runDir });
		}
		mkdirSync(runDir, { recursive: true });

		const file: RunSpecFile = {
			runId,
			revision,
			createdAt: new Date(this.clock()).toISOString(),
			cwd,
			spec: data,
		};
		writeSpecFile(runDir, file);

		const open = this.materialize({ runDir, file, spec, registry, issues, tookOverLock: false });
		open.journal.append({
			kind: "status",
			at: new Date(this.clock()).toISOString(),
			status: "created",
			detail: `${data.id} at revision ${revision}`,
		});
		return open;
	}

	/**
	 * Open an existing run directory.
	 *
	 * Order matters and is the whole single-writer rule:
	 *  1. the revision is checked first — a different spec is a different run,
	 *     whatever the lock says;
	 *  2. a run this service already holds is returned as-is, so one process
	 *     never builds a second `Runtime` over one store;
	 *  3. somebody else's live lock is refused;
	 *  4. only then is the directory touched: registry, store, lock, recovery.
	 */
	async open(runDir: string, options: OpenRunOptions = {}): Promise<OpenRun> {
		const dir = resolve(runDir);
		const file = readSpecFile(dir);

		if (options.spec) {
			const revision = revisionOf(options.spec);
			if (revision !== file.revision) {
				throw new RunError(
					"revision_mismatch",
					`Run '${file.runId}' is pinned to revision ${file.revision}, not ${revision}: ` +
						"a changed spec is a new run, not a reopened one",
					{ runDir: dir },
				);
			}
		}

		const held = this.runs.get(dir);
		if (held) return held;

		const lock = readOwnerLock(dir);
		if (this.lockIsHeld(lock)) {
			const age = this.clock() - Date.parse(lock.startedAt);
			throw new RunError(
				"run_locked",
				`Run '${file.runId}' is owned by pid ${lock.pid} (lock ${age}ms old): ` +
					"two runtimes on one store interleave writes to the same messages.json",
				{ runDir: dir },
			);
		}

		const spec = options.spec ?? hydrate(file.spec, this.options);
		// A host-supplied spec is complete, so its problems are fatal; a projection
		// from `spec.json` is data only, so missing code is reported, not thrown.
		const { registry, issues } = buildRegistry(spec, {
			providers: this.options.providers,
			strict: options.spec !== undefined,
		});

		return this.materialize({ runDir: dir, file, spec, registry, issues, tookOverLock: lock !== null });
	}

	/**
	 * Construct the store, the runtime, the journal and the claim for one directory.
	 *
	 * The lock is rewritten *before* `recoverStale()` on purpose: recovery writes
	 * thread records, and a second opener must already see a live claim while it
	 * happens, or both of them would recover the same threads.
	 */
	private materialize(input: {
		runDir: string;
		file: RunSpecFile;
		spec: WorkflowSpec;
		registry: Registry;
		issues: readonly DefinitionIssue[];
		tookOverLock: boolean;
	}): OpenRun {
		const journal = openJournal(input.runDir, { fileName: JOURNAL_FILE });
		const store = new ThreadStore(join(input.runDir, STORE_DIR), this.options.store ?? {});
		const counter = { events: 0 };
		/** This run's subscribers: one `onEvent` wrapper, many listeners (U06). */
		const listeners = new Set<(event: RuntimeEvent) => void>();
		const runtime = new Runtime({
			store,
			registry: input.registry,
			onEvent: (event: RuntimeEvent) => {
				counter.events += 1;
				this.options.onEvent?.(event);
				// A copy, so a listener may unsubscribe while it is being notified.
				for (const listener of [...listeners]) {
					try {
						listener(event);
					} catch {
						// A view that throws must not fail the turn it is watching.
					}
				}
			},
			...(this.options.maxSteps === undefined ? {} : { maxSteps: this.options.maxSteps }),
			...(this.options.maxTotalSteps === undefined ? {} : { maxTotalSteps: this.options.maxTotalSteps }),
			...(this.options.instanceEnv === undefined ? {} : { instanceEnv: this.options.instanceEnv }),
		});

		const lock = writeOwnerLock(input.runDir, this.clock());
		// Before the first `start` in this process: a thread left `running` by a dead
		// owner is settled here, never while an execution of ours is live.
		const recovered = store.recoverStale();
		if (recovered > 0) {
			journal.append({
				kind: "status",
				at: new Date(this.clock()).toISOString(),
				status: "recovered",
				detail: `${recovered} thread(s) settled as execution_lost`,
			});
		}

		const open: OpenRun = {
			runId: input.file.runId,
			runDir: input.runDir,
			revision: input.file.revision,
			spec: input.spec,
			registry: input.registry,
			store,
			runtime,
			journal,
			issues: input.issues,
			recovered,
			tookOverLock: input.tookOverLock,
			lock,
			events: () => counter.events,
			listen(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		this.runs.set(input.runDir, open);
		return open;
	}

	private lookup(runId: string): OpenRun | undefined {
		for (const run of this.runs.values()) {
			if (run.runId === runId) return run;
		}
		return undefined;
	}

	private require(runId: string): OpenRun {
		const open = this.lookup(runId);
		if (!open) {
			throw new RunError(
				"run_not_open",
				`Run '${runId}' is not open in this service: the lock and the Runtime belong to ` +
					"whoever opened it. Call open() first",
			);
		}
		return open;
	}

	/** Where a run lives, whether or not this service holds it. */
	private locate(runId: string): { runDir: string; open: OpenRun | undefined } {
		const open = this.lookup(runId);
		if (open) return { runDir: open.runDir, open };
		const candidate = join(runsRoot(this.options.cwd ?? process.cwd()), runId);
		if (!existsSync(join(candidate, SPEC_FILE))) {
			throw new RunError("run_not_found", `No run '${runId}' under '${runsRoot(this.options.cwd ?? process.cwd())}'`, {
				runDir: candidate,
			});
		}
		return { runDir: candidate, open: undefined };
	}

	/**
	 * Start a turn: a fresh thread for `agentId`, one user message, then settle.
	 *
	 * `settle()` waits for *every* run in the runtime, so a blocking child that
	 * never ends keeps this promise open. U05's deadline is what bounds it; a
	 * caller without U05 must race it (the tests do).
	 */
	async start(
		runId: string,
		input: { agentId: string; message: string; threadName?: string },
	): Promise<RunTurn> {
		const open = this.require(runId);
		if (!open.registry.agents.has(unqualify(input.agentId))) {
			throw new RunError(
				"agent_unknown",
				`Revision ${open.revision} of run '${runId}' has no agent '${input.agentId}'`,
				{ runDir: open.runDir },
			);
		}
		const thread = await open.runtime.createThread({
			agentId: unqualify(input.agentId),
			...(input.threadName === undefined ? {} : { threadName: input.threadName }),
		});
		await thread.queueMessage({ role: "user", content: input.message }, { trigger: false });
		await open.runtime.start(thread, "a");
		await open.runtime.settle();
		return {
			threadId: thread.threadId,
			state: thread.data.status.state,
			reason: thread.data.status.reason ?? null,
			result: thread.lastSessionResult,
		};
	}

	/** Queue a human message on an existing thread. The runtime starts the turn. */
	async post(runId: string, threadId: string, text: string): Promise<{ threadId: string }> {
		const open = this.require(runId);
		const record = open.store.load(threadId);
		if (!record) {
			throw new RunError("thread_not_found", `Run '${runId}' has no thread '${threadId}'`, {
				runDir: open.runDir,
			});
		}
		if (record.terminated) {
			throw new RunError("thread_terminated", `Thread '${threadId}' was terminated`, {
				runDir: open.runDir,
			});
		}
		await open.runtime.threadFor(record).queueMessage({ role: "user", content: text });
		return { threadId };
	}

	/**
	 * Report the run from what is on disk.
	 *
	 * Nothing is repaired here: a `running` thread in a run this process does not
	 * own is exactly what a restart has to look like before recovery.
	 */
	async status(runId: string): Promise<RunStatus> {
		const { runDir, open } = this.locate(runId);
		const file = readSpecFile(runDir);
		const threads = readRecords(join(runDir, STORE_DIR)).map((record) => viewOf(record, open));
		return {
			runId: file.runId,
			runDir,
			revision: file.revision,
			phase: phaseOf(threads),
			open: open !== undefined,
			threads,
		};
	}

	/**
	 * Terminate every root thread; the runtime cascades to children.
	 *
	 * `Thread.terminate()` aborts the execution, terminates the children and
	 * writes `terminated` into the parent's `children[]` entry, so this is one
	 * call per root and no bookkeeping of our own.
	 */
	async stop(runId: string): Promise<RunStopResult> {
		const open = this.require(runId);
		const terminated: string[] = [];
		for (const record of open.store.list()) {
			if (record.parent_id !== null || record.terminated) continue;
			await open.runtime.threadFor(record).terminate();
			terminated.push(record.id);
		}
		open.journal.append({
			kind: "status",
			at: new Date(this.clock()).toISOString(),
			status: "stopped",
			detail: terminated.length ? `${terminated.length} root thread(s) terminated` : "no live root thread",
		});
		return { terminated };
	}

	/**
	 * Release every claim this service holds.
	 *
	 * Only a lock that still matches the one we wrote is removed, so a run taken
	 * over by another process in the meantime is not un-claimed by us. Live work is
	 * left as it stands: the records say `running`, and the next opener's
	 * `recoverStale()` is what settles it.
	 */
	close(): void {
		for (const open of this.runs.values()) {
			const current = readOwnerLock(open.runDir);
			if (current && current.pid === open.lock.pid && current.startedAt === open.lock.startedAt) {
				try {
					rmSync(join(open.runDir, OWNER_LOCK_FILE), { force: true });
				} catch {
					// A lock we cannot remove is a stale lock, which the next open takes over.
				}
			}
		}
		this.runs.clear();
	}
}

// ── the lazy singleton a PI session uses ────────────────────────────────────

let singleton: RunService | null = null;

/**
 * The service one PI session shares, created on first use.
 *
 * Nothing here runs in the extension factory (README invariant 6): importing
 * this module builds no store, takes no lock and touches no file. Options are
 * read on first creation only — a session configures the singleton once, before
 * its first run.
 */
export function runService(options: RunServiceOptions = {}): RunService {
	singleton ??= new RunService(options);
	return singleton;
}

/**
 * Release the singleton's claims. A PI `session_shutdown` handler calls this, so
 * a reload never leaves an orphan claim. It never *creates* the service: a
 * session that ran nothing has nothing to release.
 */
export function shutdownRunService(): void {
	singleton?.close();
	singleton = null;
}

/** Create a run through the shared service. */
export async function createRun(options: CreateRunOptions & { spec: WorkflowSpec }): Promise<OpenRun> {
	return runService().create(options.spec, { cwd: options.cwd, runId: options.runId });
}

/** Open an existing run directory through the shared service. */
export async function openRun(runDir: string, options: OpenRunOptions = {}): Promise<OpenRun> {
	return runService().open(runDir, options);
}
