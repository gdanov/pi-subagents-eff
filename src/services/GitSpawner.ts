/**
 * GitSpawner service.
 *
 * Thin Effect wrapper around the `git -C <cwd> <args...>` shell. The
 * heavier worktree orchestration (node_modules linking, synthetic
 * paths, setup hooks, per-task diff capture) lives on top of this in
 * `executor/parallel.ts` (Phase 6) — that's domain logic, not a
 * spawner concern. What this service owns is the shell surface + the
 * error tagging.
 *
 * Replaces `worktree.ts:83-100` (runGit + runGitChecked) and the raw
 * `spawnSync("git", ...)` call sites scattered through the legacy
 * worktree module.
 *
 * Live : node:child_process.spawnSync, matches legacy synchronous
 *        semantics (the git operations run fast and the parallel-
 *        execution orchestrator doesn't benefit from async here).
 * Test : in-memory repo state (stubbed).
 */
import { spawnSync } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import { GitWorktreeError } from "../errors.ts";

export interface GitResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number | null;
}

export interface GitSpawnerService {
	/** Low-level: runs `git -C cwd <args...>`. Returns the raw result. */
	readonly run: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<GitResult>;
	/** Same as `run` but fails with GitWorktreeError on non-zero exit. */
	readonly runChecked: (
		op: "add" | "remove" | "list" | "diff",
		cwd: string,
		args: ReadonlyArray<string>,
	) => Effect.Effect<string, GitWorktreeError>;
	/** Verify that `cwd` is inside a git work-tree with a clean status. */
	readonly assertCleanRepo: (cwd: string) => Effect.Effect<
		{ readonly toplevel: string; readonly cwdRelative: string; readonly baseCommit: string },
		GitWorktreeError
	>;
}

export class GitSpawner extends Context.Service<GitSpawner, GitSpawnerService>()(
	"pi-subagents/GitSpawner",
) {}

// ============================================================================
// Live
// ============================================================================

function runGit(cwd: string, args: ReadonlyArray<string>): Effect.Effect<GitResult> {
	return Effect.sync(() => {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
		};
	});
}

function runGitChecked(
	op: "add" | "remove" | "list" | "diff",
	cwd: string,
	args: ReadonlyArray<string>,
): Effect.Effect<string, GitWorktreeError> {
	return Effect.gen(function* () {
		const result = yield* runGit(cwd, args);
		if (result.status !== 0) {
			const stderr =
				result.stderr.trim() || result.stdout.trim() || `git -C ${cwd} ${args.join(" ")} failed`;
			return yield* Effect.fail(new GitWorktreeError({ operation: op, cwd, stderr }));
		}
		return result.stdout;
	});
}

const assertCleanRepo = (
	cwd: string,
): Effect.Effect<
	{ readonly toplevel: string; readonly cwdRelative: string; readonly baseCommit: string },
	GitWorktreeError
> =>
	Effect.gen(function* () {
		const repoCheck = yield* runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
		if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
			return yield* Effect.fail(
				new GitWorktreeError({
					operation: "list",
					cwd,
					stderr: "worktree isolation requires a git repository",
				}),
			);
		}

		const toplevel = (yield* runGitChecked("list", cwd, ["rev-parse", "--show-toplevel"])).trim();
		const rawPrefix = (yield* runGitChecked("list", cwd, ["rev-parse", "--show-prefix"])).trim();
		const cwdRelative = rawPrefix ? rawPrefix.replace(/[\\/]+$/, "") : "";

		const status = yield* runGitChecked("list", toplevel, ["status", "--porcelain"]);
		if (status.trim().length > 0) {
			return yield* Effect.fail(
				new GitWorktreeError({
					operation: "list",
					cwd: toplevel,
					stderr: "worktree isolation requires a clean git working tree. Commit or stash changes first.",
				}),
			);
		}

		const baseCommit = (yield* runGitChecked("list", toplevel, ["rev-parse", "HEAD"])).trim();
		return { toplevel, cwdRelative, baseCommit };
	});

export const GitSpawnerLive = Layer.succeed(GitSpawner)(
	GitSpawner.of({
		run: runGit,
		runChecked: runGitChecked,
		assertCleanRepo,
	}),
);

// ============================================================================
// Test
// ============================================================================

export interface FakeGitCall {
	readonly cwd: string;
	readonly args: ReadonlyArray<string>;
}

export interface GitSpawnerTestBuild {
	readonly layer: Layer.Layer<GitSpawner, never, never>;
	readonly calls: () => ReadonlyArray<FakeGitCall>;
}

/**
 * Script-driven Test: each git invocation is matched against a
 * predicate from `handlers`; the first matching handler's `reply` is
 * returned. If nothing matches, the call fails with GitWorktreeError.
 */
export interface GitSpawnerTestHandler {
	readonly match: (cwd: string, args: ReadonlyArray<string>) => boolean;
	readonly reply: GitResult;
}

export function makeGitSpawnerTest(handlers: ReadonlyArray<GitSpawnerTestHandler>): GitSpawnerTestBuild {
	const calls: FakeGitCall[] = [];

	const run = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<GitResult> =>
		Effect.sync(() => {
			calls.push({ cwd, args });
			const handler = handlers.find((h) => h.match(cwd, args));
			if (!handler) return { stdout: "", stderr: "git test: no handler matched", status: 1 };
			return handler.reply;
		});

	const runChecked = (
		op: "add" | "remove" | "list" | "diff",
		cwd: string,
		args: ReadonlyArray<string>,
	): Effect.Effect<string, GitWorktreeError> =>
		Effect.gen(function* () {
			const result = yield* run(cwd, args);
			if (result.status !== 0) {
				return yield* Effect.fail(
					new GitWorktreeError({
						operation: op,
						cwd,
						stderr: result.stderr || "test git failure",
					}),
				);
			}
			return result.stdout;
		});

	return {
		layer: Layer.succeed(GitSpawner)(
			GitSpawner.of({
				run,
				runChecked,
				assertCleanRepo: () =>
					Effect.succeed({ toplevel: "/fake-repo", cwdRelative: "", baseCommit: "fakehash" }),
			}),
		),
		calls: () => calls,
	};
}
