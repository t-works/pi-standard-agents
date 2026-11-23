/**
 * A provider that answers from a canned script.
 *
 * The runtime only calls `generate`; `stream()` throws so a code path that
 * reaches for streaming fails loudly instead of hanging. Requests are logged so
 * a test can assert on the system message and the conversation the model
 * actually saw — no network, no keys, no model.
 */
import type {
	ProviderConfigSlots,
	ProviderFactory,
	ProviderInstance,
	ProviderRequest,
	ProviderResponse,
	ProviderToolCallPart,
	ProviderUsage,
} from "@standardagents/spec";

/** One canned model answer. `toolCalls` is what makes the runtime take a tool step. */
export interface ScriptedReply {
	content?: string | null;
	reasoning?: string | null;
	toolCalls?: ProviderToolCallPart[];
	/**
	 * Usage this answer reports. Omit for zero tokens; pass `null` to model a
	 * provider that reports no usage at all — the case the journal must record as
	 * unknown rather than as free.
	 */
	usage?: ProviderUsage | null;
}

/** A provider factory plus the request log and call counter behind it. */
export interface ScriptedProvider extends ProviderFactory {
	readonly requests: ProviderRequest[];
	/** How many scripted answers have been produced so far. */
	readonly calls: number;
}

const CONFIG_SLOTS: ProviderConfigSlots = {
	// The runtime refuses to build a provider it cannot see an API key for. A
	// scripted provider talks to nothing, so the slot carries a fake default
	// rather than asking every test to set an environment variable.
	apiKey: { type: "text", default: "scripted-provider" },
};

const ZERO_USAGE: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Build a scripted provider.
 *
 * Each `generate` call takes the next scripted reply; the last reply repeats so
 * a test that under-scripts a loop still terminates. With an empty script every
 * answer is an empty assistant message.
 */
export function scriptedProvider(
	script: readonly ScriptedReply[] = [],
	name = "scripted",
): ScriptedProvider {
	const requests: ProviderRequest[] = [];
	let calls = 0;

	const instance: ProviderInstance = {
		name,
		specificationVersion: "1",
		async generate(request: ProviderRequest): Promise<ProviderResponse> {
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
				// `usage` is required by the type, so an omitted one is a deliberate
				// cast: it reproduces a provider that reports nothing.
				...(usage ? { usage } : {}),
			} as ProviderResponse;
		},
		async stream(): Promise<AsyncIterable<never>> {
			throw new Error("scripted provider stream() is not used by the runtime");
		},
	};

	const factory = ((..._args: unknown[]) => instance) as unknown as ScriptedProvider;
	Object.defineProperty(factory, "name", { value: name, configurable: true });
	Object.defineProperties(factory, {
		requests: { value: requests, enumerable: true },
		calls: { get: () => calls, enumerable: true },
		configSlots: { value: CONFIG_SLOTS, enumerable: true },
	});
	return factory;
}
