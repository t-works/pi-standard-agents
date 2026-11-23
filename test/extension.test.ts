import assert from "node:assert/strict";
import { test } from "node:test";

import extension, { PING_RESULT, PING_TOOL_NAME } from "../dist/extension.js";
import { createFakePi } from "./fake-pi.ts";

test("default factory registers exactly one tool and the session lifecycle handlers", async () => {
	const fakePi = createFakePi();

	await extension(fakePi.api);

	assert.equal(fakePi.tools.length, 1, "exactly one tool is registered");
	assert.equal(fakePi.onlyTool().name, PING_TOOL_NAME);
	assert.deepEqual(
		fakePi.handlers.map((h) => h.event),
		["session_start", "session_shutdown"],
	);
	assert.deepEqual(fakePi.commands, []);
});

test("the registered tool's execute returns the fixed string", async () => {
	const fakePi = createFakePi();
	await extension(fakePi.api);

	const tool = fakePi.onlyTool();
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

	assert.equal(first.tools.length, 1);
	assert.equal(second.tools.length, 1);
	assert.notEqual(first.onlyTool(), second.onlyTool(), "no module-level tool instance is reused");
	assert.equal(first.handlers.length, 2);
	assert.equal(second.handlers.length, 2);
});
