/**
 * AgentDirectory service.
 *
 * Phase 3 scope: agent discovery + frontmatter parsing for a single
 * directory. The builtin-override merging, scope precedence, and chain
 * discovery all live in the executor/management surface (Phase 8) — they
 * involve writes and a full settings.json round-trip that's out of
 * scope here.
 *
 * Replaces the read paths of agents.ts (the full file also covers
 * builtin overrides, settings file IO, and CRUD; those follow in
 * Phase 8). Frontmatter parsing is its own pure helper exposed for
 * reuse.
 */
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { ConfigParseError, FsReadError } from "../errors.ts";
import { FileSystem } from "./FileSystem.ts";

// ============================================================================
// AgentConfig — wire-compatible with legacy agents.ts:43-63
// ============================================================================

export type AgentSource = "builtin" | "user" | "project";
export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	readonly name: string;
	readonly description: string;
	readonly tools?: ReadonlyArray<string>;
	readonly mcpDirectTools?: ReadonlyArray<string>;
	readonly model?: string;
	readonly fallbackModels?: ReadonlyArray<string>;
	readonly thinking?: string;
	readonly systemPrompt: string;
	readonly source: AgentSource;
	readonly filePath: string;
	readonly skills?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly output?: string;
	readonly defaultReads?: ReadonlyArray<string>;
	readonly defaultProgress?: boolean;
	readonly interactive?: boolean;
	readonly maxSubagentDepth?: number;
}

// ============================================================================
// Frontmatter parsing — pure
// ============================================================================

/**
 * Parse YAML-ish frontmatter (a strict line-key form, not a full YAML
 * parser — matches the legacy frontmatter.ts:1).
 */
export function parseFrontmatter(content: string): {
	readonly frontmatter: Readonly<Record<string, string>>;
	readonly body: string;
} {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) return { frontmatter, body: normalized };

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter, body: normalized };

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1];
		let value = (match[2] ?? "").trim();
		if (key === undefined) continue;
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value;
	}

	return { frontmatter, body };
}

// ============================================================================
// Frontmatter -> AgentConfig
// ============================================================================

function splitCsv(value: string | undefined): ReadonlyArray<string> | undefined {
	if (value === undefined) return undefined;
	const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	return parts.length > 0 ? parts : undefined;
}

function partitionTools(rawTools: ReadonlyArray<string> | undefined): {
	readonly tools?: ReadonlyArray<string>;
	readonly mcpDirectTools?: ReadonlyArray<string>;
} {
	if (!rawTools) return {};
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const tool of rawTools) {
		if (tool.startsWith("mcp:")) mcpDirectTools.push(tool.slice(4));
		else tools.push(tool);
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

/**
 * Parse one .md file's frontmatter+body into an AgentConfig.
 * Returns `undefined` when the required `name` / `description` fields
 * are missing (matches the legacy agents.ts:378 silent-skip behavior).
 */
export function parseAgentFile(input: {
	readonly content: string;
	readonly filePath: string;
	readonly source: AgentSource;
}): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter(input.content);
	if (!frontmatter.name || !frontmatter.description) return undefined;

	const rawTools = splitCsv(frontmatter.tools);
	const { tools, mcpDirectTools } = partitionTools(rawTools);

	const skillStr = frontmatter.skill ?? frontmatter.skills;
	const skills = splitCsv(skillStr);
	const fallbackModels = splitCsv(frontmatter.fallbackModels);
	const defaultReads = splitCsv(frontmatter.defaultReads);
	const extensions =
		frontmatter.extensions !== undefined ? splitCsv(frontmatter.extensions) ?? [] : undefined;

	const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
	const maxSubagentDepth =
		Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
			? parsedMaxSubagentDepth
			: undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools,
		mcpDirectTools,
		model: frontmatter.model,
		fallbackModels,
		thinking: frontmatter.thinking,
		systemPrompt: body,
		source: input.source,
		filePath: input.filePath,
		skills,
		extensions,
		output: frontmatter.output,
		defaultReads,
		defaultProgress: frontmatter.defaultProgress === "true",
		interactive: frontmatter.interactive === "true",
		maxSubagentDepth,
	};
}

// ============================================================================
// Service surface
// ============================================================================

export interface AgentDirectoryService {
	/** Discover all agents in the standard scopes. Failures inside one
	 *  directory are swallowed (best-effort, matches legacy semantics). */
	readonly discover: (
		cwd: string,
		scope: AgentScope,
	) => Effect.Effect<ReadonlyArray<AgentConfig>, FsReadError | ConfigParseError>;
	/** Discover agents from a single directory. Useful for tests and
	 *  for the management surface to enumerate per-scope. */
	readonly discoverIn: (
		dir: string,
		source: AgentSource,
	) => Effect.Effect<ReadonlyArray<AgentConfig>, FsReadError | ConfigParseError>;
}

export class AgentDirectory extends Context.Service<AgentDirectory, AgentDirectoryService>()(
	"pi-subagents/AgentDirectory",
) {}

// ============================================================================
// Path discovery (mirrors agents.ts:148, :501)
// ============================================================================

const USER_AGENTS_DIR_OLD = path.join(os.homedir(), ".pi", "agent", "agents");
const USER_AGENTS_DIR_NEW = path.join(os.homedir(), ".agents");

function findNearestProjectAgentsDir(
	cwd: string,
	isDir: (p: string) => boolean,
): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDir(path.join(currentDir, ".pi")) || isDir(path.join(currentDir, ".agents"))) {
			const candidateAlt = path.join(currentDir, ".agents");
			if (isDir(candidateAlt)) return candidateAlt;
			const candidate = path.join(currentDir, ".pi", "agents");
			if (isDir(candidate)) return candidate;
			return null;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ============================================================================
// Live
// ============================================================================

export const AgentDirectoryLive = Layer.effect(AgentDirectory)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;

		const isDirSync = (p: string): boolean => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		};

		const discoverIn = (
			dir: string,
			source: AgentSource,
		): Effect.Effect<ReadonlyArray<AgentConfig>, FsReadError | ConfigParseError> =>
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(dir);
				if (!exists) return [] as ReadonlyArray<AgentConfig>;

				const entries = yield* fsApi.readDir(dir).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
				);
				const mdFiles = entries.filter(
					(e) => e.endsWith(".md") && !e.endsWith(".chain.md"),
				);

				const results: AgentConfig[] = [];
				for (const file of mdFiles) {
					const filePath = path.join(dir, file);
					const content = yield* fsApi.read(filePath).pipe(
						Effect.catchTag("FsNotFound", () => Effect.succeed("")),
						Effect.catchTag("FsReadError", () => Effect.succeed("")),
					);
					if (!content) continue;
					const parsed = parseAgentFile({ content, filePath, source });
					if (parsed) results.push(parsed);
				}
				return results;
			});

		const discover = (
			cwd: string,
			scope: AgentScope,
		): Effect.Effect<ReadonlyArray<AgentConfig>, FsReadError | ConfigParseError> =>
			Effect.gen(function* () {
				const wantUser = scope === "user" || scope === "both";
				const wantProject = scope === "project" || scope === "both";

				const userOld = wantUser
					? yield* discoverIn(USER_AGENTS_DIR_OLD, "user")
					: ([] as ReadonlyArray<AgentConfig>);
				const userNew = wantUser
					? yield* discoverIn(USER_AGENTS_DIR_NEW, "user")
					: ([] as ReadonlyArray<AgentConfig>);

				const projectDir = wantProject ? findNearestProjectAgentsDir(cwd, isDirSync) : null;
				const project = projectDir
					? yield* discoverIn(projectDir, "project")
					: ([] as ReadonlyArray<AgentConfig>);

				return [...userOld, ...userNew, ...project];
			});

		return AgentDirectory.of({ discover, discoverIn });
	}),
);

export const AgentDirectoryTest: Layer.Layer<AgentDirectory, never, FileSystem> = AgentDirectoryLive;
