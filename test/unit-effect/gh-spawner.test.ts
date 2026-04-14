/**
 * Tests for src/services/GhSpawner.ts — Test layer only.
 *
 * The Live layer shells out to `gh` which needs a real GitHub login
 * and has network side-effects; exercising it in CI is not worth the
 * flakiness. The executor code paths that consume GhSpawner (Phase 5+)
 * always use the Test layer for unit coverage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { GhGistError } from "../../src/errors.ts";
import { GhSpawner, makeGhSpawnerTest } from "../../src/services/GhSpawner.ts";

describe("GhSpawner Test layer", () => {
	it("checkAuth reflects the configured auth state", async () => {
		const yesLayer = makeGhSpawnerTest({ authed: true }).layer;
		const noLayer = makeGhSpawnerTest({ authed: false }).layer;

		const yes = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const gh = yield* GhSpawner;
					return yield* gh.checkAuth;
				}),
				yesLayer,
			),
		);
		const no = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const gh = yield* GhSpawner;
					return yield* gh.checkAuth;
				}),
				noLayer,
			),
		);
		assert.equal(yes, true);
		assert.equal(no, false);
	});

	it("createGist returns a stable URL when authed", async () => {
		const test = makeGhSpawnerTest({ gistUrl: "https://gist.github.com/u/abc123" });
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const gh = yield* GhSpawner;
					return yield* gh.createGist("/tmp/session.html");
				}),
				test.layer,
			),
		);
		assert.equal(result.gistUrl, "https://gist.github.com/u/abc123");
		assert.equal(result.gistId, "abc123");
	});

	it("createGist fails with GhGistError when not authed", async () => {
		const test = makeGhSpawnerTest({ authed: false });
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const gh = yield* GhSpawner;
					return yield* gh.createGist("/tmp/session.html");
				}),
				test.layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) assert.ok(err.value instanceof GhGistError);
		} else {
			assert.fail("expected failure");
		}
	});

	it("createGist fails with a configurable reason", async () => {
		const test = makeGhSpawnerTest({ failCreate: "quota exceeded" });
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const gh = yield* GhSpawner;
					return yield* gh.createGist("/tmp/session.html");
				}),
				test.layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) {
				assert.ok(err.value instanceof GhGistError);
				assert.equal(err.value.stderr, "quota exceeded");
			}
		} else {
			assert.fail("expected failure");
		}
	});
});
