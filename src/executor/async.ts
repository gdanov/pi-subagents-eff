/**
 * Async execution mode.
 *
 * Replaces async-execution.ts + async-status.ts + subagents-status.ts.
 * Forks a daemon fiber via runtime.runFork at the boundary; the fiber
 * spawns the runner subprocess and writes status.json via ArtifactStore.
 *
 * Replies to the executor with the runId immediately; the result-watcher
 * picks up the eventual result file.
 *
 * Implementation lands in Phase 7.
 */
export {};
