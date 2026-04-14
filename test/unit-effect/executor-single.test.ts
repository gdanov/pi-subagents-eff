/**
 * Tests for src/executor/single.ts using the Test layers for
 * PiSpawner + FileSystem + ArtifactStore + ModelResolver.
 *
 * Coverage:
 *   - Happy path: assistant text message -> SingleResult with final
 *     output + progress + artifact writes.
 *   - Tool execution events update progress.toolCount, recentTools.
 *   - Non-zero exit with stderr -> result.error populated.
 *   - Model resolution: bare-id becomes provider/id when unambiguous.
 *   - onUpdate callback fires during the run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import { ArtifactStoreLive } from "../../src/services/ArtifactStore.ts";
import { FileSystem, makeFileSystemTest } from "../../src/services/FileSystem.ts";
import { ModelResolverLive } from "../../src/services/ModelResolver.ts";
import {
	makePiSpawnerTest,
	type PiEvent,
} from "../../src/services/PiSpawner.ts";
import { runSingle, type RunSingleAgent } from "../../src/executor/single.ts";

const ASSISTANT_REPLY: PiEvent = {
	type: "stdout",
	line: JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			model: "anthropic/claude-sonnet-4",
		},
	}),
};

const EXIT_OK: PiEvent = { type: "exit", code: 0, signal: null };
const EXIT_FAIL: PiEvent = { type: "exit", code: 2, signal: null };

const STUB_AGENT: RunSingleAgent = {
	name: "scout",
	systemPrompt: "You are scout.",
};

function buildLayer(spawnerScript: Array<Parameters<typeof makePiSpawnerTest>[0][number]>) {
	const fs = makeFileSystemTest();
	const spawner = makePiSpawnerTest(spawnerScript);
	return {
		fs,
		spawner,
		layer: Layer.mergeAll(
			fs.layer,
			spawner.layer,
			Layer.provide(ArtifactStoreLive, fs.layer),
			ModelResolverLive,
		),
	};
}

describe("runSingle — happy path", () => {
	it("folds an assistant message_end into SingleResult + progress", async () => {
		const { fs, spawner, layer } = buildLayer([
			{ events: [ASSISTANT_REPLY, EXIT_OK] },
		]);

		const result = await Effect.runPromise(
			Effect.provide(
				runSingle(
					{ agent: STUB_AGENT, task: "find configs", runId: "run-42" },
					{ writeMetadata: true },
				),
				layer,
			),
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "scout");
		assert.equal(result.task, "find configs");
		assert.equal(result.finalOutput, "hello world");
		assert.equal(result.usage.input, 100);
		assert.equal(result.usage.output, 50);
		assert.equal(result.usage.turns, 1);
		// When agent.model is unset, the assistant message's model flows
		// into result.model at message_end (matches legacy behavior).
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.equal(result.progress?.status, "completed");

		// Spawn was called exactly once with --mode json -p + Task: ... args.
		assert.equal(spawner.controls.spawnCount(), 1);
		const spec = spawner.controls.lastSpec();
		assert.ok(spec?.args.includes("--mode"));
		assert.ok(spec?.args.includes("-p"));
		assert.ok(spec?.args.some((a) => a === "Task: find configs"));

		// Artifacts were written
		const filesWritten = fs.controls.listFiles();
		const hasInput = filesWritten.some((p) => p.endsWith("_input.md"));
		const hasOutput = filesWritten.some((p) => p.endsWith("_output.md"));
		const hasMetadata = filesWritten.some((p) => p.endsWith("_meta.json"));
		assert.ok(hasInput, "input artifact should be written");
		assert.ok(hasOutput, "output artifact should be written");
		assert.ok(hasMetadata, "metadata.json artifact should be written");
	});

	it("writes system prompt + task body to tempDir when systemPrompt is present", async () => {
		const longSystem = "You are a very long system prompt.";
		const { fs, layer } = buildLayer([{ events: [ASSISTANT_REPLY, EXIT_OK] }]);

		await Effect.runPromise(
			Effect.provide(
				runSingle(
					{
						agent: { ...STUB_AGENT, systemPrompt: longSystem },
						task: "x",
						runId: "r",
					},
					// Keep the tempDir so the test can assert the prompt file
					// landed at the right path. Default behavior (cleanup)
					// is the production contract.
					{ cleanupTempDir: false },
				),
				layer,
			),
		);
		// A tempDir was created and a prompt file written into it.
		const files = fs.controls.listFiles();
		const promptFile = files.find((p) => p.endsWith("/scout.md"));
		assert.ok(promptFile, "prompt file should be written");
		assert.equal(fs.controls.getFile(promptFile!), longSystem);
	});
});

describe("runSingle — events drive progress", () => {
	it("tool_execution_start + end populates recentTools and toolCount", async () => {
		const toolStart: PiEvent = {
			type: "stdout",
			line: JSON.stringify({
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "ls -la" },
			}),
		};
		const toolEnd: PiEvent = {
			type: "stdout",
			line: JSON.stringify({ type: "tool_execution_end" }),
		};
		const { layer } = buildLayer([
			{ events: [toolStart, toolEnd, ASSISTANT_REPLY, EXIT_OK] },
		]);

		const result = await Effect.runPromise(
			Effect.provide(
				runSingle({ agent: STUB_AGENT, task: "run", runId: "r" }, {}),
				layer,
			),
		);
		assert.equal(result.progress?.toolCount, 1);
		assert.equal(result.progress?.recentTools.length, 1);
		assert.equal(result.progress?.recentTools[0]?.tool, "bash");
		assert.equal(result.progress?.recentTools[0]?.args, "ls -la");
	});
});

describe("runSingle — failure surface", () => {
	it("non-zero exit + stderr populates result.error", async () => {
		const stderr: PiEvent = { type: "stderr", data: "pi: unknown model\n" };
		const { layer } = buildLayer([{ events: [stderr, EXIT_FAIL] }]);

		const result = await Effect.runPromise(
			Effect.provide(
				runSingle({ agent: STUB_AGENT, task: "x", runId: "r" }, {}),
				layer,
			),
		);
		assert.equal(result.exitCode, 2);
		assert.equal(result.error, "pi: unknown model");
		assert.equal(result.progress?.status, "failed");
	});

	it("ignores non-JSON stdout lines without failing", async () => {
		const noise: PiEvent = { type: "stdout", line: "this is not JSON" };
		const { layer } = buildLayer([{ events: [noise, ASSISTANT_REPLY, EXIT_OK] }]);

		const result = await Effect.runPromise(
			Effect.provide(
				runSingle({ agent: STUB_AGENT, task: "x", runId: "r" }, {}),
				layer,
			),
		);
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "hello world");
	});
});

describe("runSingle — model resolution + onUpdate", () => {
	it("resolves a bare model id to provider/id when registry has one match", async () => {
		const { spawner, layer } = buildLayer([{ events: [ASSISTANT_REPLY, EXIT_OK] }]);
		await Effect.runPromise(
			Effect.provide(
				runSingle(
					{
						agent: { ...STUB_AGENT, model: "gpt-5-mini" },
						task: "x",
						runId: "r",
					},
					{
						availableModels: [
							{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
						],
					},
				),
				layer,
			),
		);
		const spec = spawner.controls.lastSpec();
		const modelIdx = spec?.args.indexOf("--model") ?? -1;
		assert.ok(modelIdx >= 0);
		assert.equal(spec?.args[modelIdx + 1], "openai/gpt-5-mini");
	});

	it("invokes onUpdate at least once during the run", async () => {
		const { layer } = buildLayer([
			{
				events: [
					{ type: "stdout", line: JSON.stringify({ type: "tool_execution_start", toolName: "ls" }) },
					{ type: "stdout", line: JSON.stringify({ type: "tool_execution_end" }) },
					ASSISTANT_REPLY,
					EXIT_OK,
				],
			},
		]);
		let updateCount = 0;
		await Effect.runPromise(
			Effect.provide(
				runSingle(
					{ agent: STUB_AGENT, task: "x", runId: "r" },
					{ onUpdate: () => { updateCount++; } },
				),
				layer,
			),
		);
		// At least tool_start, tool_end, message_end -> 3 updates.
		assert.ok(updateCount >= 3, `expected >=3 onUpdate calls, got ${updateCount}`);
	});
});

describe("runSingle — artifacts", () => {
	it("writes JSONL when writeJsonl is set", async () => {
		const { fs, layer } = buildLayer([{ events: [ASSISTANT_REPLY, EXIT_OK] }]);
		await Effect.runPromise(
			Effect.provide(
				runSingle(
					{ agent: STUB_AGENT, task: "x", runId: "r" },
					{ writeJsonl: true },
				),
				layer,
			),
		);
		const jsonlFile = fs.controls.listFiles().find((p) => p.endsWith(".jsonl"));
		assert.ok(jsonlFile);
		const content = fs.controls.getFile(jsonlFile!) ?? "";
		const lines = content.split("\n").filter((l) => l.length > 0);
		assert.equal(lines.length, 1);
		// The single line is the assistant reply JSON.
		assert.match(lines[0]!, /"message_end"/);
	});
});
