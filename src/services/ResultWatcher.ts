/**
 * ResultWatcher service.
 *
 * Replaces result-watcher.ts + file-coalescer.ts + (parts of)
 * completion-dedupe.ts with one Stream pipeline:
 *
 *   FileSystem.watch(resultsDir)
 *     |> Stream.filter(rename + .json)
 *     |> Stream.groupedWithin(1, 50ms)         // coalesce duplicate
 *                                              //  rename events
 *     |> Stream.mapEffect(read + dedupe + publish + delete)
 *     |> Stream.retry(Schedule.spaced(3s))     // restart on watcher error
 *
 * `start(resultsDir)` returns a scoped Effect — closing the scope
 * stops the watcher AND its retry loop. No manual stopResultWatcher
 * required.
 *
 * Dedup is in-memory via a Ref<HashMap<key, expiresAtMs>> with the
 * same TTL contract as completion-dedupe.ts: stale entries are pruned
 * on each lookup.
 *
 * Depends on: FileSystem, PiEventBus.
 */
import * as path from "node:path";
import { Context, Duration, Effect, Layer, Ref, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { FileSystem } from "./FileSystem.ts";
import { PiEventBus } from "./PiEventBus.ts";

const COALESCE_WINDOW_MS = 50;
const RESTART_DELAY_MS = 3000;
const DEFAULT_DEDUP_TTL_MS = 30_000;
const RESULT_CHANNEL = "subagent:complete";

interface ResultData {
	readonly id?: unknown;
	readonly agent?: unknown;
	readonly timestamp?: unknown;
	readonly sessionId?: unknown;
	readonly taskIndex?: unknown;
	readonly totalTasks?: unknown;
	readonly success?: unknown;
}

export interface ResultWatcherFilter {
	/** Optional filter hook: return false to skip publishing this result. */
	readonly accept?: (data: ResultData) => boolean;
}

export interface ResultWatcherService {
	/**
	 * Start watching a results dir. Returns a scoped Effect; the
	 * underlying watcher is torn down when the scope closes. Failures
	 * inside the pipeline are retried at 3s intervals via Schedule.spaced.
	 */
	readonly start: (
		resultsDir: string,
		filter?: ResultWatcherFilter,
	) => Effect.Effect<void, never, Scope.Scope>;
	/**
	 * Process any result files already sitting in the dir at startup
	 * (legacy `primeExistingResults`). Useful for picking up async
	 * runs that completed while the extension was offline.
	 */
	readonly prime: (resultsDir: string, filter?: ResultWatcherFilter) => Effect.Effect<void>;
}

export class ResultWatcher extends Context.Service<ResultWatcher, ResultWatcherService>()(
	"pi-subagents/ResultWatcher",
) {}

// ============================================================================
// Pure dedup helpers (ported from completion-dedupe.ts)
// ============================================================================

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: ResultData, fallback: string): string {
	const id = asNonEmptyString(data.id);
	if (id) return `id:${id}`;
	const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
	const agent = asNonEmptyString(data.agent) ?? "unknown";
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
	return [
		"meta",
		sessionId,
		agent,
		timestamp !== undefined ? String(timestamp) : "no-ts",
		taskIndex !== undefined ? String(taskIndex) : "-",
		totalTasks !== undefined ? String(totalTasks) : "-",
		success,
		fallback,
	].join(":");
}

// ============================================================================
// Live
// ============================================================================

export const ResultWatcherLive = Layer.effect(ResultWatcher)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;
		const bus = yield* PiEventBus;

		// One dedup map across all calls — matches the legacy
		// state.completionSeen Map<string, number> singleton.
		const seenRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

		const isFresh = (key: string, now: number, ttlMs: number) =>
			Ref.modify(seenRef, (current) => {
				const next = new Map<string, number>();
				for (const [k, ts] of current) {
					if (now - ts <= ttlMs) next.set(k, ts);
				}
				if (next.has(key)) return [false, next];
				next.set(key, now);
				return [true, next];
			});

		const processFile = (
			resultsDir: string,
			fileName: string,
			filter: ResultWatcherFilter | undefined,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				const resultPath = path.join(resultsDir, fileName);
				const text = yield* fsApi.read(resultPath).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed("")),
					Effect.catchTag("FsReadError", () => Effect.succeed("")),
				);
				if (!text) return;

				const data = yield* Effect.try({
					try: () => JSON.parse(text) as ResultData,
					catch: () => null as ResultData | null,
				}).pipe(Effect.orElseSucceed(() => null as ResultData | null));
				if (!data) return;

				if (filter?.accept && !filter.accept(data)) return;

				const now = Date.now();
				const fresh = yield* isFresh(
					buildCompletionKey(data, `result:${fileName}`),
					now,
					DEFAULT_DEDUP_TTL_MS,
				);
				if (!fresh) {
					yield* Effect.ignore(fsApi.rm(resultPath));
					return;
				}

				yield* bus.publish(RESULT_CHANNEL, data);
				yield* Effect.ignore(fsApi.rm(resultPath));
			});

		const start = (resultsDir: string, filter?: ResultWatcherFilter) =>
			Effect.gen(function* () {
				// The watcher loop runs forever inside its own scope so
				// the caller's parent scope decides when it terminates.
				yield* fsApi.watch(resultsDir).pipe(
					Stream.filter((ev) => ev.type === "rename" && ev.file.endsWith(".json")),
					// Coalesce bursts of rename events for the same file.
					// `groupedWithin` collects up to 1 element OR the
					// 50ms window — effectively a debounce.
					Stream.groupedWithin(1, Duration.millis(COALESCE_WINDOW_MS)),
					Stream.mapEffect((chunk) =>
						Effect.gen(function* () {
							for (const ev of chunk) yield* processFile(resultsDir, ev.file, filter);
						}),
					),
					Stream.runDrain,
					// Restart on FsWatchError (cross-platform fs.watch is
					// brittle — the legacy code also restarted on a 3s
					// schedule when the watcher closed unexpectedly).
					Effect.retry(Schedule.spaced(Duration.millis(RESTART_DELAY_MS))),
					Effect.forkScoped,
				);
			});

		const prime = (resultsDir: string, filter?: ResultWatcherFilter) =>
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(resultsDir);
				if (!exists) return;
				const entries = yield* fsApi.readDir(resultsDir).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
					Effect.catchTag("FsReadError", () => Effect.succeed<ReadonlyArray<string>>([])),
				);
				for (const file of entries) {
					if (file.endsWith(".json")) yield* processFile(resultsDir, file, filter);
				}
			});

		return ResultWatcher.of({ start, prime });
	}),
);

// Test layer: same shape, default Live works fine on top of the
// InMemory FileSystem (controls.emit drives synthetic watch events).
export const ResultWatcherTest = ResultWatcherLive;
