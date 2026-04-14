/**
 * Notifier service.
 *
 * Subscribes to PiEventBus "subagent:complete" and emits a formatted
 * notification message. Replaces notify.ts.
 *
 * Registered as a separate Pi extension entry (package.json:pi.extensions).
 * Has its own ManagedRuntime so the main extension and the notifier can
 * be loaded independently.
 */
import { Context, Effect, Layer } from "effect";

export interface NotifierService {
	readonly start: Effect.Effect<void>;
}

export class Notifier extends Context.Service<Notifier, NotifierService>()("pi-subagents/Notifier") {}

export const NotifierLive = Layer.sync(Notifier)(() => {
	throw new Error("Notifier.Live not yet implemented (Phase 8)");
});

export const makeNotifierTest = (): Layer.Layer<Notifier, never, never> =>
	Layer.sync(Notifier)(() => {
		throw new Error("Notifier.Test not yet implemented (Phase 8)");
	});
