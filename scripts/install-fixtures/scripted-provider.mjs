/**
 * A provider that answers from a canned script, copied into the temp install.
 *
 * The runtime only calls `generate`; `stream()` throws so a path that reaches
 * for streaming fails loudly instead of hanging. No network, no keys, no model:
 * the temp install proves the *dependency tree* resolves, not that a model does.
 */

const CONFIG_SLOTS = {
	// The runtime refuses to build a provider it cannot see an API key for. This
	// one talks to nothing, so the slot carries a fake default.
	apiKey: { type: "text", default: "tarball-check-provider" },
};

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Build a scripted provider factory. The last reply repeats. */
export function scriptedProvider(script = [], name = "scripted") {
	const requests = [];
	let calls = 0;

	const instance = {
		name,
		specificationVersion: "1",
		async generate(request) {
			requests.push(request);
			const reply = script[calls] ?? script[script.length - 1] ?? {};
			calls += 1;
			const toolCalls = reply.toolCalls ?? [];
			const usage = reply.usage === undefined ? ZERO_USAGE : reply.usage;
			return {
				content: reply.content ?? null,
				reasoning: reply.reasoning ?? null,
				...(toolCalls.length ? { toolCalls } : {}),
				finishReason: toolCalls.length ? "tool_calls" : "stop",
				...(usage ? { usage } : {}),
			};
		},
		async stream() {
			throw new Error("scripted provider stream() is not used by the runtime");
		},
	};

	const factory = () => instance;
	Object.defineProperty(factory, "name", { value: name, configurable: true });
	Object.defineProperties(factory, {
		requests: { value: requests, enumerable: true },
		calls: { get: () => calls, enumerable: true },
		configSlots: { value: CONFIG_SLOTS, enumerable: true },
	});
	return factory;
}
