/**
 * Tests for src/domain/fork-context.ts — mirrors test/unit/fork-context.test.ts
 * against the ported module, plus the new `wrapForkTask` helper that
 * lives here in the new tree (it lived in types.ts under the legacy
 * layout).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import {
	createForkContextResolver,
	createForkContextResolverEffect,
	resolveSubagentContext,
	wrapForkTask,
} from "../../src/domain/fork-context.ts";
import { DEFAULT_FORK_PREAMBLE } from "../../src/domain/constants.ts";

describe("resolveSubagentContext", () => {
	it("defaults to fresh", () => {
		assert.equal(resolveSubagentContext(undefined), "fresh");
		assert.equal(resolveSubagentContext("anything"), "fresh");
	});

	it("accepts fork", () => {
		assert.equal(resolveSubagentContext("fork"), "fork");
	});
});

describe("createForkContextResolver", () => {
	it("fresh mode never calls createBranchedSession", () => {
		let calls = 0;
		const resolver = createForkContextResolver(
			{
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => "leaf-123",
				createBranchedSession: () => {
					calls++;
					return "/tmp/child.jsonl";
				},
			},
			"fresh",
		);

		assert.equal(resolver.sessionFileForIndex(0), undefined);
		assert.equal(calls, 0);
	});

	it("fails fast when parent session file is missing", () => {
		assert.throws(
			() =>
				createForkContextResolver(
					{
						getSessionFile: () => undefined,
						getLeafId: () => "leaf-123",
						createBranchedSession: () => "/tmp/child.jsonl",
					},
					"fork",
				),
			/Forked subagent context requires a persisted parent session\./,
		);
	});

	it("fails fast when leaf id is missing", () => {
		assert.throws(
			() =>
				createForkContextResolver(
					{
						getSessionFile: () => "/tmp/parent.jsonl",
						getLeafId: () => null,
						createBranchedSession: () => "/tmp/child.jsonl",
					},
					"fork",
				),
			/Forked subagent context requires a current leaf to fork from\./,
		);
	});

	it("memoizes per index", () => {
		let count = 0;
		const resolver = createForkContextResolver(
			{
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => "leaf-abc",
				createBranchedSession: () => {
					count++;
					return `/tmp/fork-${count}.jsonl`;
				},
			},
			"fork",
		);

		const first = resolver.sessionFileForIndex(7);
		const second = resolver.sessionFileForIndex(7);
		assert.equal(first, second);
		assert.equal(count, 1);
	});

	it("does not silently fallback when branch creation returns undefined", () => {
		const resolver = createForkContextResolver(
			{
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => "leaf-abc",
				createBranchedSession: () => undefined,
			},
			"fork",
		);
		assert.throws(
			() => resolver.sessionFileForIndex(0),
			/Failed to create forked subagent session: Session manager did not return a session file\./,
		);
	});
});

describe("createForkContextResolverEffect", () => {
	it("succeeds with a no-op resolver in fresh mode", async () => {
		const exit = await Effect.runPromiseExit(
			createForkContextResolverEffect(
				{
					getSessionFile: () => "/tmp/parent.jsonl",
					getLeafId: () => "leaf-1",
					createBranchedSession: () => "/tmp/child.jsonl",
				},
				"fresh",
			),
		);
		assert.equal(Exit.isSuccess(exit), true);
		if (Exit.isSuccess(exit)) {
			assert.equal(exit.value.sessionFileForIndex(0), undefined);
		}
	});

	it("fails when parent session is missing", async () => {
		const exit = await Effect.runPromiseExit(
			createForkContextResolverEffect(
				{
					getSessionFile: () => undefined,
					getLeafId: () => "leaf-1",
					createBranchedSession: () => "/tmp/child.jsonl",
				},
				"fork",
			),
		);
		assert.equal(Exit.isFailure(exit), true);
		if (Exit.isFailure(exit)) {
			const errOpt = Cause.findErrorOption(exit.cause);
			assert.equal(Option.isSome(errOpt), true);
			if (Option.isSome(errOpt)) {
				assert.match(
					errOpt.value.message,
					/Forked subagent context requires a persisted parent session\./,
				);
			}
		}
	});
});

describe("wrapForkTask", () => {
	it("wraps task with default preamble", () => {
		const wrapped = wrapForkTask("analyze diff");
		assert.match(
			wrapped,
			new RegExp(`^${DEFAULT_FORK_PREAMBLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		);
		assert.match(wrapped, /\n\nTask:\nanalyze diff$/);
	});

	it("returns task unchanged when disabled", () => {
		const task = "analyze diff";
		assert.equal(wrapForkTask(task, false), task);
	});

	it("is idempotent for already wrapped tasks", () => {
		const once = wrapForkTask("analyze diff");
		const twice = wrapForkTask(once);
		assert.equal(twice, once);
	});

	it("accepts a custom preamble", () => {
		const wrapped = wrapForkTask("analyze diff", "Custom preamble");
		assert.equal(wrapped, "Custom preamble\n\nTask:\nanalyze diff");
	});
});
