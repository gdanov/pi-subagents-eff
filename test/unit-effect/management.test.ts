/**
 * Tests for src/executor/management.ts dispatcher.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import {
	AgentDirectoryLive,
	parseAgentFile,
} from "../../src/services/AgentDirectory.ts";
import { makeFileSystemTest } from "../../src/services/FileSystem.ts";
import {
	handleManagementAction,
	type ManagementParams,
} from "../../src/executor/management.ts";
import { parseChain } from "../../src/executor/chain-serializer.ts";

const PROJECT_AGENTS = "/work/proj/.pi/agents";

function build(initialFs?: Record<string, string>) {
	const fs = makeFileSystemTest(initialFs);
	return {
		fs,
		layer: Layer.provide(AgentDirectoryLive, fs.layer),
	};
}

const PROJECT = "/work/proj";

describe("management.list", () => {
	it("emits 'none' lines when no agents or chains exist", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction({ action: "list" }, { cwd: PROJECT }),
				layer,
			),
		);
		assert.equal(out.isError, undefined);
		assert.match(out.content[0]!.text, /Agents:\n- \(none\)/);
		assert.match(out.content[0]!.text, /Chains:\n- \(none\)/);
	});

	it("lists discovered agents and chains in name order", async () => {
		const { layer } = build({
			[`${PROJECT_AGENTS}/scout.md`]: "---\nname: scout\ndescription: find\n---\nbody",
			[`${PROJECT_AGENTS}/planner.md`]: "---\nname: planner\ndescription: plan\n---\nbody",
			[`${PROJECT_AGENTS}/my-chain.chain.md`]: "---\nname: my-chain\ndescription: chain\n---\n## scout\n\nfind\n",
		});
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction({ action: "list", agentScope: "project" }, { cwd: PROJECT }),
				layer,
			),
		);
		const text = out.content[0]!.text;
		// Sorted: planner before scout.
		assert.ok(text.indexOf("- planner") < text.indexOf("- scout"));
		assert.match(text, /- my-chain/);
	});
});

describe("management.get", () => {
	it("returns an error when neither agent nor chainName is given", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(handleManagementAction({ action: "get" }, { cwd: PROJECT }), layer),
		);
		assert.equal(out.isError, true);
	});

	it("returns the agent detail when found", async () => {
		const { layer } = build({
			[`${PROJECT_AGENTS}/scout.md`]:
				"---\nname: scout\ndescription: find configs\nmodel: anthropic/claude-sonnet-4\n---\nThe prompt body.",
		});
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction({ action: "get", agent: "scout" }, { cwd: PROJECT }),
				layer,
			),
		);
		assert.equal(out.isError, undefined);
		assert.match(out.content[0]!.text, /Agent: scout/);
		assert.match(out.content[0]!.text, /Description: find configs/);
		assert.match(out.content[0]!.text, /Model: anthropic\/claude-sonnet-4/);
	});

	it("returns isError=true when agent not found", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction({ action: "get", agent: "ghost" }, { cwd: PROJECT }),
				layer,
			),
		);
		assert.equal(out.isError, true);
		assert.match(out.content[0]!.text, /not found/);
	});
});

describe("management.create", () => {
	it("writes a new agent .md file with serialized frontmatter + body", async () => {
		const { fs, layer } = build();
		const params: ManagementParams = {
			action: "create",
			config: {
				name: "Newcomer",
				description: "fresh agent",
				scope: "project",
				systemPrompt: "I am newcomer.",
				model: "anthropic/claude-sonnet-4",
				tools: "read, bash",
			},
		};
		const out = await Effect.runPromise(
			Effect.provide(handleManagementAction(params, { cwd: PROJECT }), layer),
		);
		assert.equal(out.isError, undefined);
		assert.match(out.content[0]!.text, /Created agent 'newcomer'/);

		const filePath = fs.controls.listFiles().find((p) => p.endsWith("/newcomer.md"));
		assert.ok(filePath, "agent file should be written");
		const content = fs.controls.getFile(filePath!) ?? "";
		const parsed = parseAgentFile({ content, filePath: filePath!, source: "project" });
		assert.equal(parsed?.name, "newcomer");
		assert.equal(parsed?.description, "fresh agent");
		assert.equal(parsed?.systemPrompt, "I am newcomer.");
		assert.deepEqual([...(parsed?.tools ?? [])], ["read", "bash"]);
	});

	it("writes a chain .chain.md file when config.steps is present", async () => {
		const { fs, layer } = build();
		const params: ManagementParams = {
			action: "create",
			config: {
				name: "MyFlow",
				description: "a flow",
				scope: "project",
				steps: [
					{ agent: "scout", task: "find" },
					{ agent: "reviewer", task: "{previous}" },
				],
			},
		};
		const out = await Effect.runPromise(
			Effect.provide(handleManagementAction(params, { cwd: PROJECT }), layer),
		);
		assert.match(out.content[0]!.text, /Created chain 'myflow'/);
		const filePath = fs.controls.listFiles().find((p) => p.endsWith("/myflow.chain.md"));
		assert.ok(filePath);
		const chain = parseChain(fs.controls.getFile(filePath!) ?? "", "project", filePath!);
		assert.equal(chain.steps.length, 2);
		assert.equal(chain.steps[0]?.agent, "scout");
	});

	it("rejects invalid name", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction(
					{ action: "create", config: { name: "!!!", description: "d" } },
					{ cwd: PROJECT },
				),
				layer,
			),
		);
		assert.equal(out.isError, true);
		assert.match(out.content[0]!.text, /name is invalid/);
	});

	it("rejects missing description", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction(
					{ action: "create", config: { name: "x" } },
					{ cwd: PROJECT },
				),
				layer,
			),
		);
		assert.equal(out.isError, true);
		assert.match(out.content[0]!.text, /description is required/);
	});
});

describe("management.update", () => {
	it("rewrites an existing agent's frontmatter", async () => {
		const { fs, layer } = build({
			[`${PROJECT_AGENTS}/scout.md`]:
				"---\nname: scout\ndescription: original\n---\noriginal body",
		});
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction(
					{
						action: "update",
						agent: "scout",
						config: { description: "updated", systemPrompt: "new body" },
					},
					{ cwd: PROJECT },
				),
				layer,
			),
		);
		assert.equal(out.isError, undefined);
		const updated = fs.controls.getFile(`${PROJECT_AGENTS}/scout.md`) ?? "";
		assert.match(updated, /description: updated/);
		assert.match(updated, /new body/);
	});
});

describe("management.delete", () => {
	it("removes the agent file", async () => {
		const { fs, layer } = build({
			[`${PROJECT_AGENTS}/scout.md`]:
				"---\nname: scout\ndescription: x\n---\nbody",
		});
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction(
					{ action: "delete", agent: "scout" },
					{ cwd: PROJECT },
				),
				layer,
			),
		);
		assert.equal(out.isError, undefined);
		assert.equal(fs.controls.getFile(`${PROJECT_AGENTS}/scout.md`), undefined);
	});

	it("returns error when neither target is given", async () => {
		const { layer } = build();
		const out = await Effect.runPromise(
			Effect.provide(
				handleManagementAction({ action: "delete" }, { cwd: PROJECT }),
				layer,
			),
		);
		assert.equal(out.isError, true);
	});
});
