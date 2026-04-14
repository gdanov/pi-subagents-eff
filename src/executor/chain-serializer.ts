/**
 * Chain serialization — pure parse / serialize for `.chain.md` files.
 *
 * Ported line-for-line from chain-serializer.ts. Pure: no fs, no Effect.
 *
 * On-disk format (preserved exactly):
 *
 *   ---
 *   name: my-chain
 *   description: ...
 *   ---
 *
 *   ## scout
 *   output: context.md
 *   reads: shared.md
 *   model: anthropic/claude-sonnet-4
 *
 *   Find the configs.
 *
 *   ## planner
 *   reads: context.md
 *
 *   Plan the changes.
 *
 * `## <agent>` is the per-step header; lines before the first blank
 * inside a section are step config (output/reads/model/skills/progress);
 * everything after the blank is the step's task body.
 */
import { parseFrontmatter } from "../services/AgentDirectory.ts";

export type ChainSource = "user" | "project";

export interface ChainStepConfig {
	readonly agent: string;
	readonly task: string;
	readonly output?: string | false;
	readonly reads?: ReadonlyArray<string> | false;
	readonly model?: string;
	readonly skills?: ReadonlyArray<string> | false;
	readonly progress?: boolean;
}

export interface ChainConfig {
	readonly name: string;
	readonly description: string;
	readonly source: ChainSource;
	readonly filePath: string;
	readonly steps: ReadonlyArray<ChainStepConfig>;
	readonly extraFields?: Readonly<Record<string, string>>;
}

// ============================================================================
// Parse
// ============================================================================

function parseStepBody(agent: string, sectionBody: string): ChainStepConfig {
	const lines = sectionBody.split("\n");
	const blankIndex = lines.findIndex((line) => line.trim() === "");
	const configLines = blankIndex === -1 ? lines : lines.slice(0, blankIndex);
	const task = (blankIndex === -1 ? "" : lines.slice(blankIndex + 1).join("\n")).trim();

	let output: string | false | undefined;
	let reads: ReadonlyArray<string> | false | undefined;
	let model: string | undefined;
	let skills: ReadonlyArray<string> | false | undefined;
	let progress: boolean | undefined;

	for (const line of configLines) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = (match[1] ?? "").trim().toLowerCase();
		const rawValue = (match[2] ?? "").trim();

		if (key === "output") {
			if (rawValue === "false") output = false;
			else if (rawValue) output = rawValue;
		} else if (key === "reads") {
			if (rawValue === "false") {
				reads = false;
			} else {
				const parsed = rawValue.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
				reads = parsed.length > 0 ? parsed : false;
			}
		} else if (key === "model") {
			if (rawValue) model = rawValue;
		} else if (key === "skills") {
			if (rawValue === "false") {
				skills = false;
			} else {
				const parsed = rawValue.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
				skills = parsed.length > 0 ? parsed : false;
			}
		} else if (key === "progress") {
			if (rawValue === "true") progress = true;
			else if (rawValue === "false") progress = false;
		}
	}

	return {
		agent,
		task,
		...(output !== undefined ? { output } : {}),
		...(reads !== undefined ? { reads } : {}),
		...(model !== undefined ? { model } : {}),
		...(skills !== undefined ? { skills } : {}),
		...(progress !== undefined ? { progress } : {}),
	};
}

export function parseChain(content: string, source: ChainSource, filePath: string): ChainConfig {
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter.name || !frontmatter.description) {
		throw new Error("Chain frontmatter must include name and description");
	}

	const matches = [...body.matchAll(/^##\s+(.+)[^\S\n]*$/gm)];
	const steps: ChainStepConfig[] = [];

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const agent = (match[1] ?? "").trim();
		const matchIndex = match.index ?? 0;
		const lineEndOffset = body[matchIndex + match[0].length] === "\n" ? 1 : 0;
		const sectionStart = matchIndex + match[0].length + lineEndOffset;
		const next = matches[i + 1];
		const sectionEnd = next ? (next.index ?? body.length) : body.length;
		const sectionBody = body.slice(sectionStart, sectionEnd).trimEnd();
		steps.push(parseStepBody(agent, sectionBody));
	}

	const extraFields: Record<string, string> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === "name" || key === "description") continue;
		extraFields[key] = value;
	}

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		source,
		filePath,
		steps,
		...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
	};
}

// ============================================================================
// Serialize
// ============================================================================

export function serializeChain(config: ChainConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);
	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---");
	lines.push("");

	for (let i = 0; i < config.steps.length; i++) {
		const step = config.steps[i]!;
		lines.push(`## ${step.agent}`);
		if (step.output === false) lines.push("output: false");
		else if (step.output) lines.push(`output: ${step.output}`);
		if (step.reads === false) lines.push("reads: false");
		else if (Array.isArray(step.reads) && step.reads.length > 0)
			lines.push(`reads: ${[...step.reads].join(", ")}`);
		if (step.model) lines.push(`model: ${step.model}`);
		if (step.skills === false) lines.push("skills: false");
		else if (Array.isArray(step.skills) && step.skills.length > 0)
			lines.push(`skills: ${[...step.skills].join(", ")}`);
		if (step.progress !== undefined) lines.push(`progress: ${step.progress ? "true" : "false"}`);
		lines.push("");
		lines.push(step.task ?? "");
		if (i < config.steps.length - 1) lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
