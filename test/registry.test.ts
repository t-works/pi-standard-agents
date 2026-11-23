/**
 * A workflow spec becomes a `Registry` a `Runtime` accepts — no definition
 * files, no `loadSource`, no network. Everything the runtime talks to is a
 * scripted provider, so these assertions are about our own wiring.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Runtime } from "@t-works/standardagents-runtime";
import { formatIssues } from "@t-works/standardagents-runtime/loader";
import { ThreadStore } from "@t-works/standardagents-runtime/store";
import type { Message } from "@standardagents/spec";

import type { WorkflowSpec } from "../src/registry.ts";
import { buildRegistry, RegistryBuildError } from "../src/registry.ts";
import { scriptedProvider } from "./scripted.ts";

/** A store in a throwaway directory, with a per-run key so no user key file is touched. */
async function tempStore(): Promise<{ store: ThreadStore; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-standard-agents-registry-"));
	const store = new ThreadStore(root, { envKey: randomBytes(32).toString("hex") });
	return { store, root };
}

/** The smallest spec that runs: one agent, its prompt, a shared prompt it includes. */
function baseSpec(script: Parameters<typeof scriptedProvider>[0] = []): WorkflowSpec {
	return {
		id: "test-workflow",
		models: [{ name: "scripted", model: "scripted-1", provider: scriptedProvider(script) }],
		prompts: [
			{
				name: "shared_system",
				prompt: "Shared rules: be brief.",
				model: "scripted",
			},
			{
				name: "assistant",
				prompt: [
					{ type: "text", content: "You are the assistant.\n\n" },
					{ type: "include", prompt: "shared_system" },
				],
				model: "scripted",
				includeChat: true,
			},
		],
		agents: [
			{
				name: "assistant",
				sides: { a: { prompt: "assistant" }, b: { human: true } },
			},
		],
	};
}

/** Drive one turn of the agent's model side and settle the runtime. */
async function runOneTurn(
	spec: WorkflowSpec,
	userText = "hello",
): Promise<{ runtime: Runtime; threadId: string; store: ThreadStore; root: string }> {
	const { registry } = buildRegistry(spec);
	const { store, root } = await tempStore();
	const runtime = new Runtime({ registry, store });
	const thread = await runtime.createThread({ agentId: spec.agents[0]!.name });
	await thread.queueMessage({ role: "user", content: userText }, { trigger: false });
	await runtime.start(thread, "a");
	await runtime.settle();
	return { runtime, threadId: thread.threadId, store, root };
}

test("a valid spec yields no issues and runs a settled thread with the scripted reply", async (t) => {
	const { registry, issues } = buildRegistry(baseSpec([{ content: "scripted reply" }]));
	assert.deepEqual(issues, []);

	const { store, root } = await tempStore();
	t.after(() => rm(root, { recursive: true, force: true }));

	const runtime = new Runtime({ registry, store });
	const thread = await runtime.createThread({ agentId: "assistant" });
	await thread.queueMessage({ role: "user", content: "what does idempotent mean?" }, { trigger: false });
	await runtime.start(thread, "a");
	await runtime.settle();

	assert.equal(thread.data.status.state, "idle", "the settled thread is idle");
	assert.equal(runtime.isBusy(thread.threadId), false);

	const persisted = JSON.parse(await readFile(store.messagesPath(thread.threadId), "utf8")) as Message[];
	const reply = persisted.find((message) => message.content === "scripted reply");
	assert.ok(reply, "the scripted reply is persisted in messages.json");
	assert.equal(reply.role, "assistant");
	assert.ok(
		persisted.some((message) => message.content === "what does idempotent mean?"),
		"the queued user message is persisted too",
	);
});

test("include composition renders both prompts' text into the system message", async (t) => {
	const provider = scriptedProvider([{ content: "noted" }]);
	const spec = baseSpec();
	spec.models = [{ name: "scripted", model: "scripted-1", provider }];
	const { registry } = buildRegistry(spec);

	const { store, root } = await tempStore();
	t.after(() => rm(root, { recursive: true, force: true }));
	const runtime = new Runtime({ registry, store });
	const thread = await runtime.createThread({ agentId: "assistant" });

	const rendered = await runtime.renderPrompt(
		thread,
		registry.prompts.get("assistant")!,
		new Set<string>(),
	);
	assert.match(rendered, /You are the assistant\./, "the including prompt contributes its text");
	assert.match(rendered, /Shared rules: be brief\./, "the included prompt contributes its text");

	// A cycle between prompts is a definition error the runtime refuses to render.
	spec.prompts = [
		{
			name: "loop_a",
			prompt: [
				{ type: "text", content: "A says hi." },
				{ type: "include", prompt: "loop_b" },
			],
			model: "scripted",
		},
		{ name: "loop_b", prompt: [{ type: "include", prompt: "loop_a" }], model: "scripted" },
	];
	spec.agents = [
		{ name: "looper", sides: { a: { prompt: "loop_a" }, b: { human: true } } },
	];
	const { registry: looping } = buildRegistry(spec);
	const loopRuntime = new Runtime({ registry: looping, store });
	const loopThread = await loopRuntime.createThread({ agentId: "looper" });

	await assert.rejects(
		() => loopRuntime.renderPrompt(loopThread, looping.prompts.get("loop_a")!, new Set<string>()),
		/Circular prompt include/,
	);
});

test("a side pointing at an undefined prompt yields one issue at agent.sideA.prompt", () => {
	const spec = baseSpec();
	spec.agents = [
		{
			name: "agent",
			sides: { a: { prompt: "not_a_prompt" }, b: { human: true } },
		},
	];

	const { issues } = buildRegistry(spec, { strict: false });

	assert.equal(issues.length, 1, "the reference is reported once, not twice");
	const [issue] = issues;
	assert.ok(issue);
	assert.equal(issue.path, "agent.sideA.prompt");
	assert.equal(issue.severity, "error");
	assert.match(formatIssues(issues), /agent\.sideA\.prompt/, "formatIssues prints the path");

	// Fail closed by default: the same spec never yields a runnable registry.
	assert.throws(
		() => buildRegistry(spec),
		(error: unknown) =>
			error instanceof RegistryBuildError && /agent\.sideA\.prompt/.test(error.message),
	);
});

test("two agents with the same name throw before a Runtime is constructed", () => {
	const spec = baseSpec();
	spec.agents = [
		{ name: "assistant", sides: { a: { prompt: "assistant" }, b: { human: true } } },
		{ name: "assistant", description: "the same name again", sides: { a: { prompt: "assistant" }, b: { human: true } } },
	];

	assert.throws(
		() => buildRegistry(spec),
		(error: unknown) =>
			error instanceof RegistryBuildError &&
			error.issues.length === 1 &&
			/duplicate agent name 'assistant'/i.test(error.message),
	);
});

test("the shipped example builds once a provider is supplied for its models", async () => {
	const spec = JSON.parse(
		await readFile(new URL("../examples/workflow.json", import.meta.url), "utf8"),
	) as WorkflowSpec;
	const provider = scriptedProvider([{ content: "example reply" }]);

	const { registry, issues } = buildRegistry(spec, { providers: { fast: provider } });

	assert.deepEqual(issues, []);
	assert.equal(registry.agents.size, 2, "two agents");
	assert.equal(registry.prompts.size, 3, "a shared prompt and one prompt per agent");
	assert.equal(registry.prompts.get("triage")?.prompt instanceof Array, true);

	// A model without a provider fails validation instead of on the first turn.
	assert.throws(
		() => buildRegistry(spec),
		(error: unknown) =>
			error instanceof RegistryBuildError && /has no provider factory/.test(error.message),
	);
});
