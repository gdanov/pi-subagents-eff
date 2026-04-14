/**
 * Management dispatcher — Effect-native port of the action surface in
 * agent-management.ts (`list` | `get` | `create` | `update` | `delete`
 * for agents and chains).
 *
 * Phase 8 scope:
 *   - list  : enumerate agents + chains across scopes
 *   - get   : detail block for one agent or chain
 *   - create: write a new .md or .chain.md
 *   - update: rewrite an existing .md or .chain.md (no rename for now)
 *   - delete: rm a .md or .chain.md
 *
 * Out of scope (deferred to a follow-up — these are validations not
 * blocking the entry swap):
 *   - rename across scopes + chain-step reference warnings
 *   - builtin agent overrides via settings.json (separate Phase 8.x
 *     follow-up; legacy lives in agents.ts:218-280)
 *   - modelRegistry validation warnings
 *   - skill-discovery warnings
 *
 * Returns `Details`-shaped tool results so the eventual entry point
 * can hand them straight to Pi as `AgentToolResult<Details>`.
 */
import * as path from "node:path";
import { Effect, Result, Schema } from "effect";
import type { Details } from "../domain/results.ts";
import { AgentDirectory, type AgentConfig, type AgentScope } from "../services/AgentDirectory.ts";
import {
	parseChain,
	serializeChain,
	type ChainConfig,
	type ChainStepConfig,
} from "./chain-serializer.ts";
import { sanitizeName, serializeAgent } from "./agent-serializer.ts";

// ============================================================================
// Tool-result shape — wire-compatible with legacy management responses
// ============================================================================

export interface ManagementToolResult {
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	readonly isError?: boolean;
	readonly details: Details;
}

function ok(text: string): ManagementToolResult {
	return {
		content: [{ type: "text", text }],
		details: { mode: "management" as const, results: [] },
	};
}

function fail(text: string): ManagementToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { mode: "management" as const, results: [] },
	};
}

// ============================================================================
// Pure formatters (port of agent-management.ts:316-349)
// ============================================================================

export function formatAgentDetail(agent: AgentConfig): string {
	const tools = [
		...(agent.tools ?? []),
		...((agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)),
	];
	const lines: string[] = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${[...agent.fallbackModels].join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${[...agent.skills].join(", ")}`);
	if (agent.extensions !== undefined) {
		lines.push(`Extensions: ${agent.extensions.length ? [...agent.extensions].join(", ") : "(none)"}`);
	}
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${[...agent.defaultReads].join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [
		`Chain: ${chain.name} (${chain.source})`,
		`Path: ${chain.filePath}`,
		`Description: ${chain.description}`,
		"",
		"Steps:",
	];
	for (let i = 0; i < chain.steps.length; i++) {
		const s = chain.steps[i]!;
		lines.push(`${i + 1}. ${s.agent}`);
		if (s.task.trim()) lines.push(`   Task: ${s.task}`);
		if (s.output === false) lines.push("   Output: false");
		else if (s.output) lines.push(`   Output: ${s.output}`);
		if (s.reads === false) lines.push("   Reads: false");
		else if (Array.isArray(s.reads) && s.reads.length > 0)
			lines.push(`   Reads: ${[...s.reads].join(", ")}`);
		if (s.model) lines.push(`   Model: ${s.model}`);
		if (s.skills === false) lines.push("   Skills: false");
		else if (Array.isArray(s.skills) && s.skills.length > 0)
			lines.push(`   Skills: ${[...s.skills].join(", ")}`);
		if (s.progress !== undefined) lines.push(`   Progress: ${s.progress ? "true" : "false"}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Input shapes
// ============================================================================

export interface ManagementParams {
	readonly action: "list" | "get" | "create" | "update" | "delete";
	readonly agent?: string;
	readonly chainName?: string;
	readonly agentScope?: string;
	readonly config?: unknown;
}

export interface ManagementContext {
	readonly cwd: string;
}

function asListScope(value: unknown): AgentScope {
	if (value === "user" || value === "project" || value === "both") return value;
	return "both";
}

const decodeJsonStringResult = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);

function configObject(
	config: unknown,
): { readonly value?: Record<string, unknown>; readonly error?: string } {
	let val = config;
	if (typeof val === "string") {
		// Pure Schema-based JSON decode; no try/catch. Failure surfaces as
		// a Result.Failure whose issue has a human-readable message.
		const decoded = decodeJsonStringResult(val);
		if (Result.isFailure(decoded)) {
			return { error: `config must be valid JSON: ${String(decoded.failure)}` };
		}
		val = decoded.success;
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Surface FsWriteError as a user-visible `fail(...)` ManagementToolResult
 * instead of silently swallowing it. Returns undefined on success so
 * the caller can early-return `undefined` → continue, or a concrete
 * fail(...) → propagate.
 */
const writeOrFail = <A>(
	description: string,
	effect: Effect.Effect<A, { readonly _tag: "FsWriteError"; readonly path: string; readonly cause: unknown }>,
): Effect.Effect<ManagementToolResult | undefined> =>
	effect.pipe(
		Effect.asVoid,
		Effect.map(() => undefined as ManagementToolResult | undefined),
		Effect.catchTag("FsWriteError", (err) =>
			Effect.succeed(fail(`${description} failed at ${err.path}: ${String(err.cause)}`)),
		),
	);

// ============================================================================
// Dispatcher
// ============================================================================

export const handleManagementAction = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		switch (params.action) {
			case "list":
				return yield* handleList(params, ctx);
			case "get":
				return yield* handleGet(params, ctx);
			case "create":
				return yield* handleCreate(params, ctx);
			case "update":
				return yield* handleUpdate(params, ctx);
			case "delete":
				return yield* handleDelete(params, ctx);
			default:
				return fail(`Unknown action: ${params.action}`);
		}
	});

// ============================================================================
// list
// ============================================================================

const handleList = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		const dir = yield* AgentDirectory;
		const scope = asListScope(params.agentScope);
		const agents = yield* dir.discover(ctx.cwd, scope).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentConfig>));
		const chains = yield* dir.discoverChains(ctx.cwd, scope).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ChainConfig>));
		const sortedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
		const sortedChains = [...chains].sort((a, b) => a.name.localeCompare(b.name));
		const lines = [
			"Agents:",
			...(sortedAgents.length
				? sortedAgents.map((a) => `- ${a.name} (${a.source}): ${a.description}`)
				: ["- (none)"]),
			"",
			"Chains:",
			...(sortedChains.length
				? sortedChains.map((c) => `- ${c.name} (${c.source}): ${c.description}`)
				: ["- (none)"]),
		];
		return ok(lines.join("\n"));
	});

// ============================================================================
// get
// ============================================================================

const handleGet = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		if (!params.agent && !params.chainName) return fail("Specify 'agent' or 'chainName' for get.");
		const dir = yield* AgentDirectory;
		const allAgents = yield* dir.discover(ctx.cwd, "both").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentConfig>));
		const allChains = yield* dir.discoverChains(ctx.cwd, "both").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ChainConfig>));
		const blocks: string[] = [];
		let anyFound = false;

		if (params.agent) {
			const target = params.agent.trim();
			const sanitized = sanitizeName(target);
			const matches = allAgents.filter((a) => a.name === target || a.name === sanitized);
			if (matches.length === 0) {
				const available = allAgents.map((a) => a.name).join(", ") || "none";
				const msg = `Agent '${target}' not found. Available: ${available}.`;
				if (!params.chainName) return fail(msg);
				blocks.push(msg);
			} else {
				anyFound = true;
				blocks.push(...matches.map(formatAgentDetail));
			}
		}

		if (params.chainName) {
			const target = params.chainName.trim();
			const sanitized = sanitizeName(target);
			const matches = allChains.filter((c) => c.name === target || c.name === sanitized);
			if (matches.length === 0) {
				const available = allChains.map((c) => c.name).join(", ") || "none";
				const msg = `Chain '${target}' not found. Available: ${available}.`;
				if (!params.agent) return fail(msg);
				blocks.push(msg);
			} else {
				anyFound = true;
				blocks.push(...matches.map(formatChainDetail));
			}
		}

		const text = blocks.join("\n\n");
		return anyFound ? ok(text) : fail(text);
	});

// ============================================================================
// create
// ============================================================================

const handleCreate = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		const parsedConfig = configObject(params.config);
		if (parsedConfig.error) return fail(parsedConfig.error);
		const cfg = parsedConfig.value;
		if (!cfg) return fail("config required for create.");

		if (typeof cfg.name !== "string" || !cfg.name.trim()) {
			return fail("config.name is required and must be a non-empty string.");
		}
		if (typeof cfg.description !== "string" || !cfg.description.trim()) {
			return fail("config.description is required and must be a non-empty string.");
		}
		const name = sanitizeName(cfg.name);
		if (!name) {
			return fail("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.");
		}
		const scopeRaw = cfg.scope ?? "user";
		if (scopeRaw !== "user" && scopeRaw !== "project") {
			return fail("config.scope must be 'user' or 'project'.");
		}
		const scope = scopeRaw as "user" | "project";

		const isChain = hasKey(cfg, "steps");
		const dir = yield* AgentDirectory;

		if (isChain) {
			const filePath = yield* dir.resolveChainPath({ cwd: ctx.cwd, scope, name }).pipe(
				Effect.orElseSucceed(() => null as string | null),
			);
			if (!filePath) return fail("could not resolve chain path");
			const stepsResult = parseStepListFromConfig(cfg.steps);
			if (stepsResult.error) return fail(stepsResult.error);
			const chain: ChainConfig = {
				name,
				description: (cfg.description as string).trim(),
				source: scope,
				filePath,
				steps: stepsResult.steps ?? [],
			};
			const err = yield* writeOrFail(`create chain '${name}'`, dir.writeChain(filePath, serializeChain(chain)));
			if (err) return err;
			return ok(`Created chain '${name}' at ${filePath}.`);
		}

		const filePath = yield* dir.resolveAgentPath({ cwd: ctx.cwd, scope, name }).pipe(
			Effect.orElseSucceed(() => null as string | null),
		);
		if (!filePath) return fail("could not resolve agent path");

		const agent: AgentConfig = applyConfigToAgent(
			{
				name,
				description: (cfg.description as string).trim(),
				source: scope,
				filePath,
				systemPrompt: "",
			},
			cfg,
		);

		const writeErr = yield* writeOrFail(
			`create agent '${name}'`,
			dir.writeAgent(filePath, serializeAgent(agent)),
		);
		if (writeErr) return writeErr;
		return ok(`Created agent '${name}' at ${filePath}.`);
	});

// ============================================================================
// update
// ============================================================================

const handleUpdate = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		if (!params.agent && !params.chainName) {
			return fail("Specify 'agent' or 'chainName' for update.");
		}
		if (params.agent && params.chainName) {
			return fail("Specify either 'agent' or 'chainName', not both.");
		}
		const parsedConfig = configObject(params.config);
		if (parsedConfig.error) return fail(parsedConfig.error);
		const cfg = parsedConfig.value;
		if (!cfg) return fail("config required for update.");

		const dir = yield* AgentDirectory;

		if (params.agent) {
			const all = yield* dir.discover(ctx.cwd, "both").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentConfig>));
			const target = all.find((a) => a.name === params.agent || a.name === sanitizeName(params.agent ?? ""));
			if (!target) return fail(`Agent '${params.agent}' not found.`);
			const updated = applyConfigToAgent(target, cfg);
			const err = yield* writeOrFail(
				`update agent '${target.name}'`,
				dir.writeAgent(target.filePath, serializeAgent(updated)),
			);
			if (err) return err;
			return ok(`Updated agent '${target.name}' at ${target.filePath}.`);
		}

		const allChains = yield* dir.discoverChains(ctx.cwd, "both").pipe(
			Effect.orElseSucceed(() => [] as ReadonlyArray<ChainConfig>),
		);
		const target = allChains.find((c) => c.name === params.chainName || c.name === sanitizeName(params.chainName ?? ""));
		if (!target) return fail(`Chain '${params.chainName}' not found.`);
		const updatedChain: ChainConfig = applyConfigToChain(target, cfg);
		const err = yield* writeOrFail(
			`update chain '${target.name}'`,
			dir.writeChain(target.filePath, serializeChain(updatedChain)),
		);
		if (err) return err;
		return ok(`Updated chain '${target.name}' at ${target.filePath}.`);
	});

// ============================================================================
// delete
// ============================================================================

const handleDelete = (
	params: ManagementParams,
	ctx: ManagementContext,
): Effect.Effect<ManagementToolResult, never, AgentDirectory> =>
	Effect.gen(function* () {
		if (!params.agent && !params.chainName) {
			return fail("Specify 'agent' or 'chainName' for delete.");
		}
		if (params.agent && params.chainName) {
			return fail("Specify either 'agent' or 'chainName', not both.");
		}
		const dir = yield* AgentDirectory;

		if (params.agent) {
			const all = yield* dir.discover(ctx.cwd, "both").pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentConfig>));
			const target = all.find((a) => a.name === params.agent || a.name === sanitizeName(params.agent ?? ""));
			if (!target) return fail(`Agent '${params.agent}' not found.`);
			const err = yield* writeOrFail(
				`delete agent '${target.name}'`,
				dir.remove(target.filePath),
			);
			if (err) return err;
			return ok(`Deleted agent '${target.name}' at ${target.filePath}.`);
		}

		const allChains = yield* dir.discoverChains(ctx.cwd, "both").pipe(
			Effect.orElseSucceed(() => [] as ReadonlyArray<ChainConfig>),
		);
		const target = allChains.find((c) => c.name === params.chainName || c.name === sanitizeName(params.chainName ?? ""));
		if (!target) return fail(`Chain '${params.chainName}' not found.`);
		const err = yield* writeOrFail(
			`delete chain '${target.name}'`,
			dir.remove(target.filePath),
		);
		if (err) return err;
		return ok(`Deleted chain '${target.name}' at ${target.filePath}.`);
	});

// ============================================================================
// Pure config-application helpers
// ============================================================================

function applyConfigToAgent(base: AgentConfig, cfg: Record<string, unknown>): AgentConfig {
	const next: AgentConfig = { ...base };
	if (typeof cfg.description === "string") (next as { description: string }).description = cfg.description.trim();
	if (typeof cfg.systemPrompt === "string") (next as { systemPrompt: string }).systemPrompt = cfg.systemPrompt;
	if (typeof cfg.model === "string") (next as { model?: string }).model = cfg.model;
	if (typeof cfg.thinking === "string") (next as { thinking?: string }).thinking = cfg.thinking;
	if (typeof cfg.tools === "string") {
		const list = cfg.tools.split(",").map((t) => t.trim()).filter(Boolean);
		const tools: string[] = [];
		const mcp: string[] = [];
		for (const tool of list) {
			if (tool.startsWith("mcp:")) mcp.push(tool.slice(4));
			else tools.push(tool);
		}
		(next as { tools?: ReadonlyArray<string> }).tools = tools.length ? tools : undefined;
		(next as { mcpDirectTools?: ReadonlyArray<string> }).mcpDirectTools = mcp.length ? mcp : undefined;
	}
	if (typeof cfg.extensions === "string") {
		(next as { extensions?: ReadonlyArray<string> }).extensions = cfg.extensions
			.split(",")
			.map((e) => e.trim())
			.filter(Boolean);
	}
	if (typeof cfg.skills === "string") {
		(next as { skills?: ReadonlyArray<string> }).skills = cfg.skills
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (typeof cfg.fallbackModels === "string") {
		(next as { fallbackModels?: ReadonlyArray<string> }).fallbackModels = cfg.fallbackModels
			.split(",")
			.map((m) => m.trim())
			.filter(Boolean);
	}
	if (typeof cfg.output === "string") (next as { output?: string }).output = cfg.output;
	if (typeof cfg.defaultReads === "string") {
		(next as { defaultReads?: ReadonlyArray<string> }).defaultReads = cfg.defaultReads
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
	}
	if (typeof cfg.defaultProgress === "boolean") (next as { defaultProgress?: boolean }).defaultProgress = cfg.defaultProgress;
	if (typeof cfg.maxSubagentDepth === "number") (next as { maxSubagentDepth?: number }).maxSubagentDepth = cfg.maxSubagentDepth;
	return next;
}

function applyConfigToChain(base: ChainConfig, cfg: Record<string, unknown>): ChainConfig {
	const next: ChainConfig = { ...base };
	if (typeof cfg.description === "string") (next as { description: string }).description = cfg.description.trim();
	if (hasKey(cfg, "steps")) {
		const stepsResult = parseStepListFromConfig(cfg.steps);
		if (stepsResult.steps) (next as { steps: ReadonlyArray<ChainStepConfig> }).steps = stepsResult.steps;
	}
	return next;
}

function parseStepListFromConfig(raw: unknown): {
	readonly steps?: ReadonlyArray<ChainStepConfig>;
	readonly error?: string;
} {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array" };
	const steps: ChainStepConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const s = raw[i];
		if (!s || typeof s !== "object") return { error: `steps[${i}] must be an object` };
		const obj = s as Record<string, unknown>;
		if (typeof obj.agent !== "string" || !obj.agent.trim()) {
			return { error: `steps[${i}].agent is required` };
		}
		const step: ChainStepConfig = {
			agent: obj.agent.trim(),
			task: typeof obj.task === "string" ? obj.task : "",
			...(obj.output === false ? { output: false as const } : typeof obj.output === "string" ? { output: obj.output } : {}),
			...(obj.reads === false
				? { reads: false as const }
				: Array.isArray(obj.reads)
					? { reads: obj.reads.filter((r): r is string => typeof r === "string") }
					: {}),
			...(typeof obj.model === "string" ? { model: obj.model } : {}),
			...(obj.skills === false
				? { skills: false as const }
				: Array.isArray(obj.skills)
					? { skills: obj.skills.filter((s): s is string => typeof s === "string") }
					: {}),
			...(typeof obj.progress === "boolean" ? { progress: obj.progress } : {}),
		};
		steps.push(step);
	}
	return { steps };
}

// Re-exports for external callers / tests
export { sanitizeName, parseStepListFromConfig as parseChainStepsFromConfig, parseChain };
// `path` import is used implicitly through type-side-effect but tools may shake it; reference here to avoid unused-import warning.
void path;
