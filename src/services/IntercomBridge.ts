/**
 * IntercomBridge service.
 *
 * Replaces intercom-bridge.ts. Bridges subagent detach/forward requests
 * back into the parent session via PiEventBus channels.
 *
 * Depends on PiEventBus + ConfigReader.
 */
import { Context, Effect, Layer } from "effect";

export interface IntercomBridgeService {
	readonly applyToAgent: (input: { readonly agentName: string; readonly mode: "off" | "fork-only" | "always" }) => Effect.Effect<{ readonly systemPromptInjection: string }>;
	readonly resolveSessionTarget: (parentSessionFile: string | null) => Effect.Effect<string | undefined>;
}

export class IntercomBridge extends Context.Service<IntercomBridge, IntercomBridgeService>()(
	"pi-subagents/IntercomBridge",
) {}

export const IntercomBridgeLive = Layer.sync(IntercomBridge)(() => {
	throw new Error("IntercomBridge.Live not yet implemented (Phase 8)");
});

export const makeIntercomBridgeTest = (): Layer.Layer<IntercomBridge, never, never> =>
	Layer.sync(IntercomBridge)(() => {
		throw new Error("IntercomBridge.Test not yet implemented (Phase 8)");
	});
