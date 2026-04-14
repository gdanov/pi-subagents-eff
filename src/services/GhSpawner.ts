/**
 * GhSpawner service.
 *
 * Wraps the GitHub CLI used by subagent-runner.ts:335-358 to publish
 * session HTML as a Gist when the user sets `share=true` on a run.
 *
 * Returns a full result shape rather than a raw URL so the executor
 * can still produce the `shareUrl` on top. Keeping the service narrow
 * (two methods) because `gh` is only used for this one feature.
 *
 * Live : spawnSync("gh", ...).
 * Test : returns a canned URL.
 */
import { spawnSync } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import { GhGistError } from "../errors.ts";

export interface GistResult {
	readonly gistUrl: string;
	readonly gistId: string;
}

export interface GhSpawnerService {
	/** True when `gh auth status` exits 0; false if gh is missing or not logged in. */
	readonly checkAuth: Effect.Effect<boolean>;
	/** Upload a file as a new Gist. Fails with GhGistError on any shell failure. */
	readonly createGist: (htmlPath: string) => Effect.Effect<GistResult, GhGistError>;
}

export class GhSpawner extends Context.Service<GhSpawner, GhSpawnerService>()(
	"pi-subagents/GhSpawner",
) {}

// ============================================================================
// Live
// ============================================================================

export const GhSpawnerLive = Layer.succeed(GhSpawner)(
	GhSpawner.of({
		checkAuth: Effect.sync(() => {
			// Legacy has a catch-all around the spawn call because gh might
			// be missing entirely. Keep that behavior but localise it here.
			try {
				const result = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
				return result.status === 0;
			} catch {
				return false;
			}
		}),
		createGist: (htmlPath) =>
			Effect.try({
				try: () => {
					const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
					if (auth.status !== 0) {
						throw new GhGistError({
							stderr: "GitHub CLI is not logged in. Run 'gh auth login' first.",
						});
					}
					const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
					if (result.status !== 0) {
						throw new GhGistError({
							stderr: (result.stderr ?? "").trim() || "Failed to create gist.",
						});
					}
					const gistUrl = (result.stdout ?? "").trim();
					const gistId = gistUrl.split("/").pop();
					if (!gistId) throw new GhGistError({ stderr: "Failed to parse gist ID." });
					return { gistUrl, gistId };
				},
				catch: (cause) =>
					cause instanceof GhGistError
						? cause
						: new GhGistError({
								stderr: cause instanceof Error ? cause.message : String(cause),
							}),
			}),
	}),
);

// ============================================================================
// Test
// ============================================================================

export interface GhSpawnerTestBuild {
	readonly layer: Layer.Layer<GhSpawner, never, never>;
}

export function makeGhSpawnerTest(options?: {
	readonly authed?: boolean;
	readonly gistUrl?: string;
	readonly failCreate?: string;
}): GhSpawnerTestBuild {
	const authed = options?.authed ?? true;
	const gistUrl = options?.gistUrl ?? "https://gist.github.com/test/0";
	const gistId = gistUrl.split("/").pop() ?? "0";
	return {
		layer: Layer.succeed(GhSpawner)(
			GhSpawner.of({
				checkAuth: Effect.succeed(authed),
				createGist: () => {
					if (!authed) return Effect.fail(new GhGistError({ stderr: "not authed" }));
					if (options?.failCreate) return Effect.fail(new GhGistError({ stderr: options.failCreate }));
					return Effect.succeed({ gistUrl, gistId });
				},
			}),
		),
	};
}
