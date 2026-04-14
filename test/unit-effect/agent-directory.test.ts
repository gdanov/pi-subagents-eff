/**
 * Tests for src/services/AgentDirectory.ts.
 *
 * Frontmatter parsing is exercised directly (pure helper). Discovery
 * is exercised via the InMemory FileSystem layer.
 *
 * Phase 3 scope: discovery + frontmatter parsing only. Builtin
 * overrides, scope merging, and CRUD land in Phase 8 with their own
 * tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import {
	AgentDirectory,
	AgentDirectoryLive,
	parseAgentFile,
	parseFrontmatter,
} from "../../src/services/AgentDirectory.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";

describe("parseFrontmatter", () => {
	it("returns empty frontmatter when no leading ---", () => {
		const { frontmatter, body } = parseFrontmatter("# heading\nbody");
		assert.deepEqual(frontmatter, {});
		assert.equal(body, "# heading\nbody");
	});

	it("parses simple key:value pairs and unquotes string values", () => {
		const { frontmatter, body } = parseFrontmatter(
			'---\nname: scout\ndescription: "Find things"\n---\nThe body.',
		);
		assert.equal(frontmatter.name, "scout");
		assert.equal(frontmatter.description, "Find things");
		assert.equal(body, "The body.");
	});

	it("normalizes CRLF to LF", () => {
		const { frontmatter, body } = parseFrontmatter("---\r\nname: x\r\n---\r\nbody");
		assert.equal(frontmatter.name, "x");
		assert.equal(body, "body");
	});

	it("returns empty frontmatter when closing --- is missing", () => {
		const { frontmatter, body } = parseFrontmatter("---\nname: x\nno closing");
		assert.deepEqual(frontmatter, {});
		assert.match(body, /no closing/);
	});
});

describe("parseAgentFile", () => {
	it("returns undefined when name or description is missing", () => {
		assert.equal(
			parseAgentFile({ content: "---\nname: only\n---\nbody", filePath: "/a.md", source: "user" }),
			undefined,
		);
	});

	it("partitions tools into builtin + mcp:", () => {
		const result = parseAgentFile({
			content:
				"---\nname: scout\ndescription: d\ntools: read, bash, mcp:chrome-devtools, mcp:github/search\n---\nsystem prompt",
			filePath: "/a.md",
			source: "user",
		});
		assert.ok(result);
		assert.deepEqual([...(result?.tools ?? [])], ["read", "bash"]);
		assert.deepEqual([...(result?.mcpDirectTools ?? [])], ["chrome-devtools", "github/search"]);
	});

	it("parses fallbackModels CSV + thinking + skills + extensions", () => {
		const result = parseAgentFile({
			content:
				"---\nname: x\ndescription: d\nmodel: anthropic/claude-sonnet-4\nfallbackModels: openai/gpt-5-mini, gpt-5-mini\nthinking: high\nskill: safe-bash\nextensions: /a.ts, /b.ts\n---\nbody",
			filePath: "/a.md",
			source: "user",
		});
		assert.ok(result);
		assert.equal(result?.model, "anthropic/claude-sonnet-4");
		assert.deepEqual([...(result?.fallbackModels ?? [])], ["openai/gpt-5-mini", "gpt-5-mini"]);
		assert.equal(result?.thinking, "high");
		assert.deepEqual([...(result?.skills ?? [])], ["safe-bash"]);
		assert.deepEqual([...(result?.extensions ?? [])], ["/a.ts", "/b.ts"]);
	});

	it("treats `extensions:` (empty) as an explicit empty list", () => {
		const result = parseAgentFile({
			content: "---\nname: x\ndescription: d\nextensions:\n---\nbody",
			filePath: "/a.md",
			source: "user",
		});
		assert.deepEqual([...(result?.extensions ?? [null])], []);
	});

	it("rejects negative or non-integer maxSubagentDepth", () => {
		const result = parseAgentFile({
			content: "---\nname: x\ndescription: d\nmaxSubagentDepth: -1\n---\nbody",
			filePath: "/a.md",
			source: "user",
		});
		assert.equal(result?.maxSubagentDepth, undefined);
	});

	it("preserves systemPrompt body verbatim", () => {
		const result = parseAgentFile({
			content: "---\nname: x\ndescription: d\n---\nLine 1\nLine 2",
			filePath: "/a.md",
			source: "builtin",
		});
		assert.equal(result?.systemPrompt, "Line 1\nLine 2");
	});
});

describe("AgentDirectory.discover (cross-scope)", () => {
	const PROJECT = "/work/proj";
	const PROJECT_AGENTS = "/work/proj/.pi/agents";

	it("scope=user reads from both legacy and new user dirs, ignoring project", async () => {
		const fs = makeFileSystemTest({
			// Legacy user dir
			[`${process.env.HOME ?? ""}/.pi/agent/agents/old.md`]:
				"---\nname: old\ndescription: legacy user\n---\nbody",
			// New user dir
			[`${process.env.HOME ?? ""}/.agents/fresh.md`]:
				"---\nname: fresh\ndescription: new user\n---\nbody",
			// Project dir (must be ignored at scope=user)
			[`${PROJECT_AGENTS}/proj.md`]: "---\nname: proj\ndescription: project\n---\nbody",
		});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discover(PROJECT, "user");
				}),
				layer,
			),
		);
		const names = agents.map((a) => a.name).sort();
		assert.deepEqual(names, ["fresh", "old"]);
	});

	it("scope=project reads only the project agents dir", async () => {
		const fs = makeFileSystemTest({
			[`${process.env.HOME ?? ""}/.agents/u.md`]:
				"---\nname: u\ndescription: user\n---\nbody",
			[`${PROJECT_AGENTS}/p.md`]: "---\nname: p\ndescription: project\n---\nbody",
		});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discover(PROJECT, "project");
				}),
				layer,
			),
		);
		assert.deepEqual(agents.map((a) => a.name), ["p"]);
	});

	it("scope=both returns user agents AND the discovered project agents", async () => {
		const fs = makeFileSystemTest({
			[`${process.env.HOME ?? ""}/.agents/u.md`]:
				"---\nname: u\ndescription: user\n---\nbody",
			[`${PROJECT_AGENTS}/p.md`]: "---\nname: p\ndescription: project\n---\nbody",
		});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discover(PROJECT, "both");
				}),
				layer,
			),
		);
		assert.deepEqual(agents.map((a) => a.name).sort(), ["p", "u"]);
		// Note: the legacy code applies a precedence merge (project wins
		// on name collisions); that lives in agent-selection.ts and is
		// scheduled for Phase 8 with the management surface.
	});

	it("scope=project with no project root returns []", async () => {
		// /tmp/random has no .pi or .agents up the tree.
		const fs = makeFileSystemTest({});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discover("/tmp/no-project-here", "project");
				}),
				layer,
			),
		);
		assert.deepEqual([...agents], []);
	});
});

describe("AgentDirectory.discoverIn", () => {
	it("loads .md files from a single directory and skips .chain.md", async () => {
		const fs = makeFileSystemTest({
			"/agents/scout.md": "---\nname: scout\ndescription: find things\n---\nprompt 1",
			"/agents/planner.md": "---\nname: planner\ndescription: plan\n---\nprompt 2",
			"/agents/legacy.chain.md": "---\nname: legacy\ndescription: chain file\n---\nignored",
			"/agents/invalid.md": "---\nname: only\n---\nmissing description",
		});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discoverIn("/agents", "user");
				}),
				layer,
			),
		);
		const names = agents.map((a) => a.name).sort();
		assert.deepEqual(names, ["planner", "scout"]);
	});

	it("returns empty for a missing directory", async () => {
		const fs = makeFileSystemTest({});
		const layer = Layer.provide(AgentDirectoryLive, fs.layer);
		const agents = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const dir = yield* AgentDirectory;
					return yield* dir.discoverIn("/missing", "builtin");
				}),
				layer,
			),
		);
		assert.deepEqual([...agents], []);
	});
});
