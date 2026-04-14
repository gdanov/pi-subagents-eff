/**
 * Tests for src/executor/agent-serializer.ts.
 *
 * Round-trip with parseAgentFile (from AgentDirectory).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	KNOWN_FIELDS,
	sanitizeName,
	serializeAgent,
} from "../../src/executor/agent-serializer.ts";
import { parseAgentFile, type AgentConfig } from "../../src/services/AgentDirectory.ts";

describe("sanitizeName", () => {
	it("kebab-cases mixed-case input with spaces", () => {
		assert.equal(sanitizeName("My Cool Agent"), "my-cool-agent");
	});

	it("strips non-alphanumeric except hyphens", () => {
		assert.equal(sanitizeName("foo!@#bar.baz"), "foobarbaz");
	});

	it("collapses repeated hyphens and trims edges", () => {
		assert.equal(sanitizeName("---a--b--c---"), "a-b-c");
	});
});

describe("KNOWN_FIELDS", () => {
	it("includes the full legacy set", () => {
		for (const key of [
			"name",
			"description",
			"tools",
			"model",
			"fallbackModels",
			"thinking",
			"skill",
			"skills",
			"extensions",
			"output",
			"defaultReads",
			"defaultProgress",
			"interactive",
			"maxSubagentDepth",
		]) {
			assert.ok(KNOWN_FIELDS.has(key), `missing key ${key}`);
		}
	});
});

describe("serializeAgent → parseAgentFile round-trip", () => {
	it("preserves structure for a richly-populated agent", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Find things",
			source: "user",
			filePath: "/u/scout.md",
			systemPrompt: "You are scout.",
			model: "anthropic/claude-sonnet-4",
			fallbackModels: ["openai/gpt-5-mini"],
			thinking: "high",
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
			skills: ["safe-bash"],
			extensions: ["/abs/x.ts"],
			output: "context.md",
			defaultReads: ["shared.md"],
			defaultProgress: true,
			interactive: true,
			maxSubagentDepth: 1,
		};
		const md = serializeAgent(agent);
		const re = parseAgentFile({ content: md, filePath: agent.filePath, source: agent.source });
		assert.ok(re);
		assert.equal(re?.name, agent.name);
		assert.equal(re?.description, agent.description);
		assert.equal(re?.model, agent.model);
		assert.deepEqual([...(re?.fallbackModels ?? [])], [...(agent.fallbackModels ?? [])]);
		assert.equal(re?.thinking, agent.thinking);
		assert.deepEqual([...(re?.tools ?? [])], [...(agent.tools ?? [])]);
		assert.deepEqual([...(re?.mcpDirectTools ?? [])], [...(agent.mcpDirectTools ?? [])]);
		assert.deepEqual([...(re?.skills ?? [])], [...(agent.skills ?? [])]);
		assert.deepEqual([...(re?.extensions ?? [])], [...(agent.extensions ?? [])]);
		assert.equal(re?.output, agent.output);
		assert.deepEqual([...(re?.defaultReads ?? [])], [...(agent.defaultReads ?? [])]);
		assert.equal(re?.defaultProgress, agent.defaultProgress);
		assert.equal(re?.interactive, agent.interactive);
		assert.equal(re?.maxSubagentDepth, agent.maxSubagentDepth);
		assert.equal(re?.systemPrompt, agent.systemPrompt);
	});

	it("emits empty `extensions:` for explicit empty list", () => {
		const md = serializeAgent({
			name: "x",
			description: "d",
			source: "user",
			filePath: "/x.md",
			systemPrompt: "p",
			extensions: [],
		});
		assert.match(md, /^extensions:\s*$/m);
	});

	it("omits thinking when set to 'off'", () => {
		const md = serializeAgent({
			name: "x",
			description: "d",
			source: "user",
			filePath: "/x.md",
			systemPrompt: "p",
			thinking: "off",
		});
		assert.ok(!md.includes("thinking:"));
	});
});
