/**
 * GhSpawner service.
 *
 * Wraps the `gh` CLI used by subagent-runner.ts:337 (auth status check)
 * and :346 (gist create) for the optional `share=true` feature.
 *
 * Live : spawnSync('gh', ...) wrapper.
 * Test : returns canned URLs / auth status without touching the network.
 */
import { Context, Effect, Layer } from "effect";
import type { GhGistError } from "../errors.ts";

export interface GhSpawnerService {
	readonly checkAuth: Effect.Effect<boolean>;
	readonly createGist: (htmlPath: string, opts?: { readonly description?: string }) => Effect.Effect<string, GhGistError>;
}

export class GhSpawner extends Context.Service<GhSpawner, GhSpawnerService>()("pi-subagents/GhSpawner") {}

export const GhSpawnerLive = Layer.sync(GhSpawner)(() => {
	throw new Error("GhSpawner.Live not yet implemented (Phase 4)");
});

export const makeGhSpawnerTest = (
	_url: string = "https://gist.github.com/test/0",
): Layer.Layer<GhSpawner, never, never> =>
	Layer.sync(GhSpawner)(() => {
		throw new Error("GhSpawner.Test not yet implemented (Phase 4)");
	});
