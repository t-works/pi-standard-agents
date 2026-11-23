/**
 * One append-only JSONL file per run: the only place token counts, costs and
 * tool steps survive the turn.
 *
 * Why a file of our own rather than `messages.json`: the runtime persists usage
 * only for the messages it writes. Traffic inside a nested prompt tool stays in
 * memory (`runSubPrompt`'s shortcut comment), so a store reader silently
 * undercounts — exactly the calls a cheap prompt tool makes. The decorator in
 * `models.ts` sees them, and this is where they land.
 *
 * Two rules hold the file honest:
 *  - Append-only, one JSON object per line, `fs.appendFileSync` with `flag: "a"`.
 *    A crash mid-run leaves every earlier row readable; nothing is ever rewritten.
 *  - Unknown is not zero. A provider that reports no `usage` gets `usage: null`
 *    and a run total marked `partial`, because "we did not measure it" and "it
 *    was free" are different facts. Same for `cost`, which is provider-reported
 *    and frequently absent.
 *
 * Redaction is the caller's duty (the README's invariant 3): `append` writes what
 * it is given, and the row fields are an allowlist — request bodies carry prompts
 * and interpolated secrets, so they never reach a row. `envRedactor` is the shared
 * rule for the strings a caller does want to journal (a tool summary, an error).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ProviderUsage } from "@standardagents/spec";

import type { ModelCall, UsageSink } from "./models.ts";

/** Row kinds a run can contain. Anything else is a caller bug, not a new kind. */
export type JournalRowKind = "model_call" | "tool" | "status" | "usage_total";

/** One measured model call: exactly what {@link withUsage} hands the sink. */
export interface ModelCallRow extends ModelCall {
	kind: "model_call";
	/** When the row was written (ISO 8601). */
	at: string;
}

/** One tool step, as the caller summarised it. */
export interface ToolRow {
	kind: "tool";
	at: string;
	/** Tool name the model called. */
	name: string;
	status: "success" | "error";
	/** Wall-clock duration, when the caller measured one. */
	ms?: number;
	/** One-line, already-redacted summary of the result. */
	summary?: string;
}

/** A lifecycle marker: run started, turn failed, journal closed. */
export interface StatusRow {
	kind: "status";
	at: string;
	/** Short machine-readable status, e.g. `running` or `failed`. */
	status: string;
	/** Already-redacted detail. */
	detail?: string;
}

/** The per-run aggregate, written by {@link Journal.close}. */
export interface UsageTotalRow {
	kind: "usage_total";
	at: string;
	/** Model calls the total covers. */
	calls: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Sum of the costs providers reported, or `null` when none did. */
	cost: number | null;
	/** True when at least one call reported no usage, so the numbers are a floor. */
	partial: boolean;
}

/** One line of `journal.jsonl`. */
export type JournalRow = ModelCallRow | ToolRow | StatusRow | UsageTotalRow;

/** What {@link Journal.total} returns: the same numbers {@link UsageTotalRow} writes. */
export type JournalTotal = Omit<UsageTotalRow, "kind" | "at">;

export interface OpenJournalOptions {
	/** File name inside `runDir`. Defaults to `journal.jsonl`. */
	fileName?: string;
}

export interface Journal {
	/** Absolute path of the JSONL file. */
	readonly path: string;
	/** Append one row. Returns the row so a caller can log what it wrote. */
	append(row: JournalRow): JournalRow;
	/** Aggregate over the `model_call` rows appended so far. */
	total(): JournalTotal;
	/**
	 * Sink for `withUsage(factory, journal.modelCallSink())`: stamps the call with
	 * `kind` and `at` and appends it. No request or response body is recorded.
	 */
	modelCallSink(): UsageSink;
	/** Append the `usage_total` row and return the same aggregate. Idempotent. */
	close(): JournalTotal;
}

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Aggregate `model_call` rows into the numbers a run is judged by.
 *
 * `cost` stays `null` when no row reported one; when some did, it is their sum —
 * not `null`, and never a zero standing in for an unknown price. `partial` says
 * whether any call went unmeasured.
 */
function totalOf(rows: readonly ModelCallRow[]): JournalTotal {
	let promptTokens = 0;
	let completionTokens = 0;
	let totalTokens = 0;
	let cost: number | null = null;
	let partial = false;

	for (const row of rows) {
		if (!row.usage) {
			partial = true;
			continue;
		}
		promptTokens += row.usage.promptTokens;
		completionTokens += row.usage.completionTokens;
		totalTokens += row.usage.totalTokens;
		if (typeof row.usage.cost === "number" && Number.isFinite(row.usage.cost)) {
			cost = (cost ?? 0) + row.usage.cost;
		}
	}

	return { calls: rows.length, promptTokens, completionTokens, totalTokens, cost, partial };
}

/**
 * Open the journal for one run directory, creating it when missing.
 *
 * The file is created lazily on the first append, so a run that never calls a
 * model leaves no empty file behind.
 */
export function openJournal(runDir: string, options: OpenJournalOptions = {}): Journal {
	mkdirSync(runDir, { recursive: true });
	const path = join(runDir, options.fileName ?? "journal.jsonl");
	const calls: ModelCallRow[] = [];
	let closed = false;

	const journal: Journal = {
		path,

		append(row) {
			if (closed) throw new Error(`Journal '${path}' is closed; rows are append-only per run`);
			appendFileSync(path, `${JSON.stringify(row)}\n`, { flag: "a", encoding: "utf8" });
			if (row.kind === "model_call") calls.push(row);
			return row;
		},

		total() {
			return totalOf(calls);
		},

		modelCallSink() {
			return (call: ModelCall) => {
				journal.append({ kind: "model_call", at: nowIso(), ...call });
			};
		},

		close() {
			const total = journal.total();
			if (!closed) {
				closed = true;
				appendFileSync(path, `${JSON.stringify({ kind: "usage_total", at: nowIso(), ...total })}\n`, {
					flag: "a",
					encoding: "utf8",
				});
			}
			return total;
		},
	};

	return journal;
}

/**
 * Build the redactor a caller applies before journaling free text.
 *
 * Every present value becomes `[redacted:NAME]`, longest value first so a secret
 * that contains another secret cannot half-survive. Names are the caller's, so
 * the journal never has to guess which environment values are secret.
 */
export function envRedactor(
	names: readonly string[],
	lookup: (name: string) => string | undefined,
): (text: string) => string {
	const secrets = names
		.map((name) => [name, lookup(name)] as const)
		.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
		.sort((left, right) => right[1].length - left[1].length);

	return (text) =>
		secrets.reduce(
			(redacted, [name, value]) => redacted.split(value).join(`[redacted:${name}]`),
			text,
		);
}

/** Type guard for reading a `journal.jsonl` back in a test or a report. */
export function isModelCallRow(row: JournalRow): row is ModelCallRow {
	return row.kind === "model_call";
}

/** Re-exported so a caller can type a usage row without importing the spec. */
export type { ProviderUsage };
