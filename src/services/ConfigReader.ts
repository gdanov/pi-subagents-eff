/**
 * ConfigReader service.
 *
 * Reads the on-disk JSON config files used by the extension. Lives on
 * top of FileSystem so the Test layer for ConfigReader is just an
 * InMemoryFileSystem with the right files seeded.
 *
 * Replaces:
 *   - index.ts:loadConfig (the legacy path is hard-coded to
 *     ~/.pi/agent/extensions/subagent/config.json with try/catch
 *     swallowing all errors).
 *   - the on-disk-load half of intercom-bridge.ts.
 *
 * Failure semantics:
 *   - Missing file -> Effect.succeed({}). The legacy code treated
 *     "no config" as "all defaults", which is the right behavior;
 *     we surface it as a successful empty value rather than
 *     FsNotFound so callers don't have to catch it.
 *   - Malformed JSON -> ConfigParseError. The legacy code logged to
 *     console and returned {}; we propagate the error and let the
 *     adapter map it to a user-visible message. This is a behavior
 *     change, called out in the migration plan as a deliberate
 *     tightening.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { ConfigParseError } from "../errors.ts";
import { FileSystem, type FileSystemService } from "./FileSystem.ts";

// ============================================================================
// Path constants (mirror the legacy hard-coded paths)
// ============================================================================

export const EXTENSION_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"subagent",
	"config.json",
);

export const INTERCOM_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"intercom",
	"config.json",
);

// ============================================================================
// Decoded shapes (kept as plain interfaces here; Schema decoding moves
// in once Phase 11 wires the typebox-bridge — for now ConfigReader's
// job is just JSON parse + tilde expansion).
// ============================================================================

export interface IntercomBridgeConfig {
	readonly mode?: "off" | "fork-only" | "always";
	readonly instructionFile?: string;
}

export interface ExtensionConfig {
	readonly asyncByDefault?: boolean;
	readonly defaultSessionDir?: string;
	readonly maxSubagentDepth?: number;
	readonly worktreeSetupHook?: string;
	readonly worktreeSetupHookTimeoutMs?: number;
	readonly intercomBridge?: IntercomBridgeConfig;
}

export interface ConfigReaderService {
	readonly loadExtensionConfig: Effect.Effect<ExtensionConfig, ConfigParseError>;
	readonly loadIntercomConfig: Effect.Effect<unknown, ConfigParseError>;
}

export class ConfigReader extends Context.Service<ConfigReader, ConfigReaderService>()(
	"pi-subagents/ConfigReader",
) {}

// ============================================================================
// Live
// ============================================================================

/**
 * Pure helper: takes the resolved FileSystem instance directly so it
 * doesn't drag a `FileSystem` requirement back into the env channel.
 * Both Live and any future bespoke caller go through this entry point.
 */
function loadJsonOrEmpty<T>(
	fsApi: FileSystemService,
	configPath: string,
): Effect.Effect<T, ConfigParseError> {
	return Effect.gen(function* () {
		const exists = yield* fsApi.exists(configPath);
		if (!exists) return {} as T;
		const text = yield* fsApi.read(configPath).pipe(
			Effect.catchTag("FsNotFound", () => Effect.succeed("")),
			Effect.catchTag("FsReadError", (cause) =>
				Effect.fail(new ConfigParseError({ path: configPath, cause })),
			),
		);
		if (text.length === 0) return {} as T;
		return yield* Effect.try({
			try: () => JSON.parse(text) as T,
			catch: (cause) => new ConfigParseError({ path: configPath, cause }),
		});
	});
}

export const ConfigReaderLive = Layer.effect(ConfigReader)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;
		return ConfigReader.of({
			loadExtensionConfig: loadJsonOrEmpty<ExtensionConfig>(fsApi, EXTENSION_CONFIG_PATH),
			loadIntercomConfig: loadJsonOrEmpty<unknown>(fsApi, INTERCOM_CONFIG_PATH),
		});
	}),
);

// ============================================================================
// Test
// ============================================================================

export const makeConfigReaderTest = (
	extension: ExtensionConfig = {},
	intercom: unknown = null,
): Layer.Layer<ConfigReader, never, never> =>
	Layer.succeed(ConfigReader)(
		ConfigReader.of({
			loadExtensionConfig: Effect.succeed(extension),
			loadIntercomConfig: Effect.succeed(intercom),
		}),
	);
