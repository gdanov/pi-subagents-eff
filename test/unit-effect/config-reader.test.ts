/**
 * Tests for src/services/ConfigReader.ts using a seeded
 * InMemoryFileSystem to validate the Live layer's behavior.
 *
 * Three behaviors verified:
 *   1. Missing file -> empty object (no error).
 *   2. Valid JSON   -> decoded value.
 *   3. Malformed    -> ConfigParseError (deliberate tightening vs the
 *                      legacy code which logged-and-returned-{}).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { ConfigParseError } from "../../src/errors.ts";
import {
	ConfigReader,
	ConfigReaderLive,
	EXTENSION_CONFIG_PATH,
	INTERCOM_CONFIG_PATH,
	makeConfigReaderTest,
} from "../../src/services/ConfigReader.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";

describe("ConfigReaderLive", () => {
	it("returns {} when the extension config file does not exist", async () => {
		const fs = makeFileSystemTest({});
		const layer = Layer.provide(ConfigReaderLive, fs.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadExtensionConfig;
				}),
				layer,
			),
		);
		assert.deepEqual(result, {});
	});

	it("decodes an extension config from disk", async () => {
		const fs = makeFileSystemTest({
			[EXTENSION_CONFIG_PATH]: JSON.stringify({
				asyncByDefault: true,
				maxSubagentDepth: 3,
				intercomBridge: { mode: "fork-only" },
			}),
		});
		const layer = Layer.provide(ConfigReaderLive, fs.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadExtensionConfig;
				}),
				layer,
			),
		);
		assert.equal(result.asyncByDefault, true);
		assert.equal(result.maxSubagentDepth, 3);
		assert.equal(result.intercomBridge?.mode, "fork-only");
	});

	it("fails with ConfigParseError when JSON is malformed", async () => {
		const fs = makeFileSystemTest({ [EXTENSION_CONFIG_PATH]: "{not json" });
		const layer = Layer.provide(ConfigReaderLive, fs.layer);
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadExtensionConfig;
				}),
				layer,
			),
		);
		if (Exit.isFailure(exit)) {
			const err = Cause.findErrorOption(exit.cause);
			if (Option.isSome(err)) assert.ok(err.value instanceof ConfigParseError);
		} else {
			assert.fail("expected failure");
		}
	});

	it("loadIntercomConfig reads its own dedicated path", async () => {
		const fs = makeFileSystemTest({ [INTERCOM_CONFIG_PATH]: JSON.stringify({ enabled: false }) });
		const layer = Layer.provide(ConfigReaderLive, fs.layer);
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadIntercomConfig;
				}),
				layer,
			),
		);
		assert.deepEqual(result, { enabled: false });
	});
});

describe("ConfigReader Test layer", () => {
	it("returns the seeded extension config", async () => {
		const layer = makeConfigReaderTest({ asyncByDefault: true });
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadExtensionConfig;
				}),
				layer,
			),
		);
		assert.equal(result.asyncByDefault, true);
	});

	it("returns the seeded intercom value", async () => {
		const layer = makeConfigReaderTest({}, { foo: "bar" });
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const cfg = yield* ConfigReader;
					return yield* cfg.loadIntercomConfig;
				}),
				layer,
			),
		);
		assert.deepEqual(result, { foo: "bar" });
	});
});
