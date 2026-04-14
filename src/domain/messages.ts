/**
 * Pure message-shape helpers ported from utils.ts:188-355.
 *
 * The `Message` type comes from @mariozechner/pi-ai. We don't depend
 * on it directly here — the legacy code's parsing was duck-typed
 * against the message structure, and that flexibility is useful when
 * the same helpers run in places where the full pi-ai dependency
 * graph isn't in scope (e.g., the standalone runner).
 *
 * The legacy `detectSubagentError` (utils.ts:226-296) is intentionally
 * NOT ported. Per the plan it's replaced by typed traversal yielding
 * SubagentToolError tags directly from the executor — see Phase 5.
 */

export type DisplayItem =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "tool"; readonly name: string; readonly args: Record<string, unknown> };

interface AssistantTextPart {
	readonly type: "text";
	readonly text: string;
}

interface AssistantToolCallPart {
	readonly type: "toolCall";
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

type AssistantPart = AssistantTextPart | AssistantToolCallPart | { readonly type: string };

interface AssistantMessage {
	readonly role: "assistant";
	readonly content: ReadonlyArray<AssistantPart>;
}

interface NonAssistantMessage {
	readonly role: string;
}

type MinimalMessage = AssistantMessage | NonAssistantMessage;

function isAssistant(msg: MinimalMessage): msg is AssistantMessage {
	return msg.role === "assistant";
}

/**
 * Last assistant text response in the conversation. Empty string if
 * none found (matches legacy semantics).
 */
export function getFinalOutput(messages: ReadonlyArray<MinimalMessage>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && isAssistant(msg)) {
			for (const part of msg.content) {
				if (part.type === "text") return (part as AssistantTextPart).text;
			}
		}
	}
	return "";
}

export function getSingleResultOutput(result: {
	readonly finalOutput?: string;
	readonly messages: ReadonlyArray<MinimalMessage>;
}): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

/** Flatten assistant messages into a display sequence (text + tool calls). */
export function getDisplayItems(messages: ReadonlyArray<MinimalMessage>): ReadonlyArray<DisplayItem> {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (!isAssistant(msg)) continue;
		for (const part of msg.content) {
			if (part.type === "text") {
				items.push({ type: "text", text: (part as AssistantTextPart).text });
			} else if (part.type === "toolCall") {
				const tool = part as AssistantToolCallPart;
				items.push({ type: "tool", name: tool.name, args: tool.arguments });
			}
		}
	}
	return items;
}

/**
 * Display preview for a tool-call's arguments object.
 * MCP tool calls (with `tool` + `server` fields) get a special format;
 * common preview keys are tried in priority order; falls back to the
 * first non-empty string-valued field.
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
	if (typeof args.tool === "string") {
		const server = typeof args.server === "string" ? `${args.server}/` : "";
		const toolArgs = typeof args.args === "string" ? ` ${args.args.slice(0, 40)}` : "";
		return `${server}${args.tool}${toolArgs}`;
	}

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}

	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > 0) {
			const preview = value.length > 50 ? `${value.slice(0, 47)}...` : value;
			return `${key}=${preview}`;
		}
	}
	return "";
}

/**
 * Extract a flat text representation from a polymorphic content value
 * (string, array of parts, or unrecognized shape). Used by the renderer
 * and by tool-output post-processing.
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ("type" in part && (part as { type: unknown }).type === "text" && "text" in part) {
			texts.push(String((part as { text: unknown }).text));
		} else if (
			"type" in part &&
			(part as { type: unknown }).type === "tool_result" &&
			"content" in part
		) {
			const inner = extractTextFromContent((part as { content: unknown }).content);
			if (inner) texts.push(inner);
		} else if ("text" in part) {
			texts.push(String((part as { text: unknown }).text));
		}
	}
	return texts.join("\n");
}
