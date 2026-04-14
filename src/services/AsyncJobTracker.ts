/**
 * AsyncJobTracker service.
 *
 * Replaces async-job-tracker.ts. Tracks the lifecycle of detached
 * subagent runs:
 *
 *   register(jobInit)            - on subagent:started event
 *   poll                          - 250ms tick that re-reads status.json
 *   markCompleted(id, success)    - on subagent:complete event;
 *                                   schedules a 10s removal
 *   list / get                    - read accessors for the UI / status
 *                                   slash command
 *   changes                       - Stream<JobsSnapshot> the UI
 *                                   subscribes to instead of being
 *                                   directly called from this service
 *
 * The legacy code held UI coupling (renderWidget calls inline). The
 * new shape decouples: state lives in a Ref; mutation paths publish
 * to the bus; UI subscribes. That keeps this service pure
 * Effect/Stream and makes the legacy "ensurePoller" tear-down logic
 * fall out for free (the poller fiber is forked into the calling
 * scope; close the scope and the fiber is interrupted).
 *
 * Depends on FileSystem, PiEventBus, SubagentsClock.
 *
 * Status.json reads use schema decoding to surface AsyncStatus shape
 * issues as AsyncStatusCorrupt — the legacy code logged & swallowed.
 */
import * as path from "node:path";
import { Context, Duration, Effect, Layer, Ref, Schedule, type Scope, Schema, Stream } from "effect";
import {
	AsyncJobStateSchema,
	AsyncStatusSchema,
	type AsyncJobState,
} from "../domain/async-state.ts";
import { POLL_INTERVAL_MS } from "../domain/constants.ts";
import { AsyncStatusCorrupt } from "../errors.ts";
import { FileSystem } from "./FileSystem.ts";
import { PiEventBus } from "./PiEventBus.ts";

const DEFAULT_COMPLETION_REMOVAL_DELAY_MS = 10_000;
const STARTED_CHANNEL = "subagent:started";
const COMPLETE_CHANNEL = "subagent:complete";
const CHANGE_CHANNEL = "subagent:tracker:changed";

/**
 * Tunable knobs for the tracker. Only consumer is the executor's
 * runtime composition + tests; the production layer uses the defaults.
 */
export interface AsyncJobTrackerConfig {
	/** How long to keep a completed job in the snapshot before removal. */
	readonly completionRemovalDelayMs?: number;
}

interface StartedPayload {
	readonly id?: string;
	readonly asyncDir?: string;
	readonly agent?: string;
	readonly chain?: ReadonlyArray<string>;
}

interface CompletePayload {
	readonly id?: string;
	readonly success?: boolean;
	readonly asyncDir?: string;
}

export interface AsyncJobTrackerService {
	/** Add a queued job to the tracker. Emits a "changed" event. */
	readonly register: (
		init: StartedPayload & { readonly asyncDirRoot?: string },
	) => Effect.Effect<void>;
	readonly markCompleted: (data: CompletePayload) => Effect.Effect<void>;
	readonly get: (idOrPrefix: string) => Effect.Effect<AsyncJobState | undefined>;
	readonly list: Effect.Effect<ReadonlyArray<AsyncJobState>>;
	readonly clear: Effect.Effect<void>;
	/**
	 * Subscribable Stream of "tracker changed" notifications. The
	 * payload is the full snapshot at the moment of change so
	 * subscribers don't need to read separately.
	 */
	readonly changes: Stream.Stream<ReadonlyArray<AsyncJobState>>;
	/**
	 * Daemon entry point: subscribes to PiEventBus for started/complete,
	 * and runs a 250ms status.json poller. Forked into the caller's
	 * Scope; closing the scope tears everything down.
	 */
	readonly start: (asyncDirRoot: string) => Effect.Effect<void, never, Scope.Scope>;
}

export class AsyncJobTracker extends Context.Service<AsyncJobTracker, AsyncJobTrackerService>()(
	"pi-subagents/AsyncJobTracker",
) {}

// ============================================================================
// Live
// ============================================================================

export const makeAsyncJobTrackerLive = (
	config: AsyncJobTrackerConfig = {},
): Layer.Layer<AsyncJobTracker, never, FileSystem | PiEventBus> =>
	Layer.effect(AsyncJobTracker)(buildTracker(config));

/** Default Live layer (10 s removal delay). */
export const AsyncJobTrackerLive = makeAsyncJobTrackerLive();

function buildTracker(config: AsyncJobTrackerConfig) {
	const removalDelayMs =
		config.completionRemovalDelayMs ?? DEFAULT_COMPLETION_REMOVAL_DELAY_MS;
	return Effect.gen(function* () {
		const fsApi = yield* FileSystem;
		const bus = yield* PiEventBus;
		const jobsRef = yield* Ref.make<ReadonlyMap<string, AsyncJobState>>(new Map());

		const snapshot = (): Effect.Effect<ReadonlyArray<AsyncJobState>> =>
			Ref.get(jobsRef).pipe(Effect.map((m) => [...m.values()]));

		const announceChange = Effect.gen(function* () {
			const list = yield* snapshot();
			yield* bus.publish(CHANGE_CHANNEL, list);
		});

		const register = (init: StartedPayload & { readonly asyncDirRoot?: string }) =>
			Effect.gen(function* () {
				if (!init.id) return;
				const now = Date.now();
				const asyncDir =
					init.asyncDir ?? (init.asyncDirRoot ? path.join(init.asyncDirRoot, init.id) : init.id);
				const agents =
					init.chain && init.chain.length > 0 ? init.chain : init.agent ? [init.agent] : undefined;
				const job: AsyncJobState = {
					asyncId: init.id,
					asyncDir,
					status: "queued",
					mode: init.chain ? ("chain" as const) : ("single" as const),
					agents,
					stepsTotal: agents?.length,
					startedAt: now,
					updatedAt: now,
				};
				yield* Ref.update(jobsRef, (m) => {
					const next = new Map(m);
					next.set(init.id!, job);
					return next;
				});
				yield* announceChange;
			});

		const markCompleted = (data: CompletePayload) =>
			Effect.gen(function* () {
				const id = data.id;
				if (!id) return;
				const now = Date.now();
				yield* Ref.update(jobsRef, (m) => {
					const existing = m.get(id);
					if (!existing) return m;
					const next = new Map(m);
					next.set(id, {
						...existing,
						status: data.success ? ("complete" as const) : ("failed" as const),
						updatedAt: now,
						...(data.asyncDir ? { asyncDir: data.asyncDir } : {}),
					});
					return next;
				});
				yield* announceChange;
				// Schedule removal after 10s — fork as a detached fiber
				// so it survives the caller scope (matches the legacy
				// setTimeout that ran independent of the request).
				yield* Effect.forkDetach(
					Effect.delay(
						Effect.gen(function* () {
							yield* Ref.update(jobsRef, (m) => {
								const next = new Map(m);
								next.delete(id);
								return next;
							});
							yield* announceChange;
						}),
						Duration.millis(removalDelayMs),
					),
				);
			});

		const get = (idOrPrefix: string) =>
			Effect.gen(function* () {
				const m = yield* Ref.get(jobsRef);
				if (m.has(idOrPrefix)) return m.get(idOrPrefix);
				for (const [k, v] of m) if (k.startsWith(idOrPrefix)) return v;
				return undefined;
			});

		const pollOnce = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const list = yield* snapshot();
				let touched = false;
				for (const job of list) {
					if (job.status === "complete" || job.status === "failed") continue;
					const statusPath = path.join(job.asyncDir, "status.json");
					const text = yield* fsApi.read(statusPath).pipe(
						Effect.catchTag("FsNotFound", () => Effect.succeed("")),
						Effect.catchTag("FsReadError", () => Effect.succeed("")),
					);
					if (!text) continue;

					const parsed = yield* Effect.try({
						try: () => JSON.parse(text) as unknown,
						catch: (cause) => new AsyncStatusCorrupt({ path: statusPath, cause }),
					}).pipe(Effect.catchCause(() => Effect.succeed(undefined as unknown)));
					if (parsed === undefined) continue;
					const decoded = yield* Schema.decodeUnknownEffect(AsyncStatusSchema)(parsed).pipe(
						Effect.catchCause(() => Effect.succeed(undefined)),
					);
					if (!decoded) continue;

					yield* Ref.update(jobsRef, (m) => {
						const existing = m.get(job.asyncId);
						if (!existing) return m;
						const next = new Map(m);
						next.set(job.asyncId, {
							...existing,
							status: decoded.state,
							mode: decoded.mode,
							currentStep: decoded.currentStep ?? existing.currentStep,
							stepsTotal: decoded.steps?.length ?? existing.stepsTotal,
							startedAt: decoded.startedAt ?? existing.startedAt,
							updatedAt: decoded.lastUpdate ?? Date.now(),
							agents: decoded.steps?.length
								? decoded.steps.map((s: { readonly agent: string }) => s.agent)
								: existing.agents,
							sessionDir: decoded.sessionDir ?? existing.sessionDir,
							outputFile: decoded.outputFile ?? existing.outputFile,
							totalTokens: decoded.totalTokens ?? existing.totalTokens,
							sessionFile: decoded.sessionFile ?? existing.sessionFile,
						});
						return next;
					});
					touched = true;
				}
				if (touched) yield* announceChange;
			});

		const start = (asyncDirRoot: string) =>
			Effect.gen(function* () {
				// Subscribe to start events: register the job.
				yield* bus.subscribe<StartedPayload>(STARTED_CHANNEL).pipe(
					Stream.mapEffect((payload) => register({ ...payload, asyncDirRoot })),
					Stream.runDrain,
					Effect.forkScoped,
				);
				// Subscribe to complete events: mark + schedule cleanup.
				yield* bus.subscribe<CompletePayload>(COMPLETE_CHANNEL).pipe(
					Stream.mapEffect((payload) => markCompleted(payload)),
					Stream.runDrain,
					Effect.forkScoped,
				);
				// Poller: scheduled via Effect.repeat.
				yield* Effect.repeat(pollOnce(), Schedule.spaced(Duration.millis(POLL_INTERVAL_MS))).pipe(
					Effect.forkScoped,
				);
			});

		return AsyncJobTracker.of({
			register,
			markCompleted,
			get,
			list: snapshot(),
			clear: Effect.gen(function* () {
				yield* Ref.set(jobsRef, new Map());
				yield* announceChange;
			}),
			changes: bus.subscribe<ReadonlyArray<AsyncJobState>>(CHANGE_CHANNEL),
			start,
		});
	});
}

export const AsyncJobTrackerTest = AsyncJobTrackerLive;

// Re-export the schema so callers can decode persisted snapshots.
export { AsyncJobStateSchema };
