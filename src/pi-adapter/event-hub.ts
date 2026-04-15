import { Effect, Layer, PubSub, Context } from "effect";
import type { PiEventBusService } from "../services/PiEventBus.ts";

interface BusEnvelope {
	readonly channel: string;
	readonly payload: unknown;
}

export interface EventHubOptions {
	readonly piEvents: {
		readonly on: (channel: string, handler: (data: unknown) => void) => void;
		readonly emit: (channel: string, data: unknown) => void;
		readonly off: (channel: string, handler: (data: unknown) => void) => void;
	};
}

export class PiEventBusAdapter extends Context.Service<PiEventBusAdapter, PiEventBusService>()("pi-subagents/PiEventBus") {}

export function makePiEventHubLayer(options: EventHubOptions): Layer.Layer<PiEventBusAdapter, never> {
	return Layer.effect(
		PiEventBusAdapter,
		Effect.gen(function* () {
			const hub = yield* PubSub.bounded<BusEnvelope>(256);

			const service: PiEventBusService = {
				subscribe: <T>(channel: string) => {
					return Effect.gen(function* () {
						const sub = yield* PubSub.subscribe(hub);
						const handler = (data: unknown) => {
							PubSub.publish(hub, { channel, payload: data });
						};
						yield* Effect.acquireRelease(
							Effect.sync(() => options.piEvents.on(channel, handler)),
							() => Effect.sync(() => options.piEvents.off(channel, handler)),
						);
						return sub;
					}) as any;
				},
				publish: (channel, payload) =>
					Effect.sync(() => {
						options.piEvents.emit(channel, payload);
					}),
			};

			return service;
		}),
	);
}
