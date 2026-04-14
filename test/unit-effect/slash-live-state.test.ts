/**
 * Tests for src/services/SlashLiveState.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { SlashLiveState, SlashLiveStateLive } from "../../src/services/SlashLiveState.ts";

describe("SlashLiveState", () => {
	it("recordLive then get returns the snapshot", async () => {
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* SlashLiveState;
					yield* s.recordLive("req-1", { a: 1 });
					return yield* s.get<{ a: number }>("req-1");
				}),
				SlashLiveStateLive,
			),
		);
		assert.deepEqual(got?.value, { a: 1 });
		assert.ok(got?.version && got.version > 0);
	});

	it("finalize moves snapshot from live to final and is what get returns", async () => {
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* SlashLiveState;
					yield* s.recordLive("req", { state: "running" });
					yield* s.finalize("req", { state: "complete" });
					return yield* s.get<{ state: string }>("req");
				}),
				SlashLiveStateLive,
			),
		);
		assert.equal(got?.value.state, "complete");
	});

	it("final wins over live (later writes still serve final)", async () => {
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* SlashLiveState;
					yield* s.finalize("req", "final");
					// Even if a stray live record is added after finalize,
					// final wins.
					yield* s.recordLive("req", "live");
					return yield* s.get<string>("req");
				}),
				SlashLiveStateLive,
			),
		);
		assert.equal(got?.value, "final");
	});

	it("restoreFinal seeds finals + clears live", async () => {
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* SlashLiveState;
					yield* s.recordLive("a", "old-live");
					yield* s.restoreFinal([
						{ requestId: "a", value: "restored-final" },
						{ requestId: "b", value: 42 },
					]);
					const a = yield* s.get<string>("a");
					const b = yield* s.get<number>("b");
					return [a?.value, b?.value] as const;
				}),
				SlashLiveStateLive,
			),
		);
		assert.equal(got[0], "restored-final");
		assert.equal(got[1], 42);
	});

	it("clear empties everything", async () => {
		const got = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* SlashLiveState;
					yield* s.recordLive("a", 1);
					yield* s.finalize("b", 2);
					yield* s.clear;
					const a = yield* s.get("a");
					const b = yield* s.get("b");
					return [a, b] as const;
				}),
				SlashLiveStateLive,
			),
		);
		assert.equal(got[0], undefined);
		assert.equal(got[1], undefined);
	});
});
