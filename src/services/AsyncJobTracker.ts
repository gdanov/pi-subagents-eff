/**
 * AsyncJobTracker service.
 *
 * Replaces async-job-tracker.ts + completion-dedupe.ts. State lives in a
 * Ref<HashMap<asyncId, AsyncJobState>>.
 *
 * - Polling: Effect.repeat(pollOnce, Schedule.spaced(250ms)) on a daemon fiber.
 * - Cleanup: Effect.fork(Effect.delay(removeJob, 10s)) on completion.
 * - Dedupe : Stream.filterEffect(notSeenWithin(ttl)) consuming PiEventBus.
 *
 * Depends on FileSystem, PiEventBus, Clock.
 */
import { Context, Effect, Layer } from "effect";

/** Mirrors types.ts:AsyncJobState — to be replaced by Schema-decoded value in Phase 2. */
export interface AsyncJobState {
	readonly runId: string;
	readonly asyncDir: string;
	readonly mode: "single" | "parallel" | "chain";
	readonly status: "queued" | "running" | "complete" | "failed";
}

export interface AsyncJobTrackerService {
	readonly register: (job: AsyncJobState) => Effect.Effect<void>;
	readonly get: (idOrPrefix: string) => Effect.Effect<AsyncJobState | undefined>;
	readonly list: Effect.Effect<ReadonlyArray<AsyncJobState>>;
	readonly markCompleted: (id: string) => Effect.Effect<void>;
	/** Daemon fiber wiring: composed in pi-adapter/runtime.ts at extension load. */
	readonly start: Effect.Effect<void>;
}

export class AsyncJobTracker extends Context.Service<AsyncJobTracker, AsyncJobTrackerService>()(
	"pi-subagents/AsyncJobTracker",
) {}

export const AsyncJobTrackerLive = Layer.sync(AsyncJobTracker)(() => {
	throw new Error("AsyncJobTracker.Live not yet implemented (Phase 7)");
});

export const makeAsyncJobTrackerTest = (): Layer.Layer<AsyncJobTracker, never, never> =>
	Layer.sync(AsyncJobTracker)(() => {
		throw new Error("AsyncJobTracker.Test not yet implemented (Phase 7)");
	});
