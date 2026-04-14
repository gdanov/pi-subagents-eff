/**
 * SlashBridge service.
 *
 * Wraps Pi's pi.commands.register / pi.events.on for slash-command
 * registration. Replaces slash-bridge.ts and prompt-template-bridge.ts
 * (the prompt-template integration only listens for one event channel,
 * so it folds in here naturally).
 *
 * Live : depends on the host pi.commands + pi.events injected at boot.
 * Test : records registered handlers in an in-memory map.
 */
import { Context, Effect, Layer } from "effect";

export interface SlashBridgeService {
	readonly registerCommand: (input: { readonly name: string; readonly description: string; readonly handler: (raw: string) => Effect.Effect<void> }) => Effect.Effect<void>;
	readonly registerPromptTemplateBridge: Effect.Effect<void>;
}

export class SlashBridge extends Context.Service<SlashBridge, SlashBridgeService>()("pi-subagents/SlashBridge") {}

export const SlashBridgeLive = Layer.sync(SlashBridge)(() => {
	throw new Error("SlashBridge.Live needs host pi.commands — wired in pi-adapter/runtime.ts (Phase 8)");
});

export const makeSlashBridgeTest = (): Layer.Layer<SlashBridge, never, never> =>
	Layer.sync(SlashBridge)(() => {
		throw new Error("SlashBridge.Test not yet implemented (Phase 8)");
	});
