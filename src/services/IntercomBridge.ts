/**
 * IntercomBridge service.
 *
 * Wires the optional `pi-intercom` extension into a subagent's
 * system prompt + tool list so the subagent can coordinate with
 * its orchestrator session via the `intercom` tool.
 *
 * Replaces intercom-bridge.ts (174 LOC). The legacy module did all
 * fs work synchronously inline; the new shape:
 *   - keeps all logic pure for `applyToAgent` (no fs there)
 *   - moves the config-load + extension-existence-check work onto
 *     FileSystem so the test layer can drive every branch
 *   - exposes resolveIntercomSessionTarget + resolveIntercomBridgeMode
 *     as pure helpers (parity with legacy exports)
 *
 * The cross-process detach signal coordination (event-bus race in
 * runSingle, Phase 5/8 follow-up) reuses PiEventBus directly — this
 * service just owns the system-prompt injection.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "./FileSystem.ts";

// ============================================================================
// Constants (match legacy intercom-bridge.ts:7-15 exactly)
// ============================================================================

const DEFAULT_INTERCOM_EXTENSION_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"pi-intercom",
);
const DEFAULT_INTERCOM_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"intercom",
	"config.json",
);
const DEFAULT_SUBAGENT_CONFIG_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"subagent",
);
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `Use intercom only for coordination with the orchestrator session:
- Need a decision or blocked: intercom({ action: "ask", to: "{orchestratorTarget}", message: "<question>" })
- Completion/update: intercom({ action: "send", to: "{orchestratorTarget}", message: "DONE: <summary>" })
If intercom is unavailable in this run, continue the task normally.`;

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	readonly mode?: IntercomBridgeMode;
	readonly instructionFile?: string;
}

export interface IntercomBridgeState {
	readonly active: boolean;
	readonly mode: IntercomBridgeMode;
	readonly orchestratorTarget?: string;
	readonly extensionDir: string;
	readonly instruction: string;
}

interface MinimalAgent {
	readonly tools?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly systemPrompt: string;
}

// ============================================================================
// Pure helpers (port of intercom-bridge.ts:34-108)
// ============================================================================

export function resolveIntercomSessionTarget(
	sessionName: string | undefined,
	sessionId: string,
): string {
	const trimmedName = sessionName?.trim();
	if (trimmedName) return trimmedName;
	const normalizedSessionId = sessionId.startsWith("session-")
		? sessionId.slice("session-".length)
		: sessionId;
	return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

export function resolveIntercomBridgeMode(value: unknown): IntercomBridgeMode {
	if (value === "off" || value === "always" || value === "fork-only") return value;
	return "always";
}

function resolveIntercomBridgeConfig(value: IntercomBridgeConfig | undefined): {
	readonly mode: IntercomBridgeMode;
	readonly instructionFile: string;
} {
	if (!value || typeof value !== "object") {
		return { mode: "always", instructionFile: "" };
	}
	return {
		mode: resolveIntercomBridgeMode(value.mode),
		instructionFile: typeof value.instructionFile === "string" ? value.instructionFile : "",
	};
}

function expandTilde(filePath: string): string {
	return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function buildIntercomBridgeInstruction(orchestratorTarget: string, template: string): string {
	const instruction = template.replaceAll("{orchestratorTarget}", orchestratorTarget).trim();
	if (instruction.startsWith(INTERCOM_BRIDGE_MARKER)) return instruction;
	return `${INTERCOM_BRIDGE_MARKER}\n${instruction}`;
}

function extensionSandboxAllowsIntercom(
	extensions: ReadonlyArray<string> | undefined,
	extensionDir: string,
): boolean {
	if (extensions === undefined) return true;
	const intercomDir = path.resolve(extensionDir).replaceAll("\\", "/").toLowerCase();
	for (const entry of extensions) {
		const normalized = entry.trim().replaceAll("\\", "/").toLowerCase();
		if (normalized === "pi-intercom") return true;
		if (normalized === intercomDir) return true;
		if (normalized.startsWith(`${intercomDir}/`)) return true;
		if (normalized.endsWith("/pi-intercom")) return true;
		if (normalized.includes("/pi-intercom/")) return true;
	}
	return false;
}

/**
 * Inject the bridge instruction + `intercom` tool into an agent's
 * config. Pure. The fs side (config load + extension dir existence)
 * is captured up-front in `bridge: IntercomBridgeState`.
 */
export function applyIntercomBridgeToAgent<A extends MinimalAgent>(agent: A, bridge: IntercomBridgeState): A {
	if (!bridge.active || !bridge.orchestratorTarget) return agent;
	if (!extensionSandboxAllowsIntercom(agent.extensions, bridge.extensionDir)) return agent;

	const tools =
		agent.tools && !agent.tools.includes("intercom") ? [...agent.tools, "intercom"] : agent.tools;

	const trimmedPrompt = agent.systemPrompt?.trim() || "";
	const systemPrompt = trimmedPrompt.includes(INTERCOM_BRIDGE_MARKER)
		? trimmedPrompt
		: trimmedPrompt
			? `${trimmedPrompt}\n\n${bridge.instruction}`
			: bridge.instruction;

	if (tools === agent.tools && systemPrompt === agent.systemPrompt) return agent;
	return { ...agent, tools, systemPrompt };
}

// ============================================================================
// Service
// ============================================================================

export interface ResolveBridgeInput {
	readonly config: IntercomBridgeConfig | undefined;
	readonly context: "fresh" | "fork" | undefined;
	readonly orchestratorTarget?: string;
	readonly extensionDir?: string;
	readonly configPath?: string;
	readonly settingsDir?: string;
}

export interface IntercomBridgeService {
	/**
	 * Decide whether the bridge should be active for this run, and
	 * what instruction to inject. Performs the fs probes
	 * (extension-dir-existence + intercom-config-enabled-flag) via
	 * FileSystem so the Test layer can drive both branches.
	 */
	readonly resolve: (
		input: ResolveBridgeInput,
	) => Effect.Effect<IntercomBridgeState>;
}

export class IntercomBridge extends Context.Service<IntercomBridge, IntercomBridgeService>()(
	"pi-subagents/IntercomBridge",
) {}

// ============================================================================
// Live
// ============================================================================

export const IntercomBridgeLive = Layer.effect(IntercomBridge)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;

		const intercomEnabled = (configPath: string): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(configPath);
				if (!exists) return true;
				const text = yield* fsApi.read(configPath).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed("")),
					Effect.catchTag("FsReadError", () => Effect.succeed("")),
				);
				if (!text) return true;
				return yield* Effect.try({
					try: () => {
						const parsed = JSON.parse(text) as { enabled?: unknown };
						return parsed.enabled !== false;
					},
					catch: () => true,
				}).pipe(Effect.orElseSucceed(() => true));
			});

		const resolveInstructionTemplate = (
			instructionFile: string,
			settingsDir: string,
		): Effect.Effect<string> =>
			Effect.gen(function* () {
				if (!instructionFile) return DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
				const expanded = expandTilde(instructionFile);
				const resolved = path.isAbsolute(expanded)
					? expanded
					: path.resolve(settingsDir, expanded);
				const text = yield* fsApi.read(resolved).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed("")),
					Effect.catchTag("FsReadError", () => Effect.succeed("")),
				);
				return text || DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
			});

		const resolve = (input: ResolveBridgeInput): Effect.Effect<IntercomBridgeState> =>
			Effect.gen(function* () {
				const config = resolveIntercomBridgeConfig(input.config);
				const mode = config.mode;
				const extensionDir = path.resolve(input.extensionDir ?? DEFAULT_INTERCOM_EXTENSION_DIR);
				const orchestratorTarget = input.orchestratorTarget?.trim();
				const settingsDir = path.resolve(input.settingsDir ?? DEFAULT_SUBAGENT_CONFIG_DIR);
				const defaultInstruction = buildIntercomBridgeInstruction(
					orchestratorTarget || "{orchestratorTarget}",
					DEFAULT_INTERCOM_BRIDGE_TEMPLATE,
				);

				if (mode === "off") {
					return { active: false, mode, extensionDir, instruction: defaultInstruction };
				}
				if (mode === "fork-only" && input.context !== "fork") {
					return { active: false, mode, extensionDir, instruction: defaultInstruction };
				}
				if (!orchestratorTarget) {
					return { active: false, mode, extensionDir, instruction: defaultInstruction };
				}
				const extDirExists = yield* fsApi.isDirectory(extensionDir);
				if (!extDirExists) {
					return { active: false, mode, extensionDir, instruction: defaultInstruction };
				}

				const configPath = path.resolve(input.configPath ?? DEFAULT_INTERCOM_CONFIG_PATH);
				const enabled = yield* intercomEnabled(configPath);
				if (!enabled) {
					return { active: false, mode, extensionDir, instruction: defaultInstruction };
				}

				const template = yield* resolveInstructionTemplate(config.instructionFile, settingsDir);
				const instruction = buildIntercomBridgeInstruction(orchestratorTarget, template);
				return { active: true, mode, orchestratorTarget, extensionDir, instruction };
			});

		return IntercomBridge.of({ resolve });
	}),
);

export const IntercomBridgeTest = IntercomBridgeLive;

export {
	DEFAULT_INTERCOM_BRIDGE_TEMPLATE,
	DEFAULT_INTERCOM_EXTENSION_DIR,
	INTERCOM_BRIDGE_MARKER,
};
