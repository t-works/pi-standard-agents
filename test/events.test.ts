/**
 * Live events: one subscription per run, one bounded line per event.
 *
 * The four assertions are the four ways an event stream lies:
 *  - **Fan-out.** Two concurrent runs have two runtimes and two thread sets; a
 *    line delivered to run A must belong to A, whatever the thread says. This is
 *    why attribution reads `event.threadId` and the subscription's own run id
 *    instead of pairing events by timestamp or by `parentId`.
 *  - **Thread attribution.** A parent and its blocking child are two threads in
 *    one run, so every line has to name the thread that emitted it — and a
 *    `subagent` transition has to name the relationship the parent registered,
 *    because that is the only place the child's role is visible.
 *  - **A degraded runtime.** An event with no `threadId` (the field is only in
 *    the runtime from 0.2.1) still renders, labelled `run`: losing lines is worse
 *    than losing thread attribution.
 *  - **Unknown is not zero.** `/sa cost` on a journal with one row that reported
 *    no usage prints `partial`, and the tokens are the sum of the rows that did
 *    report — the U03 rule, seen through the command.
 *
 * Everything runs offline: a scripted provider, temp directories, and no PI
 * session. Nothing here waits on a timer except the two polls that need a live
 * turn to finish.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProviderFactory } from "@standardagents/spec";

import type { EventLike, EventLine, RunReport } from "../src/events.ts";
import {
	COMMAND_NAME,
	LINE_MESSAGE_TYPE,
	MAX_LINE_LENGTH,
	RUNS_LABEL,
	attribute,
	lineFor,
	subscribe,
	summarise,
} from "../src/events.ts";
import type { JournalRow } from "../src/journal.ts";
import extension, {
	COMPLETION_CUSTOM_TYPE,
	journalUsage,
	STANDARD_AGENT_TOOL_NAME,
} from "../src/extension.ts";
import type { ToolSpec, WorkflowSpec } from "../src/registry.ts";
import type { OpenRun } from "../src/runs.ts";
import { RunService } from "../src/runs.ts";
import type { FakePi, RecordedCommand } from "./fake-pi.ts";
import { createFakePi } from "./fake-pi.ts";
import { scriptedProvider } from "./scripted.ts";

// ── harness ─────────────────────────────────────────────────────────────────

async function tempRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-events-"));
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
async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${label}`);
}

/**
 * A lead that spawns one blocking helper at thread creation.
 *
 * `immediate` puts the child in the parent's registry entry before any side takes
 * a turn, so the run has two threads to attribute lines to without a model having
 * to decide anything.
 */
function delegationSpec(id: string, provider: ProviderFactory): WorkflowSpec {
	return {
		id,
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
						subagents: [{ agent: "worker", as: "helper", blocking: true, immediate: true }],
					},
					b: { human: true },
				},
			},
			{ name: "worker", sides: { a: { prompt: "worker" }, b: { human: true } } },
		],
	};
}

const NOTHING: readonly ToolSpec[] = [];

/** Subscribe to one run and keep every line it produces. */
function record(run: OpenRun, t: TestContext): EventLine[] {
	const lines: EventLine[] = [];
	const unsubscribe = subscribe(run, (line) => lines.push(line));
	t.after(() => unsubscribe());
	return lines;
}

/** The handler PI would run for `/sa`. */
function commandHandler(fakePi: FakePi, name: string): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	const command: RecordedCommand | undefined = fakePi.commands.find((entry) => entry.name === name);
	assert.ok(command, `the factory registers /${name}`);
	return (command.options as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> })
		.handler;
}

/** Replace the fake UI's `notify` with a recorder and hand back the lines. */
function notifications(fakePi: FakePi): string[] {
	const lines: string[] = [];
	(fakePi.ctx.ui as unknown as { notify: (message: string, type?: string) => void }).notify = (message) => {
		lines.push(message);
	};
	return lines;
}

/**
 * A run that emits whatever a test tells it to.
 *
 * This is how an older runtime is simulated: the listener is called with an event
 * object that simply has no `threadId`, which is exactly what 0.2.0 delivered.
 */
function syntheticRun(runId: string, options: { journal?: boolean } = {}): {
	run: { runId: string; journal?: { append: (row: JournalRow) => JournalRow }; listen: (listener: (event: EventLike) => void) => () => void };
	emit(event: EventLike): void;
	rows: JournalRow[];
	closed: () => boolean;
} {
	const listeners = new Set<(event: EventLike) => void>();
	const rows: JournalRow[] = [];
	let closed = false;
	const run = {
		runId,
		...(options.journal === false
			? {}
			: {
					journal: {
						append(row: JournalRow): JournalRow {
							rows.push(row);
							return row;
						},
					},
				}),
		listen(listener: (event: EventLike) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				closed = true;
			};
		},
	};
	return {
		run,
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
		rows,
		closed: () => closed,
	};
}

// ── 1. fan-out by run ───────────────────────────────────────────────────────

test("two concurrent runs, one child each: every line belongs to its own run", async (t) => {
	const root = await tempRoot(t);
	const service = new RunService({ cwd: root, store: { envKey: storeKey() }, tools: NOTHING });
	t.after(() => service.close());

	const runA = await service.create(
		delegationSpec("events-fanout-a", scriptedProvider([{ content: "answer-a" }])),
		{ cwd: root },
	);
	const runB = await service.create(
		delegationSpec("events-fanout-b", scriptedProvider([{ content: "answer-b" }])),
		{ cwd: root },
	);
	const linesA = record(runA, t);
	const linesB = record(runB, t);

	// Both runs are live at the same time: the fan-out has to hold while two
	// runtimes and four threads are emitting.
	await Promise.all([
		service.start(runA.runId, { agentId: "lead", message: "go a" }),
		service.start(runB.runId, { agentId: "lead", message: "go b" }),
	]);

	assert.ok(linesA.length > 0, "run A produced lines");
	assert.ok(linesB.length > 0, "run B produced lines");

	for (const line of linesA) assert.equal(line.runId, runA.runId, `line from A carried '${line.runId}'`);
	for (const line of linesB) assert.equal(line.runId, runB.runId, `line from B carried '${line.runId}'`);

	// Nothing crosses: not one thread id of B appears in A's stream, and not one
	// thread id of A appears in B's. Thread attribution is a lookup, so a crossing
	// would mean the lookup, not the runtime, was wrong.
	const threadsA = new Set(linesA.map((line) => line.threadId).filter((id): id is string => id !== null));
	const threadsB = new Set(linesB.map((line) => line.threadId).filter((id): id is string => id !== null));
	assert.ok(threadsA.size > 0 && threadsB.size > 0, "both runs attributed lines to a thread");
	for (const threadId of threadsA) assert.ok(!threadsB.has(threadId), `thread ${threadId} crossed into B`);
	for (const threadId of threadsB) assert.ok(!threadsA.has(threadId), `thread ${threadId} crossed into A`);

	// And the content itself never crosses.
	assert.ok(linesA.some((line) => line.text.includes("answer-a")), "A saw its own answer");
	assert.ok(linesB.some((line) => line.text.includes("answer-b")), "B saw its own answer");
	assert.ok(!linesA.some((line) => line.text.includes("answer-b")), "A never saw B's answer");
	assert.ok(!linesB.some((line) => line.text.includes("answer-a")), "B never saw A's answer");
});

// ── 2. thread attribution inside one run ────────────────────────────────────

test("two threads in one run: each line names the thread that emitted it, and subagent names the relationship", async (t) => {
	const root = await tempRoot(t);
	const service = new RunService({ cwd: root, store: { envKey: storeKey() }, tools: NOTHING });
	t.after(() => service.close());

	const run = await service.create(delegationSpec("events-threads", scriptedProvider([{ content: "lead done" }])), {
		cwd: root,
	});
	const lines = record(run, t);

	const lead = await service.start(run.runId, { agentId: "lead", message: "delegate this" });
	const started = await service.status(run.runId);
	const child = started.threads.find((thread) => thread.parentId === lead.threadId);
	assert.ok(child, "the immediate blocking child exists as a thread of its own");
	assert.equal(child.blocking, true);

	// A blocking child is a subagent: the runtime reported it while creating it,
	// attributed to the parent whose `children[]` entry changed.
	const transition = lines.find((line) => line.type === "subagent");
	assert.ok(transition, "the subagent transition was delivered");
	assert.equal(transition.threadId, lead.threadId, "a subagent entry belongs to the parent thread");
	assert.match(transition.text, /helper/, "the line names the relationship the parent declared");

	// Give the child a turn of its own, so the run has two emitting threads.
	await service.post(run.runId, child.threadId, "start the work");
	await until(
		() => lines.some((line) => line.threadId === child.threadId && line.type === "message"),
		"a line attributed to the child thread",
	);

	const seen = new Set(lines.map((line) => line.threadId).filter((id): id is string => id !== null));
	assert.ok(seen.has(lead.threadId), "the parent emitted lines");
	assert.ok(seen.has(child.threadId), "the child emitted lines, attributed to itself");

	// Every thread a line names is a thread of this run: no parentId guessing, no
	// first-seen-thread fallback.
	const ended = await service.status(run.runId);
	const known = new Set(ended.threads.map((thread) => thread.threadId));
	for (const line of lines) {
		if (line.threadId === null) continue;
		assert.ok(known.has(line.threadId), `line named '${line.threadId}', which is not a thread of this run`);
	}
});

// ── 3. an event without threadId degrades, it does not vanish ───────────────

test("an event without threadId still renders, labelled 'run', and only tool/status rows reach the journal", (t) => {
	const fake = syntheticRun("run-older-runtime");
	const lines: EventLine[] = [];
	const unsubscribe = subscribe(fake.run, (line) => lines.push(line));
	t.after(() => unsubscribe());

	// Exactly what an older runtime delivered: no `threadId` field at all.
	fake.emit({ type: "log", level: "warn", message: "tool output was truncated" });
	fake.emit({ type: "status", status: { state: "running" } } as EventLike);
	fake.emit({ type: "tool_started", name: "read" } as EventLike);
	fake.emit({ type: "tool_done", name: "read", status: "success" } as EventLike);

	assert.equal(lines.length, 4, "every event still produced a line");
	for (const line of lines) assert.equal(line.threadId, null, "no thread to attribute to");
	assert.match(lines[0]?.text ?? "", /^\[run\] /, "the line says its attribution is run-level");
	assert.ok((lines[0]?.text ?? "").includes("tool output was truncated"), "the log message passes through");
	assert.match(lines[2]?.text ?? "", /tool read started/);
	assert.match(lines[3]?.text ?? "", /tool read success/);

	// Attribution is a lookup: a thread id that is there is used verbatim, and the
	// run always comes from the subscription.
	assert.deepEqual(attribute({ type: "error", threadId: "th_1", message: "boom" }, { runId: "run-x" }), {
		runId: "run-x",
		threadId: "th_1",
	});
	assert.deepEqual(attribute({ type: "error", message: "boom" } as EventLike, { runId: "run-x" }), {
		runId: "run-x",
		threadId: null,
	});

	// Journaling is the allowlist, not the stream: the log line and the tool's
	// start are not rows, the tool's end and the status are.
	assert.deepEqual(
		fake.rows.map((row) => (row.kind === "tool" ? `${row.kind}:${row.name}:${row.status}` : `${row.kind}:${row.kind === "status" ? row.status : ""}`)),
		["status:running", "tool:read:success"],
		"no message/log rows: the thread store already holds the transcript",
	);

	// A line is bounded, whatever the event carries — a 400-character error is one
	// line in a terminal, not five.
	const huge = summarise({
		type: "error",
		threadId: "th_1",
		message: "x".repeat(400),
	} as EventLike);
	assert.ok(huge.length <= MAX_LINE_LENGTH, `summarise returned ${huge.length} characters`);
	assert.ok(
		lineFor({ type: "error", threadId: "th_1", message: "y".repeat(400) } as EventLike, { runId: "run-x" }).text
			.length <= MAX_LINE_LENGTH,
		"the rendered line is bounded too",
	);
});

// ── 4. /sa cost: a partial total is marked ──────────────────────────────────

test("/sa cost sums the rows that reported and marks the total partial; /sa runs works with no run", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const service = new RunService({ cwd: root, store: { envKey: key } });
	t.after(() => service.close());

	const run = await service.create(delegationSpec("events-cost", scriptedProvider([{ content: "x" }])), { cwd: root });
	const at = new Date().toISOString();
	// One measured call and one provider that reported nothing at all: the case the
	// journal refuses to record as free.
	run.journal.append({
		kind: "model_call",
		at,
		model: "scripted-1",
		startedAt: at,
		ms: 3,
		usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100, cost: 0.002 },
		finishReason: "stop",
	});
	run.journal.append({
		kind: "model_call",
		at,
		model: "scripted-1",
		startedAt: at,
		ms: 1,
		usage: null,
		finishReason: "stop",
	});

	const fakePi = createFakePi();
	await extension(fakePi.api, { cwd: root, store: { envKey: key } });
	t.after(async () => {
		for (const handler of fakePi.handlersFor("session_shutdown")) await handler.handler();
	});
	const notified = notifications(fakePi);

	await commandHandler(fakePi, COMMAND_NAME)("cost", fakePi.ctx as unknown as ExtensionCommandContext);

	const costText = notified.join("\n");
	assert.match(costText, /partial/, "a total built from an unmeasured call is marked");
	assert.match(costText, /100 tokens/, "the number is the sum of the rows that did report");
	assert.match(costText, new RegExp(run.runId), "the line names the run");
	assert.match(costText, /2 call\(s\)/, "both calls are counted, measured or not");

	notified.length = 0;
	await commandHandler(fakePi, COMMAND_NAME)("runs", fakePi.ctx as unknown as ExtensionCommandContext);
	assert.ok(notified.length > 0);
	assert.match(notified[0] ?? "", new RegExp(`^${run.runId} ${run.revision} `), "id, revision, then the rest");
	// No turn was ever taken here, so the run really has no threads: the count is
	// read from the records, not assumed to be one.
	assert.match(notified[0] ?? "", / 0 thread\(s\) /, "threads are counted from the records");

	// The command works with no active run at all: a fresh cwd has no runs tree.
	const empty = createFakePi();
	await extension(empty.api, { cwd: await tempRoot(t), store: { envKey: key } });
	t.after(async () => {
		for (const handler of empty.handlersFor("session_shutdown")) await handler.handler();
	});
	const emptyLines = notifications(empty);
	await commandHandler(empty, COMMAND_NAME)("runs", empty.ctx as unknown as ExtensionCommandContext);
	assert.deepEqual(emptyLines, [`No runs in ${RUNS_LABEL}`], "an empty tree is an answer, not an error");

	emptyLines.length = 0;
	await commandHandler(empty, COMMAND_NAME)("cost", empty.ctx as unknown as ExtensionCommandContext);
	assert.deepEqual(emptyLines, [`No runs in ${RUNS_LABEL}`], "cost answers the same way");

	// And the tool is still registered next to the command: this unit adds a view,
	// it does not replace the surface.
	assert.ok(fakePi.tools.some((tool) => tool.name === STANDARD_AGENT_TOOL_NAME));
});

// ── the run list source the command reads ───────────────────────────────────

test("the cost figure comes from the journal on disk, not from memory", async (t) => {
	const root = await tempRoot(t);
	const key = storeKey();
	const service = new RunService({ cwd: root, store: { envKey: key } });
	t.after(() => service.close());
	const run = await service.create(delegationSpec("events-disk", scriptedProvider([{ content: "x" }])), {
		cwd: root,
	});
	const at = new Date().toISOString();
	run.journal.append({
		kind: "model_call",
		at,
		model: "scripted-1",
		startedAt: at,
		ms: 1,
		usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
		finishReason: "stop",
	});

	// A run opened by another process has no in-memory journal here: the file is
	// the only honest source, and `/sa` reports it that way.
	const reported: RunReport = {
		runId: run.runId,
		revision: run.revision,
		phase: "idle",
		threads: 0,
		usage: journalUsage(run.runDir),
	};
	assert.equal(reported.usage.totalTokens, 3);
	assert.equal(reported.usage.partial, false);
	assert.equal(reported.usage.cost, null, "no provider reported a price, so none is invented");
});

// ── the transcript rule: lines are opt-in, the wake is not ───────────────────

test("a run's lines stay out of the transcript until the run speaks, then follow", async (t) => {
	const root = await tempRoot(t);
	await mkdir(join(root, "examples"), { recursive: true });
	await writeFile(
		join(root, "examples", "events-live.json"),
		`${JSON.stringify(
			{
				id: "events-live",
				models: [{ name: "scripted", model: "scripted-1" }],
				prompts: [
					{
						name: "assistant",
						toolDescription: "Answer the user",
						prompt: "You are the assistant.",
						model: "scripted",
						includeChat: true,
					},
				],
				agents: [{ name: "assistant", sides: { a: { prompt: "assistant" }, b: { human: true } } }],
			},
			null,
			"\t",
		)}
`,
		"utf8",
	);

	const fakePi = createFakePi();
	await extension(fakePi.api, {
		cwd: root,
		store: { envKey: storeKey() },
		providers: {
			scripted: scriptedProvider([
				{ content: "first answer", usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 } },
			]),
		},
	});
	t.after(async () => {
		for (const handler of fakePi.handlersFor("session_shutdown")) await handler.handler();
	});
	// The subscription window opens on `session_start`, exactly as PI opens it.
	for (const handler of fakePi.handlersFor("session_start")) await handler.handler();

	const tool = fakePi.tools.find((candidate) => candidate.name === STANDARD_AGENT_TOOL_NAME);
	assert.ok(tool, "the run tool is registered next to the command");
	const started = (await tool.execute(
		"call-1",
		{ action: "start", workflow: "events-live", task: "go" },
		undefined,
		undefined,
		fakePi.ctx,
	)) as { details: { runId: string; threadId: string } };
	const { runId, threadId } = started.details;

	const customTypes = (): string[] =>
		fakePi.messages.map((message) => (message.message as { customType?: string }).customType ?? "");

	await until(() => customTypes().includes(COMPLETION_CUSTOM_TYPE), "the completion wake");
	const wake = fakePi.messages
		.map((message) => message.message as { customType?: string; details?: { lines?: EventLine[] } })
		.find((message) => message.customType === COMPLETION_CUSTOM_TYPE);
	assert.ok(wake, "the wake was sent");
	const wakeLines = wake.details?.lines ?? [];
	assert.ok(wakeLines.length > 0, "the wake carries the last lines the run produced");
	for (const line of wakeLines) assert.equal(line.runId, runId, "the wake's lines belong to its own run");

	// The wake put the run on screen, so what happens next is visible; `/sa runs
	// --follow` is the other way to ask, and it reports the run it followed.
	const notified = notifications(fakePi);
	await commandHandler(fakePi, COMMAND_NAME)(
		`runs --follow ${runId}`,
		fakePi.ctx as unknown as ExtensionCommandContext,
	);
	assert.ok(
		notified.some((line) => line.includes(runId)),
		"the command reported the run it is now following",
	);

	await tool.execute("call-2", { action: "message", runId, threadId, text: "one more" }, undefined, undefined, fakePi.ctx);
	await until(() => customTypes().includes(LINE_MESSAGE_TYPE), "a live line on the followed run");

	const live = fakePi.messages
		.map((message) => message.message as { customType?: string; content?: string })
		.filter((message) => message.customType === LINE_MESSAGE_TYPE);
	for (const line of live) assert.match(line.content ?? "", /^\[(?:run|[^\]]+)\] /, "a line is one labelled line");
});
