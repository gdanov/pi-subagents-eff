/**
 * Agent serialization — pure round-trip with the AgentConfig shape.
 *
 * Ported from agent-serializer.ts. Pure: no fs, no Effect.
 *
 * KNOWN_FIELDS controls which frontmatter keys round-trip via the
 * structured config object vs. fall through to `extraFields`. Keep
 * this list in sync with parseAgentFile in src/services/AgentDirectory.ts.
 */
import type { AgentConfig } from "../services/AgentDirectory.ts";

export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
	"name",
	"description",
	"tools",
	"model",
	"fallbackModels",
	"thinking",
	"skill",
	"skills",
	"extensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
]);

function joinComma(values: ReadonlyArray<string> | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return [...values].join(", ");
}

/**
 * Render an AgentConfig back to its on-disk `.md` form. Wire-compatible
 * with agent-serializer.ts:serializeAgent — re-parsing the output via
 * AgentDirectory.parseAgentFile must yield an equivalent AgentConfig.
 *
 * `extraFields` accepts arbitrary frontmatter keys not in KNOWN_FIELDS;
 * the new AgentConfig shape doesn't currently expose `extraFields` so
 * the optional second argument lets the caller pass them through.
 */
export function serializeAgent(
	config: AgentConfig,
	extraFields?: Readonly<Record<string, string>>,
): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);

	const tools = [
		...(config.tools ?? []),
		...((config.mcpDirectTools ?? []).map((t) => `mcp:${t}`)),
	];
	const toolsValue = joinComma(tools);
	if (toolsValue) lines.push(`tools: ${toolsValue}`);

	if (config.model) lines.push(`model: ${config.model}`);
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue) lines.push(`fallbackModels: ${fallbackModelsValue}`);
	if (config.thinking && config.thinking !== "off") lines.push(`thinking: ${config.thinking}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue) lines.push(`skills: ${skillsValue}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");
	if (
		config.maxSubagentDepth !== undefined &&
		Number.isInteger(config.maxSubagentDepth) &&
		config.maxSubagentDepth >= 0
	) {
		lines.push(`maxSubagentDepth: ${config.maxSubagentDepth}`);
	}

	if (extraFields) {
		for (const [key, value] of Object.entries(extraFields)) {
			if (KNOWN_FIELDS.has(key)) continue;
			lines.push(`${key}: ${value}`);
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}

/**
 * Pure agent-name sanitizer — used by management create/update to
 * coerce user input into a kebab-case slug acceptable as a filename.
 *
 * Ported from agent-management.ts:67.
 */
export function sanitizeName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}
