/**
 * Models come from PI, usage comes from every call.
 *
 * The point of this file is one gap: the runtime persists `metadata.usage` only
 * for the messages it writes, and a nested prompt tool's traffic stays in memory
 * (`runSubPrompt`'s shortcut). So a store reader undercounts and the decorator
 * does not — four `model_call` rows against three persisted usage blocks is the
 * assertion that proves it, with a scripted provider and no network.
 *
 * The rest is the discipline that makes those numbers trustworthy: totals are
 * sums of what was reported, an unreported call stays `unknown` (never zero), and
 * a secret a tool echoed is redacted before it reaches the file.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Context as PiContext, Model as PiModel } from "@earendil-works/pi-ai";
import { Runtime } from "@t-works/standardagents-runtime";
import { ThreadStore } from "@t-works/standardagents-runtime/store";
import type { Message, ProviderRequest, ProviderUsage } from "@standardagents/spec";

import type { JournalRow, ModelCallRow } from "../src/journal.ts";
import { envRedactor, isModelCallRow, openJournal } from "../src/journal.ts";
import type { ModelCall } from "../src/models.ts";
import { piModel, PI_RESOLVED_API_KEY, withUsage } from "../src/models.ts";
import type { ToolSpec, WorkflowSpec } from "../src/registry.ts";
import { buildRegistry } from "../src/registry.ts";
import { scriptedProvider, type ScriptedReply } from "./scripted.ts";

/** The environment name whose value the `echo` tool leaks into its result. */
const SECRET_ENV = "API_TOKEN";
/** Stand-in secret. Not a key: nothing here talks to a provider. */
const SECRET = "tok-echo-3f9c2b7d-not-a-real-credential";

/** Reported usage with a distinct token total, so a sum identifies its rows. */
function usageOf(promptTokens: number, completionTokens: number, cost?: number): ProviderUsage {
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		...(cost === undefined ? {} : { cost }),
	};
}

function tokenSum(usages: readonly ProviderUsage[]): number {
	return usages.reduce((sum, usage) => sum + usage.totalTokens, 0);
}

/** A store in a throwaway directory, with a per-run key so no user key file is touched. */
async function tempStore(t: TestContext): Promise<{ store: ThreadStore; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-usage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, store: new ThreadStore(root, { envKey: randomBytes(32).toString("hex") }) };
}

/**
 * The workflow the gap is measured on: one prompt with two tool steps — a
 * function tool and a prompt tool — plus the nested loop behind the prompt tool.
 */
function usageSpec(script: readonly ScriptedReply[], journal: ReturnType<typeof openJournal>): WorkflowSpec {
	const redact = envRedactor([SECRET_ENV], (name) => process.env[name]);

	const echo: ToolSpec = {
		name: "echo",
		description: "Echo the deployment token from the environment back to the caller.",
		args: null,
		async execute() {
			const started = performance.now();
			const value = process.env[SECRET_ENV] ?? "";
			journal.append({
				kind: "tool",
				at: new Date().toISOString(),
				name: "echo",
				status: "success",
				ms: Math.round(performance.now() - started),
				// Redaction is the caller's duty: the journal writes what it is handed.
				summary: redact(`token=${value}`),
			});
			return `token=${value}`;
		},
	};

	return {
		id: "usage-turn",
		models: [{ name: "scripted", model: "scripted-1", provider: scriptedProvider(script) }],
		prompts: [
			{
				name: "assistant",
				prompt: "You are the assistant. Reply briefly.",
				model: "scripted",
				includeChat: true,
				tools: ["echo", "review"],
			},
			{
				name: "review",
				prompt: "You review one change and say what you think.",
				model: "scripted",
				toolDescription: "Review the current change.",
			},
		],
		tools: [echo],
		agents: [{ name: "assistant", sides: { a: { prompt: "assistant" }, b: { human: true } } }],
	};
}

/** Drive one turn through the decorated registry and hand back the journal file. */
async function runTurn(
	t: TestContext,
	script: readonly ScriptedReply[],
): Promise<{ journal: ReturnType<typeof openJournal>; rows: JournalRow[]; total: ReturnType<ReturnType<typeof openJournal>["total"]>; threadId: string; store: ThreadStore }> {
	const { store, root } = await tempStore(t);
	const journal = openJournal(join(root, "run-1"));

	const { registry } = buildRegistry(usageSpec(script, journal), {
		// Every model is wrapped here, once, so the nested prompt tool's provider is
		// the same measured object as the agent's own.
		decorate: (factory) => withUsage(factory, journal.modelCallSink()),
	});

	const runtime = new Runtime({ registry, store });
	const thread = await runtime.createThread({ agentId: "assistant" });
	await thread.queueMessage({ role: "user", content: "what changed?" }, { trigger: false });
	await runtime.start(thread, "a");
	await runtime.settle();

	const total = journal.close();
	const rows = (await readFile(journal.path, "utf8"))
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as JournalRow);
	return { journal, rows, total, threadId: thread.threadId, store };
}

test("four model calls are journaled while the store holds usage for three", async (t) => {
	// Call order: main step 1 (echo), main step 2 (review), the nested review loop,
	// main step 3 (final answer). The nested call is the one no message records.
	const script: ScriptedReply[] = [
		{ toolCalls: [{ id: "call_echo", name: "echo", arguments: {} }], usage: usageOf(10, 5, 0.01) },
		{ toolCalls: [{ id: "call_review", name: "review", arguments: {} }], usage: usageOf(20, 6, 0.02) },
		{ content: "review: nothing alarming", usage: usageOf(30, 7, 0.04) },
		{ content: "done", usage: usageOf(40, 8) },
	];
	const { rows, total, threadId, store } = await runTurn(t, script);

	const calls = rows.filter(isModelCallRow);
	assert.equal(calls.length, 4, "one row per model call, nested prompt tools included");

	const persisted = JSON.parse(await readFile(store.messagesPath(threadId), "utf8")) as Message[];
	const persistedUsage = persisted
		.map((message) => message.metadata?.usage)
		.filter((usage): usage is ProviderUsage => Boolean(usage));
	assert.equal(persistedUsage.length, 3, "the store only sees the messages the runtime writes");

	const nested = calls[2] as ModelCallRow;
	assert.equal(nested.usage?.totalTokens, 37, "the third call is the nested prompt tool's");
	assert.equal(
		persistedUsage.some((usage) => usage.totalTokens === 37),
		false,
		"the nested call's usage never reaches messages.json",
	);

	// The journal is the store's rows plus exactly the nested one: nothing invented,
	// nothing double-counted.
	const notNested = calls.filter((row) => row !== nested);
	assert.equal(
		tokenSum(persistedUsage),
		tokenSum(notNested.map((row) => row.usage!).filter(Boolean)),
		"the persisted rows are the journal rows minus the nested call",
	);
	assert.equal(calls.length, persistedUsage.length + 1);

	assert.equal(total.calls, 4);
	assert.equal(total.totalTokens, tokenSum(calls.map((row) => row.usage!).filter(Boolean)));
	assert.equal(total.totalTokens, 15 + 26 + 37 + 48);
	assert.ok(total.totalTokens > tokenSum(persistedUsage), "a store reader undercounts by the nested call");
	assert.equal(total.promptTokens, 10 + 20 + 30 + 40);
	assert.equal(total.completionTokens, 5 + 6 + 7 + 8);

	// Cost is provider-reported: three rows reported one, the last did not.
	const costRows = calls.filter((row) => typeof row.usage?.cost === "number");
	assert.equal(costRows.length, 3);
	assert.ok(total.cost !== null);
	assert.ok(Math.abs(total.cost - 0.07) < 1e-12, "cost is the sum of the rows that reported it");
	assert.equal(total.partial, false, "every call reported usage");

	// Row fields are the allowlist: no request, no response, no prompt.
	for (const row of calls) {
		assert.deepEqual(Object.keys(row).sort(), [
			"at",
			"finishReason",
			"kind",
			"model",
			"ms",
			"startedAt",
			"usage",
		]);
		assert.equal(row.model, "scripted-1");
		assert.ok(Number.isFinite(row.ms) && row.ms >= 0);
	}
	assert.deepEqual(
		calls.map((row) => row.finishReason),
		["tool_calls", "tool_calls", "stop", "stop"],
	);

	const totals = rows.filter((row) => row.kind === "usage_total");
	assert.equal(totals.length, 1, "close() writes exactly one run total");
	assert.deepEqual({ ...totals[0], at: "" }, { ...total, kind: "usage_total", at: "" });
});

test("a secret a tool echoed is redacted in the file, and present nowhere verbatim", async (t) => {
	process.env[SECRET_ENV] = SECRET;
	t.after(() => {
		delete process.env[SECRET_ENV];
	});

	const script: ScriptedReply[] = [
		{ toolCalls: [{ id: "call_echo", name: "echo", arguments: {} }], usage: usageOf(10, 5) },
		{ content: "done", usage: usageOf(5, 2) },
	];
	const { journal, rows } = await runTurn(t, script);

	const text = await readFile(journal.path, "utf8");
	assert.equal(text.includes(SECRET), false, "the secret never reaches journal.jsonl");
	assert.match(text, /\[redacted:API_TOKEN\]/, "the tool summary carries the marker instead");

	const tools = rows.filter((row) => row.kind === "tool");
	assert.equal(tools.length, 1);
	assert.match(String(tools[0]?.summary), /^token=\[redacted:API_TOKEN\]$/);
});

test("a provider that reports no usage leaves the row unknown and the total partial", async (t) => {
	const script: ScriptedReply[] = [
		{ toolCalls: [{ id: "call_echo", name: "echo", arguments: {} }], usage: usageOf(10, 5, 0.01) },
		// The second answer reports nothing at all: no tokens, no cost.
		{ content: "done", usage: null },
	];
	const { rows, total } = await runTurn(t, script);

	const calls = rows.filter(isModelCallRow);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.usage?.totalTokens, 15);
	assert.equal(calls[1]?.usage, null, "an unreported call is recorded as unknown, not as zero");
	assert.equal(calls[1]?.finishReason, "stop");

	assert.equal(total.calls, 2);
	assert.equal(total.totalTokens, 15, "the total sums what was measured and no more");
	assert.equal(total.cost, 0.01);
	assert.equal(total.partial, true, "a run with an unmeasured call says so");

	const written = rows.filter((row) => row.kind === "usage_total");
	assert.equal(written.length, 1);
	assert.equal(written[0]?.partial, true);
});

test("piModel resolves the model through PI's registry and maps the answer back", async (t) => {
	const piModelInfo = {
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	} as unknown as PiModel<never>;

	let seen: PiContext | undefined;
	const registry = {
		find: (provider: string, id: string) =>
			provider === piModelInfo.provider && id === piModelInfo.id ? piModelInfo : undefined,
		getAll: () => [piModelInfo],
		complete: async (_model: PiModel<never>, context: PiContext) => {
			seen = context;
			return {
				role: "assistant",
				content: [{ type: "text", text: "the answer" }],
				api: piModelInfo.api,
				provider: piModelInfo.provider,
				model: piModelInfo.id,
				usage: {
					input: 11,
					output: 4,
					cacheRead: 2,
					cacheWrite: 0,
					reasoning: 3,
					totalTokens: 17,
					cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3, totalFromProvider: true },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		},
	};

	const definition = piModel(
		{ modelRegistry: registry as unknown as ModelRegistry },
		{ name: "planner", model: "anthropic/claude-sonnet-4", configSlots: { baseUrl: { type: "url" } } },
	);

	assert.equal(definition.name, "planner");
	assert.equal(definition.model, "anthropic/claude-sonnet-4");

	const factory = definition.provider as unknown as ReturnType<typeof withUsage>;
	assert.equal(
		factory.configSlots?.apiKey?.default,
		PI_RESOLVED_API_KEY,
		"the apiKey slot keeps Runtime.providerFor out of its env-guessing path",
	);
	assert.ok(factory.configSlots?.baseUrl, "caller slots survive alongside the placeholder");

	const calls: ModelCall[] = [];
	const decorated = withUsage(factory, (call) => calls.push(call));
	assert.equal(decorated.configSlots?.apiKey?.default, PI_RESOLVED_API_KEY, "withUsage preserves configSlots");
	assert.equal(decorated.name, "planner", "the factory keeps its name for the runtime's messages");

	const provider = decorated({ apiKey: PI_RESOLVED_API_KEY });
	const response = await provider.generate({
		model: "claude-sonnet-4",
		messages: [
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
			{ role: "tool", toolCallId: "c1", toolName: "echo", content: "hi back" },
		],
		tools: [{ type: "function", function: { name: "echo", description: "Echo the input." } }],
	});

	assert.ok(seen, "the registry was the one that ran the model");
	assert.equal(seen.systemPrompt, "be brief", "the system prompt travels on PI's context");
	assert.deepEqual(
		seen.messages.map((message) => message.role),
		["user", "assistant", "toolResult"],
	);
	assert.deepEqual(seen.tools?.map((tool) => tool.name), ["echo"]);

	assert.equal(response.content, "the answer");
	assert.equal(response.finishReason, "stop");
	assert.deepEqual(response.usage, {
		promptTokens: 11,
		completionTokens: 4,
		totalTokens: 17,
		reasoningTokens: 3,
		cachedTokens: 2,
		cost: 0.3,
	});

	assert.equal(calls.length, 1, "the decorator measured the PI-backed provider too");
	assert.equal(calls[0]?.model, "claude-sonnet-4");
	assert.deepEqual(calls[0]?.usage, response.usage);

	// The slot seam: a runtime builds this provider without any environment key.
	const savedKey = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	t.after(() => {
		if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
	});

	const { store } = await tempStore(t);
	const { registry: built } = buildRegistry({
		id: "pi-model",
		models: [{ name: definition.name, model: definition.model, provider: decorated }],
		prompts: [{ name: "planner_prompt", prompt: "Plan.", model: "planner" }],
		agents: [{ name: "planner", sides: { a: { prompt: "planner_prompt" }, b: { human: true } } }],
	});
	const runtime = new Runtime({ registry: built, store });
	const thread = await runtime.createThread({ agentId: "planner" });
	const builtProvider = await runtime.providerFor(thread, built.models.get("planner")!);

	assert.equal(typeof builtProvider.generate, "function");
	assert.equal(calls.length, 1, "building a provider measures nothing on its own");
});
