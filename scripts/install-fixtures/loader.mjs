/**
 * The loader the temp install runs: the published package, and nothing from
 * this repository.
 *
 * It answers the one question `npm pack` cannot: does the *published* dependency
 * tree load? So it imports the installed `pi-standard-agents` by name, drives it
 * with the copied fake recorder, and then reaches the runtime through the
 * installed package's own resolution — `@t-works/standardagents-runtime` and its
 * `quickjs` engine are not devDependencies here, they arrived through the
 * tarball.
 *
 * What it asserts, in order:
 *  1. the installed manifest still points `pi.extensions` at built JS that exists
 *  2. the default factory registers `standard_agent` + `std_smoke`, the `sa`
 *     command and the `standard-agent-run` renderer
 *  3. the runtime's `validateRegistry` resolves from the install and still
 *     catches an undefined prompt reference
 *  4. the `quickjs` engine behind the runtime's sandbox boots, so its wasm asset
 *     resolves from the installed tree and not from a dev checkout
 *  5. one real turn: `standard_agent start` → `createThread` → `settle()`, the
 *     journal records the scripted call, the completion wake fires once
 *  6. `/sa runs` and `/sa cost` answer from disk (the `/sa`-equivalent command
 *     invocation), and session shutdown releases the run's `owner.lock`
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi } from "./fake-pi.mjs";
import { scriptedProvider } from "./scripted-provider.mjs";

const cwd = process.cwd();
const installedDir = join(cwd, "node_modules", "pi-standard-agents");
const checks = [];

/** Record one passed assertion. */
function ok(label) {
	checks.push(label);
	console.log(`  ✓ ${label}`);
}

/** Parse a JSON file. */
async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

/** Poll `check` until it answers, or fail after `timeoutMs`. */
async function until(check, { timeoutMs = 30_000, label = "condition" } = {}) {
	const started = Date.now();
	for (;;) {
		const answer = await check();
		if (answer) return answer;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// 1. The installed manifest is the one PI reads.
const manifest = await readJson(join(installedDir, "package.json"));
assert.deepEqual(manifest.pi?.extensions, ["./dist/extension.js"], "pi.extensions points at dist/extension.js");
ok(`installed ${manifest.name}@${manifest.version} declares pi.extensions ["./dist/extension.js"]`);
assert.ok(existsSync(join(installedDir, "dist", "extension.js")), "the tarball ships dist/extension.js");
ok("installed dist/extension.js exists");
assert.ok(manifest.keywords?.includes("pi-package"), 'keywords include "pi-package"');
assert.ok(
	manifest.dependencies?.["@t-works/standardagents-runtime"],
	"the runtime is a plain dependency of the installed package",
);
for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
	assert.ok(!manifest.dependencies?.[host], `${host} must be a peer, not a dependency`);
}
ok("runtime is a dependency; PI + typebox are peers supplied by the host");

// 2. The default factory, driven by the copied recorder.
const extension = await import("pi-standard-agents");
const factory = extension.default;
assert.equal(typeof factory, "function", "the entry exports a default factory (PI's extension ABI)");
ok("package entry exports a default factory");

const workflowFile = join(cwd, "workflow.json");
await writeFile(
	workflowFile,
	`${JSON.stringify(
		{
			id: "tarball-check",
			models: [{ name: "scripted", model: "scripted-1" }],
			prompts: [
				{
					name: "worker",
					toolDescription: "Answer the one question you were given",
					prompt: "Answer in one short sentence. Never ask a question back.",
					model: "scripted",
				},
			],
			agents: [
				{
					name: "worker",
					title: "Worker",
					sides: { a: { prompt: "worker" }, b: { human: true } },
				},
			],
		},
		null,
		"\t",
	)}\n`,
	"utf8",
);

const fakePi = createFakePi({ cwd });
const provider = scriptedProvider([
	{ content: "tarball ok", usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 } },
]);

// The default factory is sync today; `await` covers both, because PI accepts either.
await factory(fakePi.api, { cwd, providers: { scripted: provider } });

const toolNames = fakePi.tools.map((tool) => tool.name);
assert.ok(toolNames.includes("standard_agent"), "the factory registers standard_agent");
assert.ok(toolNames.includes("std_smoke"), "the factory registers std_smoke");
ok(`default factory registered tools: ${toolNames.join(", ")}`);

assert.deepEqual(
	fakePi.messageRenderers.map((renderer) => renderer.customType),
	[extension.COMPLETION_CUSTOM_TYPE],
);
ok(`renderer registered for '${extension.COMPLETION_CUSTOM_TYPE}'`);
assert.ok(
	fakePi.commands.some((command) => command.name === "sa"),
	"the factory registers the /sa command",
);
ok("command registered: /sa");

// 3. The runtime resolves from the install, and still validates a registry.
const requireFromInstalled = createRequire(join(installedDir, "package.json"));
const runtimeLoaderPath = requireFromInstalled.resolve("@t-works/standardagents-runtime/loader");
assert.ok(
	runtimeLoaderPath.startsWith(join(cwd, "node_modules") + sep),
	`the runtime must resolve from the install, not from a dev tree (got ${runtimeLoaderPath})`,
);
const { validateRegistry } = await import(pathToFileURL(runtimeLoaderPath).href);
assert.equal(typeof validateRegistry, "function", "validateRegistry is exported by the installed runtime");
ok(`runtime loader resolves from the install: ${runtimeLoaderPath.slice(cwd.length + 1)}`);

/** A registry as the runtime wants it: maps, even when they are empty. */
function registryWith(agents = []) {
	return {
		agents: new Map(agents),
		prompts: new Map(),
		models: new Map(),
		tools: new Map(),
		hooks: new Map(),
		handlers: new Map(),
		subagents: new Map(),
	};
}
assert.deepEqual(validateRegistry(registryWith()), [], "an empty registry has no issues");
const dangling = validateRegistry(
	registryWith([["worker", { sideA: { prompt: "missing_prompt" }, sideB: { human: true } }]]),
);
assert.ok(
	dangling.some((issue) => /undefined prompt 'missing_prompt'/.test(issue.message)),
	"validateRegistry still catches an undefined prompt reference",
);
ok("validateRegistry ran: empty registry clean, dangling prompt reported");

// 4. The quickjs engine (and so quickjs's wasm asset) boots from the install.
const sandboxPath = requireFromInstalled.resolve("@t-works/standardagents-runtime/sandbox");
const { run } = await import(pathToFileURL(sandboxPath).href);
const sandboxResult = await run("export default 2 + 2", { language: "javascript" });
assert.equal(sandboxResult.status, "success", `sandbox run failed: ${JSON.stringify(sandboxResult)}`);
assert.equal(sandboxResult.result, 4, "quickjs evaluated the script");
ok(`quickjs engine booted from the install (2 + 2 = ${sandboxResult.result}, ${sandboxResult.durationMs} ms)`);

// 5. One turn, end to end, through the registered tool.
const tool = fakePi.toolNamed("standard_agent");
const started = await tool.execute(
	"call-1",
	{ action: "start", workflow: "workflow.json", task: "Say that the tarball works." },
	undefined,
	undefined,
	fakePi.ctx,
);
assert.equal(started.isError, undefined, `start refused: ${started.content?.[0]?.text}`);
const runId = started.details?.runId;
const threadId = started.details?.threadId;
assert.ok(runId && threadId, "start answered with a run id and a thread id");
ok(`standard_agent start opened run ${runId} (thread ${threadId})`);

const runDir = join(cwd, ".pi", "standard-agents", "runs", runId);
assert.ok(existsSync(join(runDir, "spec.json")), "the run directory is on disk with its pinned spec");
assert.ok(existsSync(join(runDir, "owner.lock")), "the open run holds its owner.lock");

const settled = await until(
	async () => {
		const view = await tool.execute("call-2", { action: "status", runId }, undefined, undefined, fakePi.ctx);
		const thread = view.details?.runs?.[0]?.threads?.[0];
		return thread && thread.phase !== "running" ? view : null;
	},
	{ label: "the scripted turn to settle" },
);
const thread = settled.details.runs[0].threads[0];
assert.equal(thread.phase, "idle", "the scripted turn ended");
assert.equal(provider.calls, 1, "the scripted provider was called exactly once");
const messages = JSON.parse(
	await readFile(join(runDir, "store", "threads", threadId, "messages.json"), "utf8"),
);
assert.match(JSON.stringify(messages), /tarball ok/, "the scripted answer reached messages.json");
assert.deepEqual(
	{ totalTokens: settled.details.usage.totalTokens, calls: settled.details.usage.calls },
	{ totalTokens: 13, calls: 1 },
	"the journal recorded the one scripted call",
);
ok("createThread + settle() turn finished: 'tarball ok' in messages.json, 13 tokens over 1 call");

const wake = await until(
	async () =>
		fakePi.messages.find((message) => message.message?.customType === extension.COMPLETION_CUSTOM_TYPE),
	{ label: "the completion wake" },
);
assert.match(String(wake.message.content), new RegExp(runId), "the wake names the run");
assert.equal(wake.options?.triggerTurn, true, "the wake triggers exactly one PI turn");
assert.equal(
	fakePi.messages.filter((message) => message.message?.customType === extension.COMPLETION_CUSTOM_TYPE).length,
	1,
	"the wake is sent once, not once per settle",
);
ok(`completion wake sent once: '${String(wake.message.content).slice(0, 88)}'`);

// 6. The `/sa` command answers from disk, with no run in memory to help it.
const sa = fakePi.commandNamed("sa");
fakePi.notifications.length = 0;
await sa.options.handler("runs", fakePi.ctx);
const runList = fakePi.notifications.join("\n");
assert.match(runList, new RegExp(runId), "/sa runs lists the run it just finished");
fakePi.notifications.length = 0;
await sa.options.handler("cost", fakePi.ctx);
const cost = fakePi.notifications.join("\n");
assert.match(cost, /13 tokens/, "/sa cost matches the journal");
ok(`/sa runs and /sa cost answered from disk: '${cost.split("\n")[0]}'`);

for (const handler of fakePi.handlersFor("session_shutdown")) await handler.handler(fakePi.ctx, {});
assert.ok(!existsSync(join(runDir, "owner.lock")), "session shutdown released the run's owner.lock");
ok("session shutdown released owner.lock");

console.log(`loader: ok (${checks.length} assertion(s) against the installed package)`);
