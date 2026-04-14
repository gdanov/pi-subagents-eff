/**
 * Tests for src/services/PiEventBus.ts.
 *
 * Verifies channel routing, multi-subscriber fan-out, and the Test
 * layer's `published` recorder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Fiber, Stream } from "effect";
import { makePiEventBusTest, PiEventBus, PiEventBusLive } from "../../src/services/PiEventBus.ts";

describe("PiEventBus Live", () => {
	it("routes payloads to the matching channel only", async () => {
		const collected = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const bus = yield* PiEventBus;
					const fiber = yield* Effect.forkChild(
						bus.subscribe<{ x: number }>("foo").pipe(Stream.take(2), Stream.runCollect),
					);
					yield* Effect.sleep("20 millis");
					yield* bus.publish("bar", { x: 99 }); // ignored: wrong channel
					yield* bus.publish("foo", { x: 1 });
					yield* bus.publish("foo", { x: 2 });
					return yield* Fiber.join(fiber);
				}),
				PiEventBusLive,
			),
		);
		const arr = Array.from(collected);
		assert.deepEqual(arr.map((p) => p.x), [1, 2]);
	});

	it("multiple subscribers each receive the same payload", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const bus = yield* PiEventBus;
					const a = yield* Effect.forkChild(
						bus.subscribe<number>("ch").pipe(Stream.take(1), Stream.runCollect),
					);
					const b = yield* Effect.forkChild(
						bus.subscribe<number>("ch").pipe(Stream.take(1), Stream.runCollect),
					);
					yield* Effect.sleep("20 millis");
					yield* bus.publish("ch", 42);
					const aRes = Array.from(yield* Fiber.join(a));
					const bRes = Array.from(yield* Fiber.join(b));
					return [aRes, bRes] as const;
				}),
				PiEventBusLive,
			),
		);
		assert.deepEqual(result[0], [42]);
		assert.deepEqual(result[1], [42]);
	});
});

describe("PiEventBus Test layer recorder", () => {
	it("captures every published envelope in order", async () => {
		const test = makePiEventBusTest();
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const bus = yield* PiEventBus;
					yield* bus.publish("a", 1);
					yield* bus.publish("b", 2);
					yield* bus.publish("a", 3);
				}),
				test.layer,
			),
		);
		const recorded = test.controls.published();
		assert.deepEqual(recorded.map((r) => r.channel), ["a", "b", "a"]);
		assert.deepEqual(recorded.map((r) => r.payload), [1, 2, 3]);
	});
});
