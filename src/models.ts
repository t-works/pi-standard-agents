/**
 * The model seam: PI owns models and credentials, the runtime owns the loop.
 *
 * A `ModelDefinition` only needs a `provider` factory, and the runtime calls it
 * once per model name (`Runtime.providerFor`). That factory is therefore the one
 * honest place to (a) find out which model PI resolved and (b) measure what the
 * call cost — because it is the same object for the agent's own turns and for the
 * nested prompt tools whose traffic never reaches `messages.json`.
 *
 * `piModel` builds the definition: it resolves the id through PI's
 * `ctx.modelRegistry` (PI's registry is the source of truth for ids, capabilities
 * and keys) and returns a provider that translates one Standard Agents request to
 * PI's `Context`/`complete` and PI's `AssistantMessage` back. `withUsage` wraps any
 * factory with a usage sink, which is the decorator the README's invariant 3
 * applies to.
 *
 * Keys never travel: `piModel`'s factory declares an `apiKey` slot with a
 * placeholder default, so `Runtime.providerFor` fills it and never guesses
 * `<FACTORY>_API_KEY` from the environment. The real key is resolved by PI at
 * request time (`ModelRegistry.complete`), so no key lands in `thread.env`.
 *
 * Everything PI-shaped lives in this file: a PI upgrade that renames a registry
 * method breaks the adapter, not the runtime.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage as PiAssistantMessage,
	Context as PiContext,
	ImageContent as PiImageContent,
	Message as PiMessage,
	Model as PiModel,
	StopReason as PiStopReason,
	TextContent as PiTextContent,
	ThinkingContent as PiThinkingContent,
	Tool as PiTool,
	ToolCall as PiToolCall,
	Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type {
	ContentPart,
	ModelDefinition,
	ProviderConfigSlot,
	ProviderConfigSlots,
	ProviderFactory,
	ProviderFactoryConfig,
	ProviderFinishReason,
	ProviderInstance,
	ProviderMessage,
	ProviderMessageContent,
	ProviderRequest,
	ProviderResponse,
	ProviderStreamChunk,
	ProviderTool,
	ProviderToolCallPart,
	ProviderToolResultContent,
	ProviderUsage,
} from "@standardagents/spec";

/** The slice of PI's extension context this adapter reads. */
export interface PiHost {
	/** PI's model registry: the source of truth for model ids, capabilities and keys. */
	modelRegistry: ModelRegistry;
}

/** Options for {@link piModel}. */
export interface PiModelOptions {
	/** Registry name the runtime looks the model up by (a prompt's `model`). */
	name: string;
	/** PI model id, e.g. `claude-sonnet-4`; `"<provider>/<id>"` disambiguates. */
	model: string;
	/** Extra connection slots merged over the built-in `apiKey` slot. */
	configSlots?: ProviderConfigSlots;
}

/**
 * Placeholder API key for a factory whose credentials PI resolves itself.
 *
 * A literal, not a secret: the runtime only needs the slot to be non-empty so it
 * stays out of its `<FACTORY>_API_KEY` guessing path.
 */
export const PI_RESOLVED_API_KEY = "resolved-by-pi";

/** The `apiKey` slot every provider factory should declare (see {@link apiKeySlot}). */
export function apiKeySlot(placeholder: string): ProviderConfigSlot {
	return {
		type: "text",
		default: placeholder,
		description:
			"Placeholder: credentials are resolved by the host, so the key stays out of the runtime's environment.",
	};
}

/** One measured model call, as {@link withUsage} reports it. Row fields are an allowlist. */
export interface ModelCall {
	/** Model id the request was sent to. */
	model: string;
	/** When the call started (ISO 8601). */
	startedAt: string;
	/** Wall-clock duration in milliseconds. */
	ms: number;
	/** What the provider reported, or `null` when it reported nothing. Never zeroed. */
	usage: ProviderUsage | null;
	/** Why the model stopped; `error` when the call threw. */
	finishReason: ProviderFinishReason | null;
}

/** Where measured calls go — typically `journal.modelCallSink()`. */
export type UsageSink = (call: ModelCall) => void;

/** The factory's own properties that must survive decoration. */
const FACTORY_METADATA = ["name", "configSlots", "providerOptions", "providerDefinition"] as const;

/**
 * Wrap a provider factory so every `generate` is measured.
 *
 * `configSlots` (and the rest of the factory metadata) is preserved, because
 * `Runtime.providerConfig` reads the slots off the *factory* it was handed — a
 * wrapper that dropped them would fail every key lookup with "needs provider
 * setting 'apiKey'". The instance keeps every other optional method (`getModels`,
 * `supportsModel`, ...) through the prototype-preserving copy.
 *
 * Only `{model, startedAt, ms, usage, finishReason}` is reported: requests and
 * responses carry prompts and possibly interpolated secrets, and a journal is not
 * a transcript.
 */
export function withUsage(factory: ProviderFactory, sink: UsageSink): ProviderFactory {
	const wrapped = ((config: ProviderFactoryConfig, context?: Parameters<ProviderFactory>[1]) => {
		const instance = factory(config, context);

		const generate = async (request: ProviderRequest): Promise<ProviderResponse> => {
			const startedAt = new Date().toISOString();
			const started = performance.now();
			try {
				const response = await instance.generate(request);
				sink({
					model: request.model,
					startedAt,
					ms: Math.round(performance.now() - started),
					usage: response?.usage ?? null,
					finishReason: response?.finishReason ?? null,
				});
				return response;
			} catch (error) {
				sink({
					model: request.model,
					startedAt,
					ms: Math.round(performance.now() - started),
					usage: null,
					finishReason: "error",
				});
				throw error;
			}
		};

		return Object.assign(Object.create(Object.getPrototypeOf(instance) ?? Object.prototype), instance, {
			name: instance.name,
			specificationVersion: instance.specificationVersion,
			generate,
			stream: (request: ProviderRequest) => instance.stream(request),
		}) as ProviderInstance;
	}) as unknown as ProviderFactory;

	for (const key of FACTORY_METADATA) {
		Object.defineProperty(wrapped, key, {
			get: () => (factory as unknown as Record<string, unknown>)[key],
			enumerable: true,
			configurable: true,
		});
	}

	return wrapped;
}

/**
 * Resolve PI's model for `id`.
 *
 * `find(provider, id)` is preferred when the id names its provider; otherwise the
 * catalogue is scanned by id and then by display name, because a workflow spec
 * usually carries the id a human typed rather than the pair.
 */
function resolveModel(host: PiHost, id: string): PiModel<Api> {
	const registry = host.modelRegistry;
	const slash = id.indexOf("/");

	if (slash > 0) {
		const found = registry.find(id.slice(0, slash), id.slice(slash + 1));
		if (found) return found;
	}

	const found = registry.getAll().find((entry) => entry.id === id || entry.name === id);
	if (found) return found;

	throw new Error(
		`PI's model registry has no model '${id}'. Name it as PI does ('<provider>/<id>' when the id is ambiguous).`,
	);
}

/** Standard Agents content parts → PI's text/image parts. */
function toPiContent(content: ProviderMessageContent): string | (PiTextContent | PiImageContent)[] {
	if (typeof content === "string") return content;
	return content.map(toPiPart);
}

function toPiPart(part: ContentPart): PiTextContent | PiImageContent {
	if (part.type === "text") return { type: "text", text: part.text };
	if (part.type === "image") return { type: "image", data: part.data, mimeType: part.mediaType };
	// PI carries image *data*, not urls or files; keep the reference visible in the
	// text rather than dropping context the model was given.
	if (part.type === "image_url") return { type: "text", text: `[image: ${part.image_url.url}]` };
	return { type: "text", text: `[file: ${part.filename ?? part.mediaType}]` };
}

function toPiToolResult(content: ProviderToolResultContent): {
	content: (PiTextContent | PiImageContent)[];
	isError: boolean;
} {
	if (typeof content === "string") return { content: [{ type: "text", text: content }], isError: false };
	if (Array.isArray(content)) return { content: content.map(toPiPart), isError: false };
	if (content.type === "text") return { content: [{ type: "text", text: content.text }], isError: false };
	return { content: [{ type: "text", text: content.error }], isError: true };
}

/** Zero usage for replayed history: PI does not bill a message we already have. */
function zeroUsage(): PiUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toPiHistoryMessage(message: ProviderMessage, model: PiModel<Api>): PiMessage | null {
	if (message.role === "user") {
		return { role: "user", content: toPiContent(message.content), timestamp: Date.now() };
	}
	if (message.role === "assistant") {
		const content: (PiTextContent | PiThinkingContent | PiToolCall)[] = [];
		if (message.content) content.push({ type: "text", text: message.content });
		if (message.reasoning) content.push({ type: "thinking", thinking: message.reasoning });
		for (const call of message.toolCalls ?? []) {
			content.push({
				type: "toolCall",
				id: call.id,
				name: call.name,
				// Tool arguments are JSON we already validated; PI types them as JsonObject.
				arguments: call.arguments as unknown as PiToolCall["arguments"],
				...(call.extraContent?.thoughtSignature
					? { thoughtSignature: call.extraContent.thoughtSignature as string }
					: {}),
			});
		}
		return {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: message.toolCalls?.length ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
	}
	if (message.role === "tool") {
		const result = toPiToolResult(message.content);
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: result.content,
			isError: result.isError,
			timestamp: Date.now(),
		};
	}
	return null;
}

function toPiTools(tools: readonly ProviderTool[] | undefined): PiTool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters ?? { type: "object", properties: {} },
	}));
}

/** A Standard Agents request becomes one PI `Context`: system prompt plus transcript. */
function toPiContext(request: ProviderRequest, model: PiModel<Api>): PiContext {
	const systems: string[] = [];
	const messages: PiMessage[] = [];

	for (const message of request.messages) {
		// PI carries the system prompt on the context, not in the transcript.
		if (message.role === "system") {
			systems.push(message.content);
			continue;
		}
		const translated = toPiHistoryMessage(message, model);
		if (translated) messages.push(translated);
	}

	const tools = toPiTools(request.tools);
	return {
		...(systems.length ? { systemPrompt: systems.join("\n\n") } : {}),
		messages,
		...(tools ? { tools } : {}),
	};
}

/** PI's usage → the runtime's, keeping "unknown" out of the numbers. */
function toProviderUsage(usage: PiUsage | undefined): ProviderUsage | undefined {
	if (!usage) return undefined;
	const cost = usage.cost?.total;
	return {
		promptTokens: usage.input,
		completionTokens: usage.output,
		totalTokens: usage.totalTokens,
		...(typeof usage.reasoning === "number" ? { reasoningTokens: usage.reasoning } : {}),
		...(usage.cacheRead ? { cachedTokens: usage.cacheRead } : {}),
		...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
	};
}

const FINISH_REASONS: Record<PiStopReason, ProviderFinishReason> = {
	pending: "error",
	stop: "stop",
	length: "length",
	toolUse: "tool_calls",
	error: "error",
	aborted: "error",
	deferred: "stop",
};

/** PI's assistant message → the response the runtime stores and loops on. */
function toProviderResponse(message: PiAssistantMessage): ProviderResponse {
	const texts: string[] = [];
	const reasoning: string[] = [];
	const toolCalls: ProviderToolCallPart[] = [];

	for (const block of message.content ?? []) {
		if (block.type === "text") texts.push(block.text);
		else if (block.type === "thinking") reasoning.push(block.thinking);
		else if (block.type === "toolCall") {
			toolCalls.push({
				id: block.id,
				name: block.name,
				arguments: block.arguments,
				...(block.thoughtSignature ? { extraContent: { thoughtSignature: block.thoughtSignature } } : {}),
			});
		}
	}

	const usage = toProviderUsage(message.usage);
	const response = {
		content: texts.length ? texts.join("") : null,
		reasoning: reasoning.length ? reasoning.join("") : null,
		...(toolCalls.length ? { toolCalls } : {}),
		finishReason: FINISH_REASONS[message.stopReason] ?? "error",
		// A host that reports no usage produces a response *without* usage rather
		// than zeros: the journal then says "unknown" instead of "free".
		...(usage ? { usage } : {}),
		...(message.errorMessage ? { metadata: { provider_error: message.errorMessage } } : {}),
	};
	return response as ProviderResponse;
}

/**
 * Build the `ModelDefinition` for one PI model.
 *
 * The factory is called once per model name by the runtime; it resolves the model
 * eagerly so a typo in a workflow spec fails when the provider is built, not on a
 * later turn. `generate` hands PI the whole transcript and gets one complete
 * message back; `stream` re-emits that message as chunks, because the runtime's
 * loop only ever calls `generate` and a second translation path is a second bug.
 */
export function piModel(pi: PiHost, options: PiModelOptions): ModelDefinition {
	const factory = ((_config: ProviderFactoryConfig) => {
		// The runtime fills the slots, but PI resolves the real credentials per
		// request (`ModelRegistry.complete`), so there is no key to carry here.
		const model = resolveModel(pi, options.model);

		const generate = async (request: ProviderRequest): Promise<ProviderResponse> => {
			const context = toPiContext(request, model);
			const options: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {};
			if (request.signal) options.signal = request.signal;
			if (typeof request.temperature === "number") options.temperature = request.temperature;
			if (typeof request.maxOutputTokens === "number") options.maxTokens = request.maxOutputTokens;
			const answer = await pi.modelRegistry.complete(model, context, options);
			return toProviderResponse(answer);
		};

		async function* chunks(request: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
			const response = await generate(request);
			if (response.reasoning) {
				yield { type: "reasoning-delta", delta: response.reasoning };
				yield { type: "reasoning-done" };
			}
			if (response.content) {
				yield { type: "content-delta", delta: response.content };
				yield { type: "content-done" };
			}
			for (const call of response.toolCalls ?? []) {
				yield {
					type: "tool-call-start",
					id: call.id,
					name: call.name,
					...(call.extraContent ? { extraContent: call.extraContent } : {}),
				};
				yield { type: "tool-call-done", id: call.id, arguments: call.arguments };
			}
			yield {
				type: "finish",
				finishReason: response.finishReason ?? "stop",
				usage: response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			};
		}

		const instance: ProviderInstance = {
			name: `pi:${model.provider}`,
			specificationVersion: "1",
			generate,
			stream: async (request: ProviderRequest) => chunks(request),
		};

		return instance;
	}) as unknown as ProviderFactory;

	Object.defineProperty(factory, "name", { value: options.name, configurable: true, enumerable: true });
	Object.defineProperty(factory, "configSlots", {
		value: { apiKey: apiKeySlot(PI_RESOLVED_API_KEY), ...options.configSlots },
		enumerable: true,
	});

	return { name: options.name, model: options.model, provider: factory } as ModelDefinition;
}
