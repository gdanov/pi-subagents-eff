/**
 * Tagged errors for the entire pi-subagents extension.
 *
 * Every failure mode is modeled as a `Data.TaggedError` so it flows through
 * the Effect error channel and can be handled with `Effect.catchTag` /
 * `Effect.catchTags` instead of string-pattern detection or silent try/catch.
 *
 * Grouped by subsystem:
 *   - FS:      filesystem read/write/watch failures
 *   - Process: child-process spawn failures (pi runner, git, gh)
 *   - Subagent: semantic failures from a subagent's own execution
 *   - Schema:  decode failures at the tool/config boundary
 *   - Config:  config-file load/parse failures
 *   - Recursion: subagent depth guard
 *   - Async:   background-job lifecycle failures
 *   - Chain:   pipeline orchestration failures
 *   - TUI:     interactive-component failures
 */
import { Data } from "effect";

// ============================================================================
// Filesystem
// ============================================================================

export class FsReadError extends Data.TaggedError("FsReadError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export class FsWriteError extends Data.TaggedError("FsWriteError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export class FsWatchError extends Data.TaggedError("FsWatchError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/**
 * Distinct from FsReadError so callers can do
 *   .pipe(Effect.catchTag("FsNotFound", () => Effect.succeed(defaultValue)))
 * for optional-file reads (replaces today's silent try/catch in result-watcher,
 * artifacts cleanup, run-history load, etc.).
 */
export class FsNotFound extends Data.TaggedError("FsNotFound")<{
	readonly path: string;
}> {}

// ============================================================================
// Process spawning
// ============================================================================

export class PiSpawnError extends Data.TaggedError("PiSpawnError")<{
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cause: unknown;
}> {}

export class PiNonZeroExit extends Data.TaggedError("PiNonZeroExit")<{
	readonly exitCode: number;
	readonly stderr: string;
}> {}

export class PiAborted extends Data.TaggedError("PiAborted")<{
	readonly signal: NodeJS.Signals;
}> {}

/**
 * Replaces the `-2` exit-code sentinel at execution.ts:155.
 * Raised when the runner detects the intercom-bridge has detached the
 * subagent into the parent session; the executor catches this tag and
 * produces a successful SingleResult { detached: true }.
 */
export class PiDetachedForIntercom extends Data.TaggedError("PiDetachedForIntercom")<{
	readonly reason: string;
}> {}

export class GitWorktreeError extends Data.TaggedError("GitWorktreeError")<{
	readonly operation: "add" | "remove" | "list" | "diff";
	readonly cwd: string;
	readonly stderr: string;
}> {}

export class GhGistError extends Data.TaggedError("GhGistError")<{
	readonly stderr: string;
}> {}

// ============================================================================
// Subagent semantic failures
// ============================================================================

/**
 * Replaces the string-pattern scan in utils.ts:226 (detectSubagentError).
 * The producer side already structures tool-execution events; this tag
 * surfaces a tool that returned an error result.
 */
export class SubagentToolError extends Data.TaggedError("SubagentToolError")<{
	readonly toolName: string;
	readonly exitCode?: number;
	readonly details: string;
}> {}

export class SubagentMessageError extends Data.TaggedError("SubagentMessageError")<{
	readonly message: string;
}> {}

// ============================================================================
// Schema
// ============================================================================

export class SchemaDecodeError extends Data.TaggedError("SchemaDecodeError")<{
	readonly where: string;
	readonly cause: unknown;
}> {}

// ============================================================================
// Config
// ============================================================================

export class ConfigParseError extends Data.TaggedError("ConfigParseError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export class ConfigPathError extends Data.TaggedError("ConfigPathError")<{
	readonly path: string;
	readonly reason: string;
}> {}

// ============================================================================
// Recursion guard
// ============================================================================

export class SubagentDepthExceeded extends Data.TaggedError("SubagentDepthExceeded")<{
	readonly depth: number;
	readonly maxDepth: number;
}> {}

// ============================================================================
// Async runner
// ============================================================================

export class AsyncJobNotFound extends Data.TaggedError("AsyncJobNotFound")<{
	readonly idOrPrefix: string;
}> {}

export class AsyncStatusCorrupt extends Data.TaggedError("AsyncStatusCorrupt")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export class AsyncJobTimeout extends Data.TaggedError("AsyncJobTimeout")<{
	readonly id: string;
	readonly waitedMs: number;
}> {}

// ============================================================================
// Chain
// ============================================================================

export class ChainTemplateError extends Data.TaggedError("ChainTemplateError")<{
	readonly stepIndex: number;
	readonly unresolved: ReadonlyArray<string>;
}> {}

export class ChainStepFailed extends Data.TaggedError("ChainStepFailed")<{
	readonly stepIndex: number;
	readonly agent: string;
	readonly cause: unknown;
}> {}

// ============================================================================
// TUI
// ============================================================================

export class TuiCancelled extends Data.TaggedError("TuiCancelled")<{
	readonly screen: string;
}> {}

export class TuiInputError extends Data.TaggedError("TuiInputError")<{
	readonly screen: string;
	readonly cause: unknown;
}> {}
