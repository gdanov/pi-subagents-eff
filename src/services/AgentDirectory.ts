/**
 * AgentDirectory service.
 *
 * Reads agent and skill markdown files from the three scopes (builtin /
 * user / project) and parses YAML frontmatter. Replaces:
 *   - agents.ts (discovery, parse, scope merging)
 *   - skills.ts (skill discovery + injection)
 *   - frontmatter.ts (YAML parse helper)
 *
 * Depends on FileSystem.
 */
import { Context, Effect, Layer } from "effect";
import type { ConfigParseError, FsReadError } from "../errors.ts";

/** Replaced by Schema-decoded value in Phase 2. */
export interface AgentConfig {
	readonly name: string;
	readonly description?: string;
	readonly systemPrompt: string;
	readonly model?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string> | null;
	readonly skills?: ReadonlyArray<string>;
	readonly thinking?: string;
	readonly fallbackModels?: ReadonlyArray<string>;
	readonly maxSubagentDepth?: number;
	readonly scope: "builtin" | "user" | "project";
	readonly filePath: string;
}

export interface AgentDirectoryService {
	readonly discover: (cwd: string, scope: "user" | "project" | "both") => Effect.Effect<ReadonlyArray<AgentConfig>, FsReadError | ConfigParseError>;
	readonly discoverSkills: (cwd: string) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly path: string }>, FsReadError>;
}

export class AgentDirectory extends Context.Service<AgentDirectory, AgentDirectoryService>()(
	"pi-subagents/AgentDirectory",
) {}

export const AgentDirectoryLive = Layer.sync(AgentDirectory)(() => {
	throw new Error("AgentDirectory.Live not yet implemented (Phase 3)");
});

export const makeAgentDirectoryTest = (
	_agents: ReadonlyArray<AgentConfig> = [],
): Layer.Layer<AgentDirectory, never, never> =>
	Layer.sync(AgentDirectory)(() => {
		throw new Error("AgentDirectory.Test not yet implemented (Phase 3)");
	});
