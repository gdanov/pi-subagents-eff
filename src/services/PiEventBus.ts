/**
 * PiEventBus service.
 *
 * Hub-backed bridge between the host pi.events emitter and Effect Streams.
 * `subscribe(channel)` lazily registers a `pi.events.on(channel)` listener
 * inside an Effect.acquireRelease block so its disposal automatically tears
 * the listener down when the calling scope closes.
 *
 * Channels currently used by the legacy code:
 *   - "subagent:started"
 *   - "subagent:complete"
 *   - any custom channel registered by intercom-bridge.ts
 *
 * Live : wraps the host pi.events object passed into ExtensionAPI.
 * Test : a single bounded PubSub shared across services for assertions.
 */
import { Context, Effect, Layer, Stream } from "effect";

export interface PiEventBusService {
	readonly subscribe: <T = unknown>(channel: string) => Stream.Stream<T>;
	readonly publish: (channel: string, payload: unknown) => Effect.Effect<void>;
}

export class PiEventBus extends Context.Service<PiEventBus, PiEventBusService>()("pi-subagents/PiEventBus") {}

export const PiEventBusLive = Layer.sync(PiEventBus)(() => {
	throw new Error("PiEventBus.Live needs the host pi.events instance — wired in pi-adapter/runtime.ts");
});

export const makePiEventBusTest = (): Layer.Layer<PiEventBus, never, never> =>
	Layer.sync(PiEventBus)(() => {
		throw new Error("PiEventBus.Test not yet implemented");
	});
