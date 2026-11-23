/**
 * What a run looks like *while* it runs.
 *
 * The runtime reports one `RuntimeEvent` per meaningful step — a message, a tool
 * call, a status transition, a subagent entry changing — through a single
 * `onEvent` hook. This file turns that stream into three surfaces and nothing
 * else:
 *
 *  - **One subscription per run** (`subscribe`). It maps each event to one
 *    bounded line, attributes it (run from the subscription, thread from
 *    `event.threadId`), journals the rows that outlive the turn, and hands the
 *    line to that run's sink. Attribution is a lookup, never an inference: from
 *    `@t-works/standardagents-runtime@0.2.1` every event carries `threadId`, and
 *    two conventional side channels — timestamps and `parentId` guessing — would
 *    be wrong for a blocking child the moment two threads run in one step.
 *    An older runtime that omits the field still renders: the line is labelled
 *    `run` instead of a thread, so a degraded runtime loses attribution, not
 *    lines.
 *  - **One renderer** for the completion wake (`standard-agent-run`). It prints
 *    phase, revision, turns, tokens/cost and the last few lines, folded by
 *    default — colour and width belong to PI's theme helpers, never to ANSI in
 *    this extension.
 *  - **One command**, `/sa`: `runs`, `cost`, `stop <runId>`. It answers from
 *    disk, so it works with no active run at all.
 *
 * Two costs are real and are handled here rather than left to a caller:
 *
 *  - **Volume.** A 12-step turn is ~30 events, per tool call. Journaling all of
 *    them would turn the usage log into a transcript, so only `tool` and `status`
 *    rows are written (`model_call` rows come from the usage sink in `models.ts`,
 *    which is the only place that can see a nested prompt tool's traffic).
 *  - **Flooding the transcript.** A line per tool call is noise, so live lines
 *    reach `pi.sendMessage` only when the user asked (`/sa runs --follow`) or
 *    when the run has already spoken to the transcript once. The thresholds are
 *    constants here, not settings, until somebody asks for a setting.
 *
 * Nothing here runs at import time (README invariant 6): `subscribe` is the only
 * function that attaches anything, and the extension factory calls it from
 * `session_start`, closing it again on `session_shutdown`.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@t-works/standardagents-runtime/contract";

import type { Journal, JournalRow, JournalTotal } from "./journal.ts";
import { RUNS_DIR } from "./runs.ts";

/** `customType` of the completion wake, and of the run message the renderer draws. */
export const RUN_MESSAGE_TYPE = "standard-agent-run";

/** `customType` of a live line, sent only to a run the user is watching. */
export const LINE_MESSAGE_TYPE = "standard-agent-line";

/** Longest line this module renders, in characters. A terminal is not a log file. */
export const MAX_LINE_LENGTH = 160;

/** Lines kept per run, so the renderer can show the last few without a timer. */
export const LIVE_LINE_LIMIT = 40;

/** Lines the run message shows under its header when expanded. */
export const RENDERED_LINE_LIMIT = 8;

/** The command PI registers. */
export const COMMAND_NAME = "sa";

/** Where runs live, as a command line names it (always forward slashes). */
export const RUNS_LABEL = RUNS_DIR.join("/");

// ── attribution ─────────────────────────────────────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A runtime event as this module accepts it.
 *
 * `threadId` is required by the runtime from 0.2.1 and optional *here*: an older
 * runtime omits it, and a missing field must degrade one line, not drop the
 * event. Everything else is the runtime's own shape.
 */
export type EventLike = DistributiveOmit<RuntimeEvent, "threadId"> & { threadId?: string };

/** Who an event belongs to: the run from the subscription, the thread from the event. */
export interface Attribution {
	runId: string;
	/** The emitting thread, or `null` when this runtime version did not name one. */
	threadId: string | null;
}

/**
 * Attribute one event to a run and (when the runtime says so) a thread.
 *
 * `runId` can only come from the subscription: the runtime has no run concept,
 * and one process may hold several runs. `threadId` is read, never inferred —
 * a timestamp window or a `parentId` walk would mis-attribute the two threads of
 * one step to each other, which is exactly the case a live view must get right.
 */
export function attribute(event: EventLike, run: { runId: string }): Attribution {
	const threadId =
		typeof event.threadId === "string" && event.threadId.length > 0 ? event.threadId : null;
	return { runId: run.runId, threadId };
}

// ── one bounded line per event ──────────────────────────────────────────────

/** Collapse every run of whitespace, so one event is always one line. */
function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** One line, never longer than `limit` characters. */
function bound(text: string, limit = MAX_LINE_LENGTH): string {
	const one = flatten(text);
	if (one.length <= limit) return one;
	return `${one.slice(0, Math.max(0, limit - 1))}…`;
}

/** A message's content as text: text parts joined, anything else named. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const candidate = part as { type?: unknown; text?: unknown };
				if (typeof candidate.text === "string") return candidate.text;
				if (typeof candidate.type === "string") return `[${candidate.type}]`;
			}
			return "";
		})
		.filter((text: string) => text.length > 0)
		.join(" ");
}

/** Data an `event` payload carries, summarised and bounded rather than dropped. */
function dataText(data: unknown): string {
	if (data === undefined || data === null) return "";
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data) ?? "";
	} catch {
		return "";
	}
}

/**
 * One bounded line for one event.
 *
 * Every branch is represented, including the ones a first version is tempted to
 * drop (`effect`, `event`): a live view that silently skips a category is worse
 * than a noisy one, because the user cannot tell "nothing happened" from "we do
 * not show that". A `log` line passes the runtime's message through: it is
 * already redacted upstream, and re-summarising it would hide the one detail it
 * exists to carry.
 */
export function summarise(event: EventLike): string {
	switch (event.type) {
		case "message":
			return bound(`message ${event.message?.role ?? "?"}: ${contentText(event.message?.content)}`);
		case "message_updated":
			return bound(
				`message ${event.message?.role ?? "?"} (updated): ${contentText(event.message?.content)}`,
			);
		case "tool_started":
			return bound(
				event.progress
					? `tool ${event.name} started: ${event.progress}`
					: `tool ${event.name} started`,
			);
		case "tool_done":
			return bound(
				event.error
					? `tool ${event.name} ${event.status}: ${event.error}`
					: `tool ${event.name} ${event.status}`,
			);
		case "status": {
			const state = event.status?.state ?? "unknown";
			const reason = event.status?.reason ? ` (${event.status.reason})` : "";
			return bound(`status ${state}${reason}`);
		}
		case "subagent":
			return bound(`subagent ${event.name} (${event.relationship}) -> ${event.status} ${event.reference}`);
		case "effect":
			return bound(`effect ${event.name} ${event.id}`);
		case "event": {
			const data = dataText(event.data);
			return bound(data ? `event ${event.event}: ${data}` : `event ${event.event}`);
		}
		case "log":
			return bound(`log ${event.level}: ${event.message}`);
		case "error":
			return bound(`error ${event.message}`);
		default:
			return bound(`event ${String((event as { type?: unknown }).type)}`);
	}
}

/** One rendered event line: the run it belongs to and the text a terminal shows. */
export interface EventLine {
	runId: string;
	/** Emitting thread, or `null` when the runtime did not name one. */
	threadId: string | null;
	type: EventLike["type"];
	at: string;
	/** `[<thread>] <summary>`, or `[run] <summary>` without thread attribution. */
	text: string;
}

/**
 * Label plus summary: `[th_1234] tool read done`, or `[run] …` when an older
 * runtime gave no thread. The fallback is visible on purpose — a line that says
 * `run` is telling the user its attribution is run-level, not thread-level.
 */
export function renderLine(threadId: string | null, summary: string): string {
	return bound(`[${threadId ?? "run"}] ${summary}`);
}

/** Map, attribute and render one event. Pure: no journal, no sink. */
export function lineFor(
	event: EventLike,
	run: { runId: string },
	at: string = new Date().toISOString(),
): EventLine {
	const attribution = attribute(event, run);
	return {
		...attribution,
		type: event.type,
		at,
		text: renderLine(attribution.threadId, summarise(event)),
	};
}

// ── subscribe: one wrapper per run ──────────────────────────────────────────

/** The streaming surface `subscribe` needs: a run's own event fan-out. */
export interface SubscribableRun {
	readonly runId: string;
	/**
	 * The run's journal. Optional so an event can be observed without a run
	 * directory (a test, a host that only wants the line stream). When present
	 * only `tool` and `status` rows are written.
	 */
	readonly journal?: Pick<Journal, "append">;
	/** Register a listener for this run's runtime events. Returns the unsubscribe. */
	listen(listener: (event: EventLike) => void): () => void;
}

/** The run's line stream. */
export type EventSink = (line: EventLine) => void;

export interface SubscribeOptions {
	/**
	 * Applied to free text before it is journaled — README invariant 3. The
	 * caller passes `envRedactor`; the default touches nothing, because this
	 * module cannot know which values are secret.
	 */
	redact?: (text: string) => string;
	/** Injectable clock, so a test never waits on wall-clock time. */
	now?: () => number;
}

/** `tool_started` and `tool_done` are one tool call; this is the key joining them. */
function toolKey(attribution: Attribution, name: string): string {
	return `${attribution.threadId ?? "run"}\u0000${name}`;
}

/**
 * The journal row an event earns, if any.
 *
 * `message` and `message_updated` earn nothing: the thread store already holds
 * every message, and a journal that repeats it is a second transcript with a
 * different bug surface. `model_call` rows are the usage sink's (`models.ts`),
 * which is the only place that sees a nested prompt tool's calls.
 */
function rowFor(
	event: EventLike,
	attribution: Attribution,
	at: string,
	starts: Map<string, number>,
	now: () => number,
	redact: (text: string) => string,
): JournalRow | null {
	switch (event.type) {
		case "tool_started":
			starts.set(toolKey(attribution, event.name), now());
			return null;
		case "tool_done": {
			const key = toolKey(attribution, event.name);
			const started = starts.get(key);
			starts.delete(key);
			return {
				kind: "tool",
				at,
				name: event.name,
				status: event.status,
				...(started === undefined ? {} : { ms: Math.max(0, now() - started) }),
				...(event.error ? { summary: bound(redact(event.error)) } : {}),
			};
		}
		case "status":
			return {
				kind: "status",
				at,
				status: event.status?.state ?? "unknown",
				...(event.status?.reason ? { detail: bound(redact(event.status.reason)) } : {}),
			};
		case "subagent":
			// A children[] entry changing is a lifecycle marker for the parent, which
			// is what the `status` row kind is: the run started, failed, stopped, or
			// gained/lost a subagent.
			return {
				kind: "status",
				at,
				status: "subagent",
				detail: bound(redact(`${event.name} (${event.relationship}) -> ${event.status}`)),
			};
		default:
			return null;
	}
}

/**
 * Subscribe to one run: map, attribute, journal, then hand the line to `sink`.
 *
 * Returns the unsubscribe, which is what `session_shutdown` calls. A listener
 * runs inside the runtime's own execution loop, so both the journal write and
 * the sink call are contained: a closed journal or a broken UI must not end a
 * turn that is otherwise fine.
 */
export function subscribe(
	run: SubscribableRun,
	sink: EventSink,
	options: SubscribeOptions = {},
): () => void {
	const now = options.now ?? (() => Date.now());
	const redact = options.redact ?? ((text: string) => text);
	const starts = new Map<string, number>();

	return run.listen((event) => {
		const at = new Date(now()).toISOString();
		const attribution = attribute(event, run);

		const row = rowFor(event, attribution, at, starts, now, redact);
		if (row && run.journal) {
			try {
				run.journal.append(row);
			} catch {
				// A journal closed by `close()` is append-only and finished; the line
				// stream still has a job to do.
			}
		}

		try {
			sink(lineFor(event, run, at));
		} catch {
			// A sink that throws is a UI bug, never a reason to fail a run.
		}
	});
}

/**
 * Every subscription one session holds: one per run, closed together.
 *
 * The extension factory owns one of these and attaches each run as it opens, so
 * a session sees exactly the runs it started and `session_shutdown` leaves no
 * listener behind.
 */
export class RunSubscriptions {
	private readonly unsubscribes = new Map<string, () => void>();
	private readonly sink: EventSink;
	private readonly options: SubscribeOptions;

	constructor(sink: EventSink, options: SubscribeOptions = {}) {
		this.sink = sink;
		this.options = options;
	}


	/** Subscribe a run once. A second call for the same run is a no-op. */
	attach(run: SubscribableRun): void {
		if (this.unsubscribes.has(run.runId)) return;
		this.unsubscribes.set(run.runId, subscribe(run, this.sink, this.options));
	}

	/** Close every subscription. Idempotent. */
	close(): void {
		for (const unsubscribe of this.unsubscribes.values()) {
			try {
				unsubscribe();
			} catch {
				// The runtime is going away too; a failed unsubscribe is not a failure.
			}
		}
		this.unsubscribes.clear();
	}
}

// ── the last few lines, for the renderer ────────────────────────────────────

/**
 * A bounded ring of live lines per run.
 *
 * The completion wake is a message, so it can only carry plain data: the last
 * lines are read from here when the wake is composed, with no polling timer and
 * no second subscription.
 */
export class LineLog {
	private readonly perRun = new Map<string, EventLine[]>();
	private readonly limit: number;

	constructor(limit = LIVE_LINE_LIMIT) {
		this.limit = Math.max(1, limit);
	}

	append(line: EventLine): void {
		const lines = this.perRun.get(line.runId) ?? [];
		lines.push(line);
		if (lines.length > this.limit) lines.splice(0, lines.length - this.limit);
		this.perRun.set(line.runId, lines);
	}

	/** Every line this run produced, bounded, or the last `limit` of them. */
	recent(runId: string, limit = RENDERED_LINE_LIMIT): readonly EventLine[] {
		const lines = this.perRun.get(runId) ?? [];
		if (limit >= lines.length) return lines.slice();
		return lines.slice(lines.length - Math.max(0, limit));
	}
}

// ── the run message and its renderer ────────────────────────────────────────

/**
 * `details` of the completion wake, and of every live line's parent message.
 *
 * Everything but `runId` is optional: a wake composed by an older build, or by a
 * host that could not read the journal, still renders its header instead of an
 * empty block.
 */
export interface RunMessageDetails {
	runId: string;
	threadId?: string | null;
	agent?: string;
	phase?: string;
	revision?: string;
	/** Model turns the run has taken. */
	turns?: number;
	usage?: JournalTotal;
	/** The last lines the run produced, newest last. */
	lines?: readonly EventLine[];
}

/**
 * The header: what the run is and what it cost. Unknown is stated, not zeroed —
 * `cost unknown` is the honest line for providers that report no price, and
 * `partial` marks a total that is a floor.
 */
export function formatRunHeader(details: RunMessageDetails | undefined): string {
	const parts = [`standard-agent ${details?.runId ?? "run"}`];
	if (details?.phase) parts.push(details.phase);
	if (details?.agent) parts.push(details.agent);
	if (details?.revision) parts.push(`rev ${details.revision}`);
	if (typeof details?.turns === "number") parts.push(`${details.turns} turn(s)`);
	if (details?.usage) {
		parts.push(`${details.usage.totalTokens} tokens`);
		parts.push(details.usage.cost === null ? "cost unknown" : `$${details.usage.cost.toFixed(4)}`);
		if (details.usage.partial) parts.push("partial");
	}
	return bound(parts.join(" · "));
}

/** Header plus the last lines, as plain text: what the renderer draws when expanded. */
export function formatRunMessage(
	details: RunMessageDetails | undefined,
	limit = RENDERED_LINE_LIMIT,
): string[] {
	const lines = [formatRunHeader(details)];
	for (const line of (details?.lines ?? []).slice(-Math.max(0, limit))) lines.push(line.text);
	return lines;
}

/** Cut one rendered line to the viewport, before any styling is applied. */
function fit(text: string, width: number): string {
	if (!Number.isFinite(width) || width <= 0) return text;
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * The renderer for `standard-agent-run`.
 *
 * Folded by default: a completion receipt is one line until the user asks. When
 * expanded it adds the last few live lines, which is the whole "what happened"
 * answer without a second command. Colour comes from PI's theme, and the width
 * cut happens on plain text first, so a styled line never loses its reset.
 */
export function runMessageRenderer(): MessageRenderer<RunMessageDetails> {
	return (message, options, theme) => {
		const details = message.details;
		const header = formatRunHeader(details);
		const body = formatRunMessage(details).slice(1);
		return {
			render(width: number): readonly string[] {
				const out = [theme.bold(fit(header, width))];
				if (!options.expanded) {
					const hint = options.keyHint("app.tools.expand", "to expand");
					if (body.length > 0) out.push(theme.fg("muted", fit(hint, width)));
					return out;
				}
				for (const line of body) out.push(theme.fg("muted", fit(line, width)));
				return out;
			},
			invalidate() {
				// Nothing is cached: the lines are derived from the message on every render.
			},
		};
	};
}

// ── /sa ─────────────────────────────────────────────────────────────────────

/** One run as the command reports it: what is on disk plus the journal's totals. */
export interface RunReport {
	runId: string;
	revision: string;
	phase: string;
	threads: number;
	usage: JournalTotal;
}

/** What `/sa runs` prints: id, revision, phase, threads, tokens. */
export function formatRunList(reports: readonly RunReport[]): string[] {
	if (reports.length === 0) return [`No runs in ${RUNS_LABEL}`];
	return reports.map((report) =>
		bound(
			`${report.runId} ${report.revision} ${report.phase} ${report.threads} thread(s) ` +
				`${report.usage.totalTokens} tokens${report.usage.partial ? " (partial)" : ""}`,
		),
	);
}

/**
 * What `/sa cost` prints: the U03 total per run.
 *
 * `partial` is the difference between a floor and a total — a run whose journal
 * has a `model_call` row with no usage reports the sum of the rows that did
 * report, marked. Printing a number without that mark would claim a total
 * nobody measured.
 */
export function formatCost(reports: readonly RunReport[]): string[] {
	if (reports.length === 0) return [`No runs in ${RUNS_LABEL}`];
	return reports.map((report) => {
		const { usage } = report;
		const cost = usage.cost === null ? "cost unknown" : `$${usage.cost.toFixed(4)}`;
		return bound(
			`${report.runId} ${usage.totalTokens} tokens over ${usage.calls} call(s) ${cost}` +
				`${usage.partial ? " partial" : ""}`,
		);
	});
}

/** What the command needs from the extension: disk reads and the run service. */
export interface StandardAgentCommandDeps {
	/** Every run under `.pi/standard-agents/runs`, with its journal total. */
	runs(): Promise<readonly RunReport[]>;
	/** Terminate a run's root threads; the runtime cascades to children. */
	stop(runId: string): Promise<{ terminated: string[] }>;
	/** Start streaming these runs' lines into the transcript (`--follow`). */
	follow?(runIds: readonly string[]): void;
}

/** Notify one line, or several, through PI's UI. */
function notify(ctx: ExtensionCommandContext, lines: readonly string[], type: "info" | "warning" | "error" = "info"): void {
	for (const line of lines) ctx.ui.notify(line, type);
}

/**
 * Register `/sa`: `runs`, `cost`, `stop <runId>`.
 *
 * No run needs to be open for any of them — `runs` and `cost` read the run
 * directories, and an unknown run is an answer ("No runs in …") rather than an
 * error. `--follow` is the only thing that ever asks PI for transcript lines.
 */
export function registerStandardAgentCommand(
	pi: ExtensionAPI,
	deps: StandardAgentCommandDeps,
): void {
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Standard Agents: runs | cost | stop <runId>. Add --follow to runs to stream live lines.",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
			const action = words[0] ?? "runs";
			const follow = words.includes("--follow");
			const targets = words.slice(1).filter((word) => !word.startsWith("--"));

			try {
				if (action === "runs") {
					const reports = await deps.runs();
					if (follow) deps.follow?.(targets.length > 0 ? targets : reports.map((run) => run.runId));
					notify(ctx, formatRunList(reports));
					return;
				}
				if (action === "cost") {
					notify(ctx, formatCost(await deps.runs()));
					return;
				}
				if (action === "stop") {
					const runId = targets[0];
					if (!runId) {
						notify(ctx, [`usage: /${COMMAND_NAME} stop <runId>`], "warning");
						return;
					}
					const stopped = await deps.stop(runId);
					notify(ctx, [
						stopped.terminated.length > 0
							? `terminated ${stopped.terminated.join(", ")}`
							: "no live root thread",
					]);
					return;
				}
				notify(ctx, [`Unknown /${COMMAND_NAME} action '${action}'. Try: runs, cost, stop <runId>`], "warning");
			} catch (error) {
				// A refusal from the run service is the answer, not a crash.
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, [`/${COMMAND_NAME} ${action} failed: ${message}`], "error");
			}
		},
	});
}
