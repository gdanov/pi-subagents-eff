/**
 * Process-wide constants and path derivation.
 *
 * Ported from types.ts:289-389. Kept as plain values + pure functions
 * (no Effect environment) because every consumer in the legacy code
 * imports them at module-load time. Effect-aware modules read these
 * values directly; nothing here depends on a Layer.
 *
 * On-disk path layout MUST stay byte-compatible with the legacy
 * implementation — the temp scope id, the four scoped subdirectories,
 * the WIDGET_KEY, the SLASH_RESULT_TYPE, and the event-channel names
 * are all part of the public extension contract.
 */
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Defaults
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

// ============================================================================
// Concurrency caps and tunables
// ============================================================================

export const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const MAX_PARALLEL_CONCURRENCY = 4;
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;

// ============================================================================
// Event channel names + slot keys
// ============================================================================

export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";

// ============================================================================
// Fork preamble (system-prompt prefix for `context: "fork"` subagents)
// ============================================================================

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent with access to the parent session's context for reference. " +
	"Your sole job is to execute the task below. Do not continue or respond to the prior conversation " +
	"— focus exclusively on completing this task using your tools.";

// ============================================================================
// Temp scope identification
// ============================================================================

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

/**
 * Derive a stable per-user identifier for the shared temp scope.
 *
 * Order of preference: posix uid > USERNAME/USER/LOGNAME env > os.userInfo
 * > USERPROFILE/HOME env > os.homedir > literal "shared".
 *
 * The optional injection points exist purely so the unit tests can
 * exercise every branch deterministically. Do not pass them in
 * production code.
 */
export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid =
		options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo =
		options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir =
		options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

// ============================================================================
// Scoped temp directories
// ============================================================================

export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}
