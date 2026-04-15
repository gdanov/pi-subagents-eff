/**
 * SlashBridge service.
 *
 * Wraps Pi's pi.commands.register / pi.events.on for slash-command
 * registration. Replaces slash-bridge.ts and prompt-template-bridge.ts
 * (the prompt-template integration only listens for one event channel,
 * so it folds in here naturally).
 *
 * Live : depends on the host pi.commands injected at boot.
 * Test : records registered handlers in an in-memory map.
 */
import { Context, Effect, Layer } from "effect";

export interface SlashCommandSpec {
	readonly description: string;
	readonly handler: (args: string, ctx: { readonly cwd: string; readonly hasUI: boolean; readonly ui: { notify: (msg: string, type: string) => void; custom: <T>(fn: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown) => unknown | Promise<unknown> } }) => Promise<void>;
}

export interface SlashBridgeService {
	readonly registerCommand: (input: { readonly name: string; readonly spec: SlashCommandSpec }) => Effect.Effect<void>;
	readonly registerPromptTemplateBridge: Effect.Effect<void>;
}

export class SlashBridge extends Context.Service<SlashBridge, SlashBridgeService>()("pi-subagents/SlashBridge") {}

export interface PiCommands {
	register(name: string, spec: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }): void;
}

export const makeSlashBridgeLive = (piCommands: PiCommands): Layer.Layer<SlashBridge, never> =>
	Layer.sync(SlashBridge)(() => ({
		registerCommand: ({ name, spec }) =>
			Effect.sync(() => {
				piCommands.register(name, {
					description: spec.description,
					handler: (args, ctx) => spec.handler(args, ctx as { cwd: string; hasUI: boolean; ui: { notify: (msg: string, type: string) => void; custom: <T>(fn: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown) => unknown | Promise<unknown> } }),
				});
			}),
		registerPromptTemplateBridge: Effect.succeed(undefined),
	}));

export const SlashBridgeLive = Layer.sync(SlashBridge)(() => {
	throw new Error("SlashBridge.Live needs host pi.commands — use makeSlashBridgeLive(piCommands)");
});

export const makeSlashBridgeTest = (): Layer.Layer<SlashBridge, never, never> =>
	Layer.sync(SlashBridge)(() => ({
		registerCommand: () => Effect.succeed(undefined),
		registerPromptTemplateBridge: Effect.succeed(undefined),
	}));