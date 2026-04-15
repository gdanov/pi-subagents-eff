import { Effect } from "effect";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ChainClarifyState = {
	name: string;
	agent: string;
	task: string;
};

export type ChainClarifyResult = {
	action: "cancel" | "save";
	data?: ChainClarifyState;
};

export async function showChainClarifyDialog(
	_ctx: ExtensionContext,
	_initial: ChainClarifyState,
): Promise<ChainClarifyResult> {
	throw new Error("showChainClarifyDialog not yet implemented - Phase 11 will wire this up");
}

export function showChainClarifyDialogEffect(
	ctx: ExtensionContext,
	initial: ChainClarifyState,
): Effect.Effect<ChainClarifyResult, Error> {
	return Effect.tryPromise({
		try: () => showChainClarifyDialog(ctx, initial),
		catch: (e) => new Error(String(e)),
	});
}
