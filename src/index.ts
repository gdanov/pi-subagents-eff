import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExecutorOutput } from "./executor/Executor.ts";
import { executeSubagent } from "./executor/Executor.ts";
import { AgentDirectory, type AgentConfig } from "./services/AgentDirectory.ts";
import { buildRuntime, disposeRuntime } from "./pi-adapter/runtime.ts";
import { effectTool } from "./pi-adapter/tool-definition.ts";
import { SubagentParamsSchema } from "./schema/subagent-params.ts";
import { Effect } from "effect";
import type { RunSingleAgent } from "./executor/single.ts";
import { SlashBridge } from "./services/SlashBridge.ts";
import { ASYNC_DIR } from "./domain/constants.ts";

let _runtime: ReturnType<typeof buildRuntime> | undefined;

function getRuntime() {
	if (!_runtime) _runtime = buildRuntime();
	return _runtime;
}

async function runSlashSubagent(
	pi: ExtensionAPI,
	params: typeof SubagentParamsSchema.Type,
	cwd: string,
	runAgents: RunSingleAgent[],
) {
	const runtime = getRuntime();
	const effect = executeSubagent(params, { cwd, agents: runAgents });
	const result = await runtime.runPromise(effect);
	return result;
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const runtime = getRuntime();

	const subagentTool = effectTool<typeof SubagentParamsSchema.Type, ExecutorOutput>({
		name: "subagent",
		label: "Subagent",
		description: `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• SINGLE: { agent, task } - one task
• CHAIN: { chain: [{agent:"scout"}, {parallel:[{agent:"worker",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?}, ...], worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: "fresh")

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

Example: { chain: [{agent:"scout", task:"Analyze {task}"}, {agent:"planner", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover agents/chains
• { action: "get", agent: "name" } - full agent detail
• { action: "create", config: { name, systemPrompt, ... } }
• { action: "update", agent: "name", config: { ... } } - merge
• { action: "delete", agent: "name" }
• Use chainName for chain operations`,
		parameters: SubagentParamsSchema,
		execute: async (params, _onUpdate, ctx) => {
			const cwd = params.cwd ?? ctx.cwd;
			const agentsResult = await runtime.runPromise(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discover(cwd, "both").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentConfig>));
				}),
			);
			const runAgents: RunSingleAgent[] = agentsResult.map((a) => ({
				name: a.name,
				systemPrompt: a.systemPrompt,
				model: a.model,
				thinking: a.thinking,
				tools: a.tools,
				mcpDirectTools: a.mcpDirectTools,
				extensions: a.extensions,
				skills: a.skills,
				fallbackModels: a.fallbackModels ?? [],
			}));
			const effect = executeSubagent(params, { cwd, agents: runAgents });
			const result = await runtime.runPromise(effect);
			const output: ExecutorOutput = { result: result.result };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				details: output,
			};
		},
	});

	pi.registerTool(subagentTool as unknown as Parameters<typeof pi.registerTool>[0]);

	runtime.runPromise(
		Effect.gen(function* () {
			const slash = yield* SlashBridge;
			yield* slash.registerCommand({
				name: "run",
				spec: {
					description: "Run a subagent directly: /run agent task [--bg] [--fork]",
					handler: async (args, ctx) => {
						const parts = args.trim().split(/\s+/);
						if (parts.length < 2) {
							ctx.ui.notify("Usage: /run <agent> <task>", "error");
							return;
						}
						const agentName = parts[0];
						const task = parts.slice(1).join(" ");
						const isAsync = args.includes("--bg");
						const isFork = args.includes("--fork");
						const params = {
							agent: agentName,
							task,
							clarify: false,
							agentScope: "both" as const,
							...(isAsync ? { async: true } : {}),
							...(isFork ? { context: "fork" as const } : {}),
						};
						await runSlashSubagent(pi, params, ctx.cwd, []);
					},
				},
			});
			yield* slash.registerCommand({
				name: "parallel",
				spec: {
					description: "Run agents in parallel: /parallel agent1 task1 -> agent2 task2",
					handler: async (args, ctx) => {
						const segments = args.split("->").map((s) => s.trim()).filter(Boolean);
						if (segments.length < 2) {
							ctx.ui.notify("Usage: /parallel agent1 task1 -> agent2 task2", "error");
							return;
						}
						const tasks = segments.map((seg) => {
							const match = seg.match(/^(\S+)\s+(.+)$/);
							if (!match) return null;
							return { agent: match[1], task: match[2] };
						}).filter(Boolean) as { agent: string; task: string }[];
						if (tasks.length === 0) {
							ctx.ui.notify("Usage: /parallel agent1 task1 -> agent2 task2", "error");
							return;
						}
						const params = { tasks, clarify: false, agentScope: "both" as const };
						await runSlashSubagent(pi, params, ctx.cwd, []);
					},
				},
			});
			yield* slash.registerCommand({
				name: "chain",
				spec: {
					description: "Run agents in sequence: /chain agent1 task1 -> agent2 task2",
					handler: async (args, ctx) => {
						const segments = args.split("->").map((s) => s.trim()).filter(Boolean);
						if (segments.length < 2) {
							ctx.ui.notify("Usage: /chain agent1 task1 -> agent2 task2", "error");
							return;
						}
						const chain = segments.map((seg, i) => {
							const match = seg.match(/^(\S+)\s+(.+)$/);
							if (!match) return null;
							return { agent: match[1], task: match[2] } as { agent: string; task?: string };
						}).filter(Boolean) as { agent: string; task?: string }[];
						if (chain.length === 0) {
							ctx.ui.notify("Usage: /chain agent1 task1 -> agent2 task2", "error");
							return;
						}
						const params = { chain, clarify: false, agentScope: "both" as const };
						await runSlashSubagent(pi, params, ctx.cwd, []);
					},
				},
			});
			yield* slash.registerCommand({
				name: "status",
				spec: {
					description: "Show async subagent run status",
					handler: async (_args, ctx) => {
						if (!ctx.hasUI) return;
						ctx.ui.notify("Use the subagent_status tool to check async run status", "info");
					},
				},
			});
		}),
	).catch(() => {});

	pi.on("session_shutdown", () => {
		if (_runtime) {
			disposeRuntime();
			_runtime = undefined;
		}
	});
}