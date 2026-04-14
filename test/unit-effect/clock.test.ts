/**
 * Tests for src/services/Clock.ts.
 *
 * Most of the value of this service is being able to swap in
 * Effect's TestClock for deterministic time travel. The tests below
 * verify the surface (sleep + setTimeoutScoped) and that interruption
 * via Scope close cancels a pending timer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Exit } from "effect";
import { SubagentsClock, SubagentsClockLive } from "../../src/services/Clock.ts";

describe("SubagentsClock", () => {
	it("currentTimeMillis returns a positive number close to Date.now()", async () => {
		const before = Date.now();
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const clock = yield* SubagentsClock;
					return yield* clock.currentTimeMillis;
				}),
				SubagentsClockLive,
			),
		);
		const after = Date.now();
		assert.ok(result >= before && result <= after);
	});

	it("sleep waits at least the requested duration", async () => {
		const start = Date.now();
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const clock = yield* SubagentsClock;
					yield* clock.sleep("50 millis");
				}),
				SubagentsClockLive,
			),
		);
		const elapsed = Date.now() - start;
		// Allow a small scheduler tolerance below the requested 50 ms;
		// the assertion only fails if the timer skipped entirely.
		assert.ok(elapsed >= 40, `elapsed ${elapsed}ms should be ~50ms`);
	});

	it("setTimeoutScoped is cancelled when its scope closes", async () => {
		// We arrange for a long-ish timer (1s) inside Effect.scoped,
		// then race it against an immediate completion. The scope
		// closes, which should interrupt the pending setTimeoutScoped
		// rather than keep the test hanging.
		const start = Date.now();
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.scoped(
					Effect.gen(function* () {
						const clock = yield* SubagentsClock;
						return yield* Effect.race(
							clock.setTimeoutScoped("1 seconds"),
							Effect.succeed("won"),
						);
					}),
				),
				SubagentsClockLive,
			),
		);
		const elapsed = Date.now() - start;
		assert.equal(Exit.isSuccess(exit), true);
		// Must complete fast — the eager Effect.succeed wins, the timer
		// is interrupted at scope close.
		assert.ok(elapsed < 200, `elapsed ${elapsed}ms should be well under 1s`);
	});
});
