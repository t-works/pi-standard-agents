/**
 * Walking-skeleton extension: proves the whole PI path — default factory → tool
 * registration → execute → result — before any runtime code exists.
 *
 * PI's extension ABI is a *default* factory (sync or async). A named `activate`
 * export makes PI fail with "Extension does not export a valid factory function".
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Name of the single tool this unit registers. */
export const PING_TOOL_NAME = "std_smoke";

/** Fixed text the ping tool returns. */
export const PING_RESULT = "pong from pi-standard-agents";

export default function standardAgentsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PING_TOOL_NAME,
		label: "Standard Agents Ping",
		description:
			"Return a fixed string. Used to verify that the pi-standard-agents extension is loaded and reachable.",
		promptSnippet: `${PING_TOOL_NAME}: verify the pi-standard-agents extension is loaded`,
		parameters: Type.Object({
			note: Type.Optional(
				Type.String({ description: "Free-form note echoed back in the tool details." }),
			),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text" as const, text: PING_RESULT }],
				details: { note: params.note ?? null },
			};
		},
	});

	// Lifecycle wiring is proven here; U04 puts the runtime behind it.
	pi.on("session_start", () => {
		// no runtime yet
	});
	pi.on("session_shutdown", () => {
		// no runtime yet
	});
}
