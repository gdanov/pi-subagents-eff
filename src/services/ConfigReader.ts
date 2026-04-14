/**
 * ConfigReader service.
 *
 * Loads on-disk JSON config files from well-known paths.
 *
 * Replaces:
 *   - index.ts:loadConfig (~/.pi/agent/extensions/subagent/config.json)
 *   - intercom-bridge.ts:resolveIntercomBridge (intercom config)
 *   - settings.ts paths (~/.pi/agent/settings.json, .pi/settings.json)
 *
 * Live : depends on FileSystem (so the test layer just stubs FileSystem).
 * Test : returns frozen config objects.
 */
import { Context, Effect, Layer } from "effect";
import type { ConfigParseError } from "../errors.ts";

/** Mirrors types.ts:ExtensionConfig — to be replaced by Schema-decoded value in Phase 2. */
export interface ExtensionConfig {
	readonly asyncByDefault?: boolean;
	readonly defaultSessionDir?: string;
	readonly maxSubagentDepth?: number;
	readonly worktreeSetupHook?: string;
	readonly worktreeSetupHookTimeoutMs?: number;
	readonly intercomBridge?: unknown;
}

export interface ConfigReaderService {
	readonly loadExtensionConfig: Effect.Effect<ExtensionConfig, ConfigParseError>;
	readonly loadIntercomConfig: Effect.Effect<unknown, ConfigParseError>;
}

export class ConfigReader extends Context.Service<ConfigReader, ConfigReaderService>()("pi-subagents/ConfigReader") {}

export const ConfigReaderLive = Layer.sync(ConfigReader)(() => {
	throw new Error("ConfigReader.Live not yet implemented (Phase 3)");
});

export const makeConfigReaderTest = (
	_extension: ExtensionConfig = {},
	_intercom: unknown = null,
): Layer.Layer<ConfigReader, never, never> =>
	Layer.sync(ConfigReader)(() => {
		throw new Error("ConfigReader.Test not yet implemented (Phase 3)");
	});
