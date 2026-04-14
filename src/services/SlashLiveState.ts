/**
 * SlashLiveState service.
 *
 * In-memory snapshot store backing slash-live-state.ts. Holds per-session
 * renderable result snapshots so the slash-command UI can restore detail
 * views after a render cycle.
 *
 * Internally just a Ref<HashMap>; exposed as a service so tests can clear
 * it deterministically.
 */
import { Context, Effect, Layer } from "effect";

export interface SlashLiveStateService {
	readonly record: (key: string, snapshot: unknown) => Effect.Effect<void>;
	readonly get: (key: string) => Effect.Effect<unknown | undefined>;
	readonly clear: Effect.Effect<void>;
}

export class SlashLiveState extends Context.Service<SlashLiveState, SlashLiveStateService>()(
	"pi-subagents/SlashLiveState",
) {}

export const SlashLiveStateLive = Layer.sync(SlashLiveState)(() => {
	throw new Error("SlashLiveState.Live not yet implemented (Phase 8)");
});

export const makeSlashLiveStateTest = (): Layer.Layer<SlashLiveState, never, never> =>
	Layer.sync(SlashLiveState)(() => {
		throw new Error("SlashLiveState.Test not yet implemented (Phase 8)");
	});
