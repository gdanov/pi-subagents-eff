/**
 * GitSpawner service.
 *
 * Wraps every `git` invocation in worktree.ts (worktree add/remove/list,
 * diff). Split from PiSpawner so test layers for non-worktree code paths
 * don't need to mock git.
 *
 * Live : node:child_process.spawnSync wrapper (matches today's behavior).
 * Test : in-memory worktree registry.
 */
import { Context, Effect, Layer } from "effect";
import type { GitWorktreeError } from "../errors.ts";

export interface WorktreeAddSpec {
	readonly cwd: string;
	readonly path: string;
	readonly branch?: string;
}

export interface GitSpawnerService {
	readonly worktreeAdd: (spec: WorktreeAddSpec) => Effect.Effect<void, GitWorktreeError>;
	readonly worktreeRemove: (cwd: string, path: string) => Effect.Effect<void, GitWorktreeError>;
	readonly worktreeList: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitWorktreeError>;
	readonly diff: (cwd: string) => Effect.Effect<string, GitWorktreeError>;
	readonly assertCleanRepo: (cwd: string) => Effect.Effect<void, GitWorktreeError>;
}

export class GitSpawner extends Context.Service<GitSpawner, GitSpawnerService>()("pi-subagents/GitSpawner") {}

export const GitSpawnerLive = Layer.sync(GitSpawner)(() => {
	throw new Error("GitSpawner.Live not yet implemented (Phase 4)");
});

export const makeGitSpawnerTest = (): Layer.Layer<GitSpawner, never, never> =>
	Layer.sync(GitSpawner)(() => {
		throw new Error("GitSpawner.Test not yet implemented (Phase 4)");
	});
