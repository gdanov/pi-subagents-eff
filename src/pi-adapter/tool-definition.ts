import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { Schema } from "effect";
import type { ExecutorOutput } from "../executor/Executor.ts";

export interface EffectToolOptions<TParams, TDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Schema.Schema<TParams>;
	readonly execute: (
		params: TParams,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<TDetails>>;
}

export function effectTool<TParams, TDetails>(
	options: EffectToolOptions<TParams, TDetails>,
): {
	name: string;
	label: string;
	description: string;
	parameters: Schema.Schema<TParams>;
	execute: (
		toolCallId: string,
		params: TParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<TDetails>>;
} {
	return {
		name: options.name,
		label: options.label,
		description: options.description,
		parameters: options.parameters,
		execute: async (
			_toolCallId: string,
			params: TParams,
			_signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<TDetails>> => {
			return options.execute(params, onUpdate, _ctx);
		},
	};
}
