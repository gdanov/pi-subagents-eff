/**
 * Tests for src/services/IntercomBridge.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";
import {
	applyIntercomBridgeToAgent,
	IntercomBridge,
	IntercomBridgeLive,
	INTERCOM_BRIDGE_MARKER,
	resolveIntercomBridgeMode,
	resolveIntercomSessionTarget,
	type IntercomBridgeState,
} from "../../src/services/IntercomBridge.ts";

const EXTENSION_DIR = "/intercom-ext";

function build(initialFs?: Record<string, string>) {
	const fs = makeFileSystemTest(initialFs);
	return {
		fs,
		layer: Layer.provide(IntercomBridgeLive, fs.layer),
	};
}

describe("resolveIntercomBridgeMode", () => {
	it("accepts the three canonical modes; defaults to always", () => {
		assert.equal(resolveIntercomBridgeMode("off"), "off");
		assert.equal(resolveIntercomBridgeMode("always"), "always");
		assert.equal(resolveIntercomBridgeMode("fork-only"), "fork-only");
		assert.equal(resolveIntercomBridgeMode("garbage"), "always");
		assert.equal(resolveIntercomBridgeMode(undefined), "always");
	});
});

describe("resolveIntercomSessionTarget", () => {
	it("uses sessionName when provided, else derives from sessionId", () => {
		assert.equal(resolveIntercomSessionTarget("my-session", "any"), "my-session");
		assert.equal(
			resolveIntercomSessionTarget(undefined, "session-abcdefghijklmnop"),
			"subagent-chat-abcdefgh",
		);
		assert.equal(
			resolveIntercomSessionTarget(undefined, "1234567890"),
			"subagent-chat-12345678",
		);
	});
});

describe("IntercomBridge.resolve (Live)", () => {
	it("returns inactive when mode=off", async () => {
		const { layer } = build();
		const state = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const b = yield* IntercomBridge;
					return yield* b.resolve({
						config: { mode: "off" },
						context: "fresh",
						orchestratorTarget: "x",
					});
				}),
				layer,
			),
		);
		assert.equal(state.active, false);
		assert.equal(state.mode, "off");
	});

	it("returns inactive when fork-only mode but context is fresh", async () => {
		const { layer } = build({ [`${EXTENSION_DIR}/.keep`]: "" });
		const state = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const b = yield* IntercomBridge;
					return yield* b.resolve({
						config: { mode: "fork-only" },
						context: "fresh",
						orchestratorTarget: "x",
						extensionDir: EXTENSION_DIR,
					});
				}),
				layer,
			),
		);
		assert.equal(state.active, false);
	});

	it("returns inactive when extensionDir does not exist", async () => {
		const { layer } = build();
		const state = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const b = yield* IntercomBridge;
					return yield* b.resolve({
						config: { mode: "always" },
						context: "fresh",
						orchestratorTarget: "x",
						extensionDir: EXTENSION_DIR,
					});
				}),
				layer,
			),
		);
		assert.equal(state.active, false);
	});

	it("activates when mode=always + extensionDir exists + orchestratorTarget set", async () => {
		const { layer } = build({ [`${EXTENSION_DIR}/.keep`]: "" });
		const state = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const b = yield* IntercomBridge;
					return yield* b.resolve({
						config: { mode: "always" },
						context: "fresh",
						orchestratorTarget: "session-abc",
						extensionDir: EXTENSION_DIR,
					});
				}),
				layer,
			),
		);
		assert.equal(state.active, true);
		assert.equal(state.orchestratorTarget, "session-abc");
		assert.match(state.instruction, new RegExp(INTERCOM_BRIDGE_MARKER));
		assert.match(state.instruction, /session-abc/);
	});

	it("respects intercom config.enabled=false", async () => {
		const configPath = "/intercom/config.json";
		const { layer } = build({
			[`${EXTENSION_DIR}/.keep`]: "",
			[configPath]: JSON.stringify({ enabled: false }),
		});
		const state = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const b = yield* IntercomBridge;
					return yield* b.resolve({
						config: { mode: "always" },
						context: "fresh",
						orchestratorTarget: "t",
						extensionDir: EXTENSION_DIR,
						configPath,
					});
				}),
				layer,
			),
		);
		assert.equal(state.active, false);
	});
});

describe("applyIntercomBridgeToAgent", () => {
	const baseBridge: IntercomBridgeState = {
		active: true,
		mode: "always",
		orchestratorTarget: "session-x",
		extensionDir: EXTENSION_DIR,
		instruction: `${INTERCOM_BRIDGE_MARKER}\nDo coordination via intercom.`,
	};

	it("appends instruction + intercom tool when active", () => {
		const agent = applyIntercomBridgeToAgent(
			{ tools: ["read"], systemPrompt: "Be helpful." },
			baseBridge,
		);
		assert.deepEqual([...(agent.tools ?? [])], ["read", "intercom"]);
		assert.match(agent.systemPrompt, /Be helpful\./);
		assert.match(agent.systemPrompt, new RegExp(INTERCOM_BRIDGE_MARKER));
	});

	it("is a no-op when bridge inactive", () => {
		const agent = { tools: ["read"], systemPrompt: "p" };
		const result = applyIntercomBridgeToAgent(agent, { ...baseBridge, active: false });
		assert.equal(result, agent);
	});

	it("does not duplicate the marker if already present", () => {
		const promptWithMarker = `${INTERCOM_BRIDGE_MARKER}\nold instruction`;
		const result = applyIntercomBridgeToAgent(
			{ tools: ["read"], systemPrompt: promptWithMarker },
			baseBridge,
		);
		// Only one occurrence of the marker.
		const hits = (result.systemPrompt.match(new RegExp(INTERCOM_BRIDGE_MARKER, "g")) ?? []).length;
		assert.equal(hits, 1);
	});

	it("does not add intercom when extension sandbox excludes it", () => {
		const result = applyIntercomBridgeToAgent(
			{ tools: ["read"], extensions: ["/some/other/ext.ts"], systemPrompt: "p" },
			baseBridge,
		);
		// Extensions list present and doesn't include intercom -> tool not added.
		assert.deepEqual([...(result.tools ?? [])], ["read"]);
	});
});
