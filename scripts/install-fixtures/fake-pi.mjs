/**
 * A recorder standing in for PI's `ExtensionAPI`, copied into the temp install.
 *
 * This is U01's `test/fake-pi.ts` as plain JS, with one addition: `notify`
 * collects what a command prints, so `/sa` can be invoked and read. It is a
 * *copy* on purpose — the tarball check must not import anything from this
 * repository, or it would prove the dev tree works instead of the published one.
 */

/** Build a fresh recorder. No state is shared between calls. */
export function createFakePi({ cwd = process.cwd() } = {}) {
	const tools = [];
	const handlers = [];
	const commands = [];
	const messageRenderers = [];
	const messages = [];
	const entries = [];
	const notifications = [];

	const ui = {
		notify: (message) => notifications.push(String(message)),
		setStatus: () => {},
		setWidget: () => {},
		select: async () => undefined,
		confirm: async () => true,
		input: async () => undefined,
	};

	const ctx = {
		cwd,
		ui,
		modelRegistry: { get: () => undefined, list: () => [] },
		sessionManager: { getEntries: () => [], getSessionId: () => "tarball-check" },
	};

	const recorder = {
		registerTool(tool) {
			tools.push(tool);
		},
		on(event, handler) {
			handlers.push({ event, handler });
			return () => {
				const index = handlers.findIndex((h) => h.handler === handler && h.event === event);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		registerCommand(name, options) {
			commands.push({ name, options });
		},
		registerMessageRenderer(customType, renderer) {
			messageRenderers.push({ customType, renderer });
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};

	return {
		api: recorder,
		tools,
		handlers,
		commands,
		messageRenderers,
		messages,
		entries,
		notifications,
		ctx,
		handlersFor(event) {
			return handlers.filter((handler) => handler.event === event);
		},
		toolNamed(name) {
			const found = tools.find((tool) => tool.name === name);
			if (!found) throw new Error(`the factory did not register '${name}'`);
			return found;
		},
		commandNamed(name) {
			const found = commands.find((command) => command.name === name);
			if (!found) throw new Error(`the factory did not register a command '${name}'`);
			return found;
		},
	};
}
