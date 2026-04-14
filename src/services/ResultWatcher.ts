/**
 * ResultWatcher service.
 *
 * Replaces result-watcher.ts + file-coalescer.ts entirely. Internally builds
 * the Stream pipeline described in the plan:
 *
 *   FileSystem.watch(dir)
 *     |> Stream.filter(rename + .json)
 *     |> Stream.groupedWithin(1, 50ms)              // replaces file-coalescer
 *     |> Stream.mapEffect(read + dedupe + publish)  // replaces async result handler
 *     |> Stream.retry(Schedule.spaced(3s))          // replaces 3s restart loop
 *
 * `start` returns a scoped Effect; tearing down the scope stops the watcher
 * (no more manual stopResultWatcher).
 *
 * Depends on FileSystem + PiEventBus + Clock.
 */
import { Context, Effect, Layer, type Scope } from "effect";

export interface ResultWatcherService {
	readonly start: (resultsDir: string) => Effect.Effect<void, never, Scope.Scope>;
}

export class ResultWatcher extends Context.Service<ResultWatcher, ResultWatcherService>()(
	"pi-subagents/ResultWatcher",
) {}

export const ResultWatcherLive = Layer.sync(ResultWatcher)(() => {
	throw new Error("ResultWatcher.Live not yet implemented (Phase 7)");
});

export const makeResultWatcherTest = (): Layer.Layer<ResultWatcher, never, never> =>
	Layer.sync(ResultWatcher)(() => {
		throw new Error("ResultWatcher.Test not yet implemented (Phase 7)");
	});
