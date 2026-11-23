/**
 * A recorder standing in for PI's `ExtensionAPI`.
 *
 * It implements the surface the extension uses — `registerTool`, `on`,
 * `registerCommand`, `registerMessageRenderer`, `sendMessage`, `appendEntry` —
 * and stores every call, plus a `ctx` stub (`cwd`, `ui`, `modelRegistry`) for
 * handlers and tool executions. Every later test imports this.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** One recorded `on(event, handler)` call. */
export interface RecordedHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

/** One recorded `registerCommand` call. */
export interface RecordedCommand {
	name: string;
	options: unknown;
}

/** One recorded `registerMessageRenderer` call. */
export interface RecordedRenderer {
	customType: string;
	renderer: unknown;
}

/** One recorded `sendMessage` call. */
export interface RecordedMessage {
	message: unknown;
	options: unknown;
}

/** One recorded `appendEntry` call. */
export interface RecordedEntry {
	customType: string;
	data: unknown;
}

/** The recorder returned by {@link createFakePi}. */
export interface FakePi {
	/** The recorder cast to PI's interface, for calling the extension factory. */
	api: ExtensionAPI;
	tools: ToolDefinition[];
	handlers: RecordedHandler[];
	commands: RecordedCommand[];
	messageRenderers: RecordedRenderer[];
	messages: RecordedMessage[];
	entries: RecordedEntry[];
	/** A context stub, for handlers and `tool.execute(...)`. */
	ctx: ExtensionContext;
	/** Every handler registered for one event name, in registration order. */
	handlersFor(event: string): RecordedHandler[];
	/** The single registered tool, failing the test when it is not exactly one. */
	onlyTool(): ToolDefinition;
}

function createCtxStub(): ExtensionContext {
	const ui = {
		notify: (_message: string) => {},
		setStatus: (_key: string, _value: string | undefined) => {},
		setWidget: (_key: string, _value: unknown) => {},
		select: async (_title: string, _options: string[]) => undefined,
		confirm: async (_title: string, _message: string) => true,
		input: async (_title: string, _placeholder?: string) => undefined,
	};

	return {
		cwd: process.cwd(),
		ui,
		modelRegistry: {
			get: () => undefined,
			list: () => [],
		},
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "fake-session",
		},
	} as unknown as ExtensionContext;
}

/** Build a fresh recorder. No state is shared between calls. */
export function createFakePi(): FakePi {
	const tools: ToolDefinition[] = [];
	const handlers: RecordedHandler[] = [];
	const commands: RecordedCommand[] = [];
	const messageRenderers: RecordedRenderer[] = [];
	const messages: RecordedMessage[] = [];
	const entries: RecordedEntry[] = [];
	const ctx = createCtxStub();

	const recorder = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.push({ event, handler });
			return () => {
				const index = handlers.findIndex((h) => h.handler === handler && h.event === event);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		registerCommand(name: string, options: unknown) {
			commands.push({ name, options });
		},
		registerMessageRenderer(customType: string, renderer: unknown) {
			messageRenderers.push({ customType, renderer });
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
	};

	return {
		api: recorder as unknown as ExtensionAPI,
		tools,
		handlers,
		commands,
		messageRenderers,
		messages,
		entries,
		ctx,
		handlersFor(event: string) {
			return handlers.filter((h) => h.event === event);
		},
		onlyTool() {
			if (tools.length !== 1) {
				throw new Error(`expected exactly one registered tool, got ${tools.length}`);
			}
			return tools[0] as ToolDefinition;
		},
	};
}
