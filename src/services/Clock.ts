/**
 * Clock service.
 *
 * Thin facade over Effect's built-in clock primitives plus
 * `setTimeoutScoped` for cancellable timers (replaces the manual
 * setTimeout calls in async-job-tracker.ts:18, execution.ts:296,
 * async-job-tracker.ts:105 — Phase 7 wires those).
 *
 * Why a local service rather than just using `Effect.sleep` /
 * `Effect.Clock` everywhere: callers shouldn't have to know whether
 * they're on the host clock or a virtualized clock. The Live impl
 * delegates to Effect's runtime; tests inject Effect's `TestClock`
 * via `Layer.provide(SubagentsClockLive, TestClock.layer)` — no
 * separate Test Layer is needed because all the timing primitives
 * the methods expose are already TestClock-aware.
 *
 * `setTimeoutScoped(ms)` returns a Scope-cancellable timer effect:
 * the returned effect waits for `ms` and either succeeds with `void`
 * or is interrupted when the surrounding scope closes.
 */
import { Context, Duration, Effect, Layer, type Scope } from "effect";

export interface SubagentsClockService {
	readonly currentTimeMillis: Effect.Effect<number>;
	readonly sleep: (duration: Duration.Input) => Effect.Effect<void>;
	/** Sleep for `duration`, but interruptible via the surrounding Scope. */
	readonly setTimeoutScoped: (
		duration: Duration.Input,
	) => Effect.Effect<void, never, Scope.Scope>;
}

export class SubagentsClock extends Context.Service<SubagentsClock, SubagentsClockService>()(
	"pi-subagents/Clock",
) {}

export const SubagentsClockLive = Layer.succeed(SubagentsClock)(
	SubagentsClock.of({
		currentTimeMillis: Effect.sync(() => Date.now()),
		sleep: (d) => Effect.sleep(d),
		setTimeoutScoped: (d) =>
			// `Effect.interruptible` ensures Scope close cancels the wait;
			// without it Effect.sleep is still interruptible-by-default but
			// being explicit helps when consumers wrap this in uninterruptible
			// regions (e.g., the SIGKILL escalation timer at execution.ts:296).
			Effect.interruptible(Effect.sleep(d)),
	}),
);
