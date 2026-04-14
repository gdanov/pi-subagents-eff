/**
 * SlashLiveState service.
 *
 * Snapshot store backing the slash-command renderer: when a slash run
 * is in progress its result lives in `liveSnapshots`; when it completes
 * (or is restored from a persisted session) it moves to `finalSnapshots`.
 * The renderer queries `get()` and gets whichever has the freshest
 * snapshot for the requestId — final wins over live (matches legacy
 * slash-live-state.ts:271 priority).
 *
 * Phase 8 scope: state surface only. The placeholder-building
 * helpers (buildSlashInitialResult, applySlashUpdate input shapes)
 * live in pi-adapter (Phase 11) where the slash bridge wires Pi
 * events to them.
 *
 * Replaces slash-live-state.ts. Discriminated `live` vs `final`
 * preserved so the legacy "final wins on render" priority still holds.
 */
import { Context, Effect, Layer, Ref } from "effect";

export interface Snapshot<T = unknown> {
	readonly value: T;
	readonly version: number;
}

export interface SlashLiveStateService {
	/** Set the live snapshot for `requestId`; bumps version. */
	readonly recordLive: <T>(requestId: string, value: T) => Effect.Effect<Snapshot<T>>;
	/**
	 * Promote a live snapshot to final and remove the live entry.
	 * Returns the stored snapshot. Used at run completion + on
	 * fail/cancel paths.
	 */
	readonly finalize: <T>(requestId: string, value: T) => Effect.Effect<Snapshot<T>>;
	/**
	 * Bulk restore final snapshots (e.g. after session reload). Live
	 * map is wiped first since a reloaded session never has in-flight
	 * runs.
	 */
	readonly restoreFinal: <T>(
		entries: ReadonlyArray<{ readonly requestId: string; readonly value: T }>,
	) => Effect.Effect<void>;
	/** Final wins over live. */
	readonly get: <T>(requestId: string) => Effect.Effect<Snapshot<T> | undefined>;
	readonly clear: Effect.Effect<void>;
}

export class SlashLiveState extends Context.Service<SlashLiveState, SlashLiveStateService>()(
	"pi-subagents/SlashLiveState",
) {}

interface InternalSnapshot {
	readonly value: unknown;
	readonly version: number;
}

export const SlashLiveStateLive = Layer.effect(SlashLiveState)(
	Effect.gen(function* () {
		const live = yield* Ref.make<ReadonlyMap<string, InternalSnapshot>>(new Map());
		const final = yield* Ref.make<ReadonlyMap<string, InternalSnapshot>>(new Map());
		const counter = yield* Ref.make(1);

		const nextVersion = Ref.modify(counter, (n) => [n, n + 1]);

		const recordLive = <T,>(requestId: string, value: T) =>
			Effect.gen(function* () {
				const v = yield* nextVersion;
				const snap: InternalSnapshot = { value, version: v };
				yield* Ref.update(live, (m) => {
					const next = new Map(m);
					next.set(requestId, snap);
					return next;
				});
				return { value, version: v } as Snapshot<T>;
			});

		const finalize = <T,>(requestId: string, value: T) =>
			Effect.gen(function* () {
				const v = yield* nextVersion;
				const snap: InternalSnapshot = { value, version: v };
				yield* Ref.update(final, (m) => {
					const next = new Map(m);
					next.set(requestId, snap);
					return next;
				});
				yield* Ref.update(live, (m) => {
					const next = new Map(m);
					next.delete(requestId);
					return next;
				});
				return { value, version: v } as Snapshot<T>;
			});

		const restoreFinal = <T,>(
			entries: ReadonlyArray<{ readonly requestId: string; readonly value: T }>,
		) =>
			Effect.gen(function* () {
				yield* Ref.set(live, new Map());
				const m = new Map<string, InternalSnapshot>();
				for (const e of entries) {
					const v = yield* nextVersion;
					m.set(e.requestId, { value: e.value, version: v });
				}
				yield* Ref.set(final, m);
			});

		const get = <T,>(requestId: string) =>
			Effect.gen(function* () {
				const finalMap = yield* Ref.get(final);
				const finalSnap = finalMap.get(requestId);
				if (finalSnap) return { value: finalSnap.value as T, version: finalSnap.version };
				const liveMap = yield* Ref.get(live);
				const liveSnap = liveMap.get(requestId);
				if (liveSnap) return { value: liveSnap.value as T, version: liveSnap.version };
				return undefined;
			});

		const clear = Effect.gen(function* () {
			yield* Ref.set(live, new Map());
			yield* Ref.set(final, new Map());
		});

		return SlashLiveState.of({ recordLive, finalize, restoreFinal, get, clear });
	}),
);

export const SlashLiveStateTest = SlashLiveStateLive;
