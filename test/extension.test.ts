import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension, {
	PING_RESULT,
	PING_TOOL_NAME,
	STANDARD_AGENT_TOOL_NAME,
} from "../dist/extension.js";
import { createFakePi } from "./fake-pi.ts";

/** The tool with this name, failing the test when the factory did not register it. */
function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((tool) => tool.name === name);
	assert.ok(found, `the factory registers '${name}'`);
	return found;
}

test("default factory registers both tools and the session lifecycle handlers", async () => {
	const fakePi = createFakePi();

	await extension(fakePi.api);

	assert.deepEqual(
		fakePi.tools.map((tool) => tool.name),
		[PING_TOOL_NAME, STANDARD_AGENT_TOOL_NAME],
		"the skeleton ping and the run tool",
	);
	assert.deepEqual(
		fakePi.handlers.map((h) => h.event),
		["session_start", "session_shutdown"],
	);
	assert.deepEqual(fakePi.commands, []);
});

test("the registered tool's execute returns the fixed string", async () => {
	const fakePi = createFakePi();
	await extension(fakePi.api);

	const tool = toolNamed(fakePi.tools, PING_TOOL_NAME);
	const result = await tool.execute("call-1", {}, undefined, undefined, fakePi.ctx);

	assert.equal(result.isError, undefined, "the skeleton ping never errors");
	assert.equal(result.content.length, 1);
	const [first] = result.content;
	assert.ok(first && first.type === "text", "the result carries text content");
	assert.equal(first.text, PING_RESULT);
});

test("a second factory call on a fresh recorder registers again", async () => {
	const first = createFakePi();
	const second = createFakePi();

	await extension(first.api);
	await extension(second.api);

	assert.equal(first.tools.length, 2);
	assert.equal(second.tools.length, 2);
	assert.notEqual(
		toolNamed(first.tools, PING_TOOL_NAME),
		toolNamed(second.tools, PING_TOOL_NAME),
		"no module-level tool instance is reused",
	);
	assert.notEqual(
		toolNamed(first.tools, STANDARD_AGENT_TOOL_NAME),
		toolNamed(second.tools, STANDARD_AGENT_TOOL_NAME),
		"each session gets its own run bookkeeping",
	);
	assert.equal(first.handlers.length, 2);
	assert.equal(second.handlers.length, 2);
});
