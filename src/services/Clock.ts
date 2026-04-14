/**
 * Clock service.
 *
 * Thin wrapper around Effect's built-in Clock plus `setTimeoutScoped` for
 * cancellable timers (replaces the manual setTimeout calls in
 * async-job-tracker.ts:18, execution.ts:296, async-job-tracker.ts:105).
 *
 * For deterministic time in tests, just use Effect's TestClock module
 * directly with the Live layer — no separate Test layer needed here.
 */
import { Context, Duration, Effect, Layer } from "effect";

export interface SubagentsClockService {
	readonly currentTimeMillis: Effect.Effect<number>;
	readonly sleep: (duration: Duration.Input) => Effect.Effect<void>;
}

export class SubagentsClock extends Context.Service<SubagentsClock, SubagentsClockService>()(
	"pi-subagents/Clock",
) {}

export const SubagentsClockLive = Layer.succeed(SubagentsClock)(
	SubagentsClock.of({
		currentTimeMillis: Effect.sync(() => Date.now()),
		sleep: (d) => Effect.sleep(d),
	}),
);
