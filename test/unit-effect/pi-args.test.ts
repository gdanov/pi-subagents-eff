/**
 * Tests for src/executor/pi-args.ts.
 *
 * Mirrors behavior of test/unit/pi-args.test.ts against the new pure
 * version. The legacy helper did fs.mkdir / mkdtemp / writeFile inline;
 * the new version returns a declarative fileWrites / dirsToCreate plan
 * and leaves I/O to the executor.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyThinkingSuffix,
	buildPiArgs,
	piArgsNeedTempDir,
} from "../../src/executor/pi-args.ts";

describe("applyThinkingSuffix", () => {
	it("appends thinking when model has no existing suffix", () => {
		assert.equal(applyThinkingSuffix("claude-sonnet-4", "high"), "claude-sonnet-4:high");
	});

	it("leaves model alone when suffix already matches a known level", () => {
		assert.equal(applyThinkingSuffix("claude-sonnet-4:medium", "high"), "claude-sonnet-4:medium");
	});

	it("treats 'off' as a no-op", () => {
		assert.equal(applyThinkingSuffix("claude-sonnet-4", "off"), "claude-sonnet-4");
	});

	it("returns undefined when model is undefined", () => {
		assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
	});
});

describe("piArgsNeedTempDir", () => {
	it("false when no system prompt and short task", () => {
		assert.equal(
			piArgsNeedTempDir({ baseArgs: [], task: "short", sessionEnabled: true }),
			false,
		);
	});

	it("true when system prompt is present", () => {
		assert.equal(
			piArgsNeedTempDir({
				baseArgs: [],
				task: "short",
				sessionEnabled: true,
				systemPrompt: "hi",
			}),
			true,
		);
	});

	it("true when task exceeds the 8000-char limit", () => {
		assert.equal(
			piArgsNeedTempDir({
				baseArgs: [],
				task: "x".repeat(9000),
				sessionEnabled: true,
			}),
			true,
		);
	});
});

describe("buildPiArgs", () => {
	it("emits --no-session when session disabled and no sessionDir given", () => {
		const result = buildPiArgs(
			{ baseArgs: [], task: "hello", sessionEnabled: false },
			"",
		);
		assert.ok(result.args.includes("--no-session"));
		assert.deepEqual([...result.dirsToCreate], []);
		assert.deepEqual([...result.fileWrites], []);
		assert.equal(result.needsTempDir, false);
		// Short task goes inline as positional arg
		assert.ok(result.args.some((a) => a === "Task: hello"));
	});

	it("adds --session when sessionFile is given (takes priority over sessionDir)", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				sessionFile: "/sessions/abc.jsonl",
				sessionDir: "/ignored",
			},
			"",
		);
		const sessionIdx = result.args.indexOf("--session");
		assert.ok(sessionIdx >= 0);
		assert.equal(result.args[sessionIdx + 1], "/sessions/abc.jsonl");
		assert.ok(!result.args.includes("--session-dir"));
		assert.deepEqual([...result.dirsToCreate], []);
	});

	it("declares the sessionDir as a dir to create", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				sessionDir: "/sessions",
			},
			"",
		);
		assert.deepEqual([...result.dirsToCreate], ["/sessions"]);
		const idx = result.args.indexOf("--session-dir");
		assert.ok(idx >= 0);
		assert.equal(result.args[idx + 1], "/sessions");
	});

	it("appends --model with thinking suffix", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				model: "anthropic/claude-sonnet-4",
				thinking: "high",
			},
			"",
		);
		const idx = result.args.indexOf("--model");
		assert.equal(result.args[idx + 1], "anthropic/claude-sonnet-4:high");
	});

	it("partitions tools into --tools builtin list and extension paths", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				tools: ["read", "bash", "/path/to/ext.ts", "other/slashed"],
			},
			"",
		);
		const toolsIdx = result.args.indexOf("--tools");
		assert.equal(result.args[toolsIdx + 1], "read,bash");
		// Extension paths become --extension entries
		const extInvocations = result.args
			.map((a, i) => (a === "--extension" ? result.args[i + 1] : undefined))
			.filter((v): v is string => v !== undefined);
		assert.deepEqual(extInvocations, ["/path/to/ext.ts", "other/slashed"]);
	});

	it("extensions field takes precedence over tool-embedded extension paths", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				tools: ["/should/be/ignored.ts"],
				extensions: ["/chosen.ts"],
			},
			"",
		);
		assert.ok(result.args.includes("--no-extensions"));
		const extPaths = result.args
			.map((a, i) => (a === "--extension" ? result.args[i + 1] : undefined))
			.filter((v): v is string => v !== undefined);
		assert.deepEqual(extPaths, ["/chosen.ts"]);
	});

	it("emits --no-skills when any skills are requested", () => {
		const result = buildPiArgs(
			{ baseArgs: [], task: "x", sessionEnabled: true, skills: ["safe-bash"] },
			"",
		);
		assert.ok(result.args.includes("--no-skills"));
	});

	it("writes a systemPrompt file into tempDir and appends --append-system-prompt", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				systemPrompt: "You are X.",
				promptFileStem: "scout",
			},
			"/tmp/pi-subagent-abc",
		);
		assert.equal(result.needsTempDir, true);
		assert.equal(result.fileWrites.length, 1);
		assert.equal(result.fileWrites[0]?.relativePath, "scout.md");
		assert.equal(result.fileWrites[0]?.contents, "You are X.");
		assert.equal(result.fileWrites[0]?.mode, 0o600);
		const idx = result.args.indexOf("--append-system-prompt");
		assert.equal(result.args[idx + 1], "/tmp/pi-subagent-abc/scout.md");
	});

	it("writes an over-limit task body to task.md and uses @file syntax", () => {
		const bigTask = "x".repeat(9000);
		const result = buildPiArgs(
			{ baseArgs: [], task: bigTask, sessionEnabled: true },
			"/tmp/pi-subagent-xyz",
		);
		assert.equal(result.needsTempDir, true);
		const taskWrite = result.fileWrites.find((w) => w.relativePath === "task.md");
		assert.ok(taskWrite);
		assert.equal(taskWrite?.contents, `Task: ${bigTask}`);
		// Args reference the @<tempDir>/task.md form
		assert.ok(result.args.some((a) => a === "@/tmp/pi-subagent-xyz/task.md"));
		// Short positional "Task: ..." must NOT be present when using the @file form
		assert.ok(!result.args.some((a) => a.startsWith("Task: ") && !a.startsWith("Task: x".repeat(10))));
	});

	it("sanitizes promptFileStem (e.g. spaces become underscores)", () => {
		const result = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				systemPrompt: "hi",
				promptFileStem: "weird/agent name!",
			},
			"/tmp/x",
		);
		assert.equal(result.fileWrites[0]?.relativePath, "weird_agent_name_.md");
	});

	it("sets MCP_DIRECT_TOOLS env when mcpDirectTools provided, __none__ otherwise", () => {
		const with1 = buildPiArgs(
			{
				baseArgs: [],
				task: "x",
				sessionEnabled: true,
				mcpDirectTools: ["github/search", "chrome-devtools"],
			},
			"",
		);
		assert.equal(with1.env.MCP_DIRECT_TOOLS, "github/search,chrome-devtools");
		const without = buildPiArgs(
			{ baseArgs: [], task: "x", sessionEnabled: true },
			"",
		);
		assert.equal(without.env.MCP_DIRECT_TOOLS, "__none__");
	});
});
