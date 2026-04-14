/**
 * PiEventBus service.
 *
 * Publish/subscribe over named channels, backed by a shared bounded
 * PubSub. `subscribe(channel)` returns a Stream that yields all
 * payloads published on that channel (other channels' events are
 * silently filtered out).
 *
 * The Pi-events bridge that adapts the host extension's event emitter
 * into this bus is a Phase 11 concern (pi-adapter/event-hub.ts). For
 * Phases 7-10 the bus is purely in-process: the executor publishes
 * subagent:started / subagent:complete; ResultWatcher publishes
 * result-file events; AsyncJobTracker subscribes to the same.
 *
 * Live  : in-memory PubSub.bounded(256). Channels share the underlying
 *         buffer because there's no per-channel back-pressure benefit
 *         in practice — the messages are small JSON objects and the
 *         subscriber count is bounded by the live UI.
 * Test  : same shape, gives tests a built-in `published` accessor for
 *         assertions instead of having to subscribe a sink.
 */
import { Context, Effect, Layer, PubSub, Stream } from "effect";

interface BusEnvelope {
	readonly channel: string;
	readonly payload: unknown;
}

export interface PiEventBusService {
	readonly subscribe: <T = unknown>(channel: string) => Stream.Stream<T>;
	readonly publish: (channel: string, payload: unknown) => Effect.Effect<void>;
}

export class PiEventBus extends Context.Service<PiEventBus, PiEventBusService>()(
	"pi-subagents/PiEventBus",
) {}

const DEFAULT_CAPACITY = 256;

const buildService = (hub: PubSub.PubSub<BusEnvelope>): PiEventBusService => ({
	subscribe: <T,>(channel: string) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sub = yield* PubSub.subscribe(hub);
				// PubSub.Subscription doesn't expose a Stream constructor in
				// Effect 4; build one by repeatedly taking from the
				// subscription. The inner take is interruptible so a
				// fiber takedown still cleanly terminates the stream.
				return Stream.fromEffectRepeat(PubSub.take(sub)).pipe(
					Stream.filter((env): env is BusEnvelope => env !== null && (env as BusEnvelope).channel === channel),
					Stream.map((env) => env.payload as T),
				);
			}),
		),
	publish: (channel, payload) => PubSub.publish(hub, { channel, payload }).pipe(Effect.asVoid),
});

export const PiEventBusLive = Layer.effect(PiEventBus)(
	Effect.gen(function* () {
		const hub = yield* PubSub.bounded<BusEnvelope>(DEFAULT_CAPACITY);
		return buildService(hub);
	}),
);

// ============================================================================
// Test
// ============================================================================

export interface PiEventBusTestBuild {
	readonly layer: Layer.Layer<PiEventBus, never, never>;
	readonly controls: {
		/**
		 * Snapshot of every published envelope, in order. Useful for
		 * asserting that a code path under test emitted the right channels.
		 */
		readonly published: () => ReadonlyArray<BusEnvelope>;
	};
}

export function makePiEventBusTest(): PiEventBusTestBuild {
	const recorded: BusEnvelope[] = [];
	const layer = Layer.effect(PiEventBus)(
		Effect.gen(function* () {
			const hub = yield* PubSub.bounded<BusEnvelope>(DEFAULT_CAPACITY);
			const service = buildService(hub);
			return {
				...service,
				publish: (channel: string, payload: unknown) =>
					Effect.gen(function* () {
						recorded.push({ channel, payload });
						yield* service.publish(channel, payload);
					}),
			};
		}),
	);
	return { layer, controls: { published: () => recorded } };
}
