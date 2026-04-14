/**
 * Tests for src/executor/chain-settings.ts — pure helpers only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildChainInstructions,
	getStepAgents,
	isParallelStep,
	normalizeSkillInput,
	resolveChainTemplates,
	resolveParallelBehaviors,
	resolveStepBehavior,
	substituteChainTemplate,
	type MinimalAgentConfig,
} from "../../src/executor/chain-settings.ts";

describe("normalizeSkillInput", () => {
	it("returns undefined for true/undefined", () => {
		assert.equal(normalizeSkillInput(undefined), undefined);
		assert.equal(normalizeSkillInput(true), undefined);
	});

	it("returns false for false", () => {
		assert.equal(normalizeSkillInput(false), false);
	});

	it("deduplicates array input", () => {
		assert.deepEqual([...(normalizeSkillInput(["a", "b", "a", ""]) as readonly string[])], [
			"a",
			"b",
		]);
	});

	it("parses JSON-encoded array strings", () => {
		assert.deepEqual(
			[...(normalizeSkillInput('["x","y"]') as readonly string[])],
			["x", "y"],
		);
	});

	it("splits comma-separated strings", () => {
		assert.deepEqual(
			[...(normalizeSkillInput("a, b , c") as readonly string[])],
			["a", "b", "c"],
		);
	});
});

describe("isParallelStep / getStepAgents", () => {
	it("discriminates by presence of `parallel` array", () => {
		assert.equal(isParallelStep({ agent: "x", task: "t" }), false);
		assert.equal(isParallelStep({ parallel: [] }), true);
		assert.equal(isParallelStep({ parallel: [{ agent: "a" }, { agent: "b" }] }), true);
	});

	it("getStepAgents flattens both shapes", () => {
		assert.deepEqual([...getStepAgents({ agent: "x" })], ["x"]);
		assert.deepEqual(
			[...getStepAgents({ parallel: [{ agent: "a" }, { agent: "b" }] })],
			["a", "b"],
		);
	});
});

describe("resolveChainTemplates", () => {
	it("first step defaults to {task}, later steps default to {previous}", () => {
		const tpls = resolveChainTemplates([
			{ agent: "a" },
			{ agent: "b" },
			{ agent: "c" },
		]);
		assert.equal(tpls[0], "{task}");
		assert.equal(tpls[1], "{previous}");
		assert.equal(tpls[2], "{previous}");
	});

	it("uses explicit task when provided", () => {
		const tpls = resolveChainTemplates([{ agent: "a", task: "explicit" }]);
		assert.equal(tpls[0], "explicit");
	});

	it("parallel step templates default per-task to {previous}", () => {
		const tpls = resolveChainTemplates([
			{ parallel: [{ agent: "x" }, { agent: "y", task: "Y" }] },
		]);
		assert.deepEqual([...(tpls[0] as readonly string[])], ["{previous}", "Y"]);
	});
});

describe("substituteChainTemplate", () => {
	it("replaces all three tokens", () => {
		const out = substituteChainTemplate(
			"Do {task}, using {previous}, write to {chain_dir}/notes.md",
			{ task: "find bugs", previous: "prior work", chainDir: "/tmp/chain" },
		);
		assert.equal(out, "Do find bugs, using prior work, write to /tmp/chain/notes.md");
	});

	it("replaces repeated tokens", () => {
		const out = substituteChainTemplate("{task} and {task}", {
			task: "A",
			previous: "",
			chainDir: "",
		});
		assert.equal(out, "A and A");
	});
});

describe("resolveStepBehavior", () => {
	const scout: MinimalAgentConfig = {
		name: "scout",
		output: "context.md",
		defaultReads: ["shared.md"],
		defaultProgress: true,
		skills: ["skill-a"],
		model: "anthropic/claude-sonnet-4",
	};

	it("step override wins over agent default", () => {
		const beh = resolveStepBehavior(scout, {
			output: "custom.md",
			reads: ["over.md"],
			progress: false,
		});
		assert.equal(beh.output, "custom.md");
		assert.deepEqual([...(beh.reads as readonly string[])], ["over.md"]);
		assert.equal(beh.progress, false);
	});

	it("agent default flows through when no override", () => {
		const beh = resolveStepBehavior(scout, {});
		assert.equal(beh.output, "context.md");
		assert.deepEqual([...(beh.reads as readonly string[])], ["shared.md"]);
		assert.equal(beh.progress, true);
	});

	it("skills=false disables regardless of chainSkills", () => {
		const beh = resolveStepBehavior(scout, { skills: false }, ["extra"]);
		assert.equal(beh.skills, false);
	});

	it("chainSkills union with agent default", () => {
		const beh = resolveStepBehavior(scout, {}, ["chain-wide"]);
		assert.deepEqual([...(beh.skills as readonly string[])], ["skill-a", "chain-wide"]);
	});

	it("step skills override + chainSkills union", () => {
		const beh = resolveStepBehavior(scout, { skills: ["over"] }, ["chain-wide"]);
		assert.deepEqual([...(beh.skills as readonly string[])], ["over", "chain-wide"]);
	});
});

describe("resolveParallelBehaviors", () => {
	const agents: MinimalAgentConfig[] = [
		{ name: "worker", output: "out.md" },
		{ name: "other", defaultProgress: true },
	];

	it("namespaces relative output paths under parallel-{stepIndex}/{taskIndex}-{agent}/", () => {
		const behs = resolveParallelBehaviors(
			[{ agent: "worker" }, { agent: "other", output: "review.md" }],
			agents,
			2,
		);
		assert.equal(behs[0]?.output, "parallel-2/0-worker/out.md");
		assert.equal(behs[1]?.output, "parallel-2/1-other/review.md");
	});

	it("absolute output paths pass through unchanged", () => {
		const behs = resolveParallelBehaviors(
			[{ agent: "worker", output: "/abs/out.md" }],
			agents,
			0,
		);
		assert.equal(behs[0]?.output, "/abs/out.md");
	});

	it("throws on unknown agent", () => {
		assert.throws(
			() => resolveParallelBehaviors([{ agent: "ghost" }], agents, 0),
			/Unknown agent: ghost/,
		);
	});
});

describe("buildChainInstructions", () => {
	it("includes reads and output in the prefix", () => {
		const beh = resolveStepBehavior(
			{ name: "x" },
			{ reads: ["a.md", "b.md"], output: "out.md" },
		);
		const { prefix } = buildChainInstructions(beh, "/chain", false);
		assert.match(prefix, /\[Read from: \/chain\/a\.md, \/chain\/b\.md\]/);
		assert.match(prefix, /\[Write to: \/chain\/out\.md\]/);
	});

	it("progress suffix uses Create vs Update wording", () => {
		const beh = resolveStepBehavior({ name: "x" }, { progress: true });
		const first = buildChainInstructions(beh, "/chain", true);
		const later = buildChainInstructions(beh, "/chain", false);
		assert.match(first.suffix, /Create and maintain progress/);
		assert.match(later.suffix, /Update progress/);
	});

	it("includes previous summary in suffix when provided", () => {
		const beh = resolveStepBehavior({ name: "x" }, {});
		const { suffix } = buildChainInstructions(beh, "/chain", false, "prior text");
		assert.match(suffix, /Previous step output:\nprior text/);
	});

	it("absolute read paths pass through without chainDir prefix", () => {
		const beh = resolveStepBehavior({ name: "x" }, { reads: ["/abs/file.md"] });
		const { prefix } = buildChainInstructions(beh, "/chain", false);
		assert.match(prefix, /\[Read from: \/abs\/file\.md\]/);
	});
});
