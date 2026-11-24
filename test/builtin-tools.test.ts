/**
 * The built-in tools: what a workflow file may name, and the fence around it.
 *
 * Seven assertions, all against a temp dir, none of them needing a model:
 *
 *  - **Names.** The set is exactly the five the workflow files declare.
 *  - **Files.** `write` then `read` round-trips; a path outside the run's cwd is
 *    refused for both, and for `edit` and `list` too.
 *  - **Edit.** One exact passage is replaced; zero occurrences and two are refused
 *    with the count in the message, so the model learns to add context.
 *  - **List.** Directories carry a trailing slash and the noisy ones are skipped.
 *  - **Shell.** An exit code is reported as a result, a failing command included.
 *  - **Wiring.** `withBuiltinTools` is what turns a workflow's declaration into an
 *    implementation; without it the declaration stays unbound, which is how a typo
 *    is caught at run start rather than at the first tool call.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ToolSpec } from "../src/registry.ts";
import { loadWorkflow } from "../src/extension.ts";
import { buildRegistry } from "../src/registry.ts";
import { BUILTIN_TOOL_NAMES, buildBuiltinTools, withBuiltinTools } from "../src/builtin-tools.ts";

const dirs: string[] = [];

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "builtin-tools-"));
	dirs.push(dir);
	return dir;
}

after(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function toolNamed(tools: readonly ToolSpec[], name: string): ToolSpec {
	const found = tools.find((tool) => tool.name === name);
	assert.ok(found, `the built-in set has '${name}'`);
	return found;
}

/** Call a tool the way the runtime does: schema-parsed args, state unused here. */
async function call(tools: readonly ToolSpec[], name: string, args: unknown) {
	const tool = toolNamed(tools, name);
	return (tool.execute as unknown as (state: unknown, args: unknown) => Promise<{ status: string; result?: string; error?: string }>)(
		{},
		args,
	);
}

test("the built-in set is exactly the names a workflow may declare", () => {
	const tools = buildBuiltinTools(process.cwd());
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[...BUILTIN_TOOL_NAMES],
	);
	for (const tool of tools) {
		assert.ok(tool.description.length > 0, `${tool.name} carries a description`);
		assert.ok(tool.args, `${tool.name} declares an argument schema`);
	}
});

test("write then read round-trips inside the working directory", async () => {
	const dir = await workdir();
	const tools = buildBuiltinTools(dir);

	const wrote = await call(tools, "write", { path: "src/deep/file.txt", content: "one\ntwo\n" });
	assert.equal(wrote.status, "success");
	assert.match(wrote.result ?? "", /wrote \d+ bytes to src\/deep\/file\.txt/);

	const read = await call(tools, "read", { path: "src/deep/file.txt" });
	assert.equal(read.status, "success");
	assert.equal(read.result, "one\ntwo\n");
});

test("every file tool refuses a path outside the working directory", async () => {
	const dir = await workdir();
	const outside = join(dir, "..", "outside.txt");
	await writeFile(outside, "secret\n").catch(() => {});
	const tools = buildBuiltinTools(join(dir, "repo"));
	await mkdir(join(dir, "repo"), { recursive: true });

	for (const [name, args] of [
		["read", { path: "../outside.txt" }],
		["write", { path: "../outside.txt", content: "x" }],
		["edit", { path: "../outside.txt", old: "secret", new: "x" }],
		["list", { path: ".." }],
		["read", { path: outside }],
	] as const) {
		const result = await call(tools, name, args);
		assert.equal(result.status, "error", `${name} ${JSON.stringify(args)} is refused`);
		assert.match(result.error ?? "", /outside the working directory/);
	}
});

test("edit replaces one exact passage and refuses zero or several", async () => {
	const dir = await workdir();
	await writeFile(join(dir, "a.txt"), "alpha beta gamma beta\n");
	const tools = buildBuiltinTools(dir);

	const one = await call(tools, "edit", { path: "a.txt", old: "alpha", new: "ALPHA" });
	assert.equal(one.status, "success");
	assert.equal((await call(tools, "read", { path: "a.txt" })).result, "ALPHA beta gamma beta\n");

	const missing = await call(tools, "edit", { path: "a.txt", old: "nope", new: "x" });
	assert.equal(missing.status, "error");
	assert.match(missing.error ?? "", /does not occur/);

	const several = await call(tools, "edit", { path: "a.txt", old: "beta", new: "x" });
	assert.equal(several.status, "error");
	assert.match(several.error ?? "", /occurs 2 times/);
});

test("list marks directories, walks one level and skips the noisy ones", async () => {
	const dir = await workdir();
	await mkdir(join(dir, "src"), { recursive: true });
	await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
	await writeFile(join(dir, "src", "index.ts"), "export {};\n");
	await writeFile(join(dir, "README.md"), "# readme\n");
	const tools = buildBuiltinTools(dir);

	const listed = await call(tools, "list", { path: ".", depth: 2 });
	assert.equal(listed.status, "success");
	const lines = (listed.result ?? "").split("\n");
	assert.ok(lines.includes("src/"), "a directory keeps its trailing slash");
	assert.ok(lines.includes("src/index.ts"), "a nested file is walked");
	assert.ok(lines.includes("README.md"));
	assert.ok(!lines.some((line) => line.startsWith("node_modules")), "node_modules is skipped");
});

test("shell reports an exit code, a failing command included", async () => {
	const dir = await workdir();
	const tools = buildBuiltinTools(dir);

	const ok = await call(tools, "shell", { command: "echo hello" });
	assert.equal(ok.status, "success");
	assert.match(ok.result ?? "", /^exit: 0\nhello/);

	const failed = await call(tools, "shell", { command: "echo out; exit 3" });
	assert.equal(failed.status, "success", "a red command is a result, not a tool failure");
	assert.match(failed.result ?? "", /^exit: 3\nout/);
});

test("withBuiltinTools is what binds a workflow's declaration to an implementation", async () => {
	const dir = await workdir();
	await writeFile(
		join(dir, "wf.json"),
		JSON.stringify({
			id: "declares-shell",
			models: [{ name: "fast", model: "unused-model" }],
			tools: [{ name: "shell", description: "run a command" }],
			prompts: [{ name: "worker", toolDescription: "does the work", prompt: "Work.", model: "fast", tools: ["shell"] }],
			agents: [{ name: "worker", sides: { a: { prompt: "worker" }, b: { human: true } } }],
		}),
	);

	// A workflow file cannot carry a factory, so a test supplies the one thing the
	// builder asks of it. Nothing here calls a model.
	const scripted = () => ({
		name: "scripted",
		specificationVersion: "1",
		async generate() {
			return { content: null, finishReason: "stop", toolCalls: [], usage: null };
		},
		async *stream() {
			throw new Error("not used");
		},
	});
	const withFactory = (spec: ReturnType<typeof loadWorkflow>["spec"]) => ({
		...spec,
		models: spec.models.map((model) => ({ ...model, provider: scripted as never })),
	});

	const unbound = loadWorkflow(join(dir, "wf.json"));
	assert.equal(unbound.spec.tools, undefined, "a declaration with no implementation binds nothing");
	assert.throws(
		() => buildRegistry(withFactory(unbound.spec)),
		/is not a defined tool/,
		"and the prompt that names it fails at run start",
	);

	const bound = loadWorkflow(join(dir, "wf.json"), { tools: withBuiltinTools(dir) });
	assert.deepEqual(bound.spec.tools?.map((tool) => tool.name), ["shell"]);
	buildRegistry(withFactory(bound.spec));
});
