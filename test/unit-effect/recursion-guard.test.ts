/**
 * Tests for src/domain/depth.ts — mirrors test/unit/recursion-guard.test.ts
 * against the ported module. Adds one extra block for the new
 * `checkSubagentDepthEffect` Effect-shaped variant which fails with
 * `SubagentDepthExceeded` instead of returning a `{blocked:true}` shape.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import {
	checkSubagentDepth,
	checkSubagentDepthEffect,
	getSubagentDepthEnv,
	normalizeMaxSubagentDepth,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../src/domain/depth.ts";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "../../src/domain/constants.ts";
import { SubagentDepthExceeded } from "../../src/errors.ts";

let savedDepth: string | undefined;
let savedMaxDepth: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
});

afterEach(() => {
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
	else process.env.PI_SUBAGENT_MAX_DEPTH = savedMaxDepth;
});

describe("DEFAULT_SUBAGENT_MAX_DEPTH", () => {
	it("is 2", () => {
		assert.equal(DEFAULT_SUBAGENT_MAX_DEPTH, 2);
	});
});

describe("normalizeMaxSubagentDepth", () => {
	it("accepts integers >= 0", () => {
		assert.equal(normalizeMaxSubagentDepth(0), 0);
		assert.equal(normalizeMaxSubagentDepth(3), 3);
		assert.equal(normalizeMaxSubagentDepth("4"), 4);
	});

	it("rejects negatives and non-integers", () => {
		assert.equal(normalizeMaxSubagentDepth(-1), undefined);
		assert.equal(normalizeMaxSubagentDepth(1.5), undefined);
		assert.equal(normalizeMaxSubagentDepth("garbage"), undefined);
	});
});

describe("resolveCurrentMaxSubagentDepth", () => {
	it("uses env when present", () => {
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		assert.equal(resolveCurrentMaxSubagentDepth(1), 5);
	});

	it("falls back to config when env is absent", () => {
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		assert.equal(resolveCurrentMaxSubagentDepth(1), 1);
	});

	it("falls back to default when neither env nor config is valid", () => {
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		assert.equal(resolveCurrentMaxSubagentDepth(undefined), 2);
		assert.equal(resolveCurrentMaxSubagentDepth(-1), 2);
	});
});

describe("resolveChildMaxSubagentDepth", () => {
	it("keeps the inherited max when agent override is absent", () => {
		assert.equal(resolveChildMaxSubagentDepth(3, undefined), 3);
	});

	it("tightens to the lower per-agent max", () => {
		assert.equal(resolveChildMaxSubagentDepth(3, 1), 1);
	});

	it("does not relax an already stricter inherited max", () => {
		assert.equal(resolveChildMaxSubagentDepth(1, 3), 1);
	});
});

describe("checkSubagentDepth (legacy shape)", () => {
	it("not blocked at depth=0, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const result = checkSubagentDepth();
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, 2);
	});

	it("uses config max depth when env is absent", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const result = checkSubagentDepth(1);
		assert.equal(result.blocked, true);
		assert.equal(result.maxDepth, 1);
	});

	it("blocked at depth=2, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const result = checkSubagentDepth();
		assert.equal(result.blocked, true);
		assert.equal(result.depth, 2);
		assert.equal(result.maxDepth, 2);
	});

	it("blocked at depth=0, max=0 (disables subagent entirely)", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "0";
		assert.equal(checkSubagentDepth().blocked, true);
	});

	it("not blocked when depth is invalid (NaN)", () => {
		process.env.PI_SUBAGENT_DEPTH = "garbage";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		assert.equal(checkSubagentDepth().blocked, false);
	});
});

describe("checkSubagentDepthEffect (Effect shape)", () => {
	it("succeeds with the depth check when not blocked", async () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const exit = await Effect.runPromiseExit(checkSubagentDepthEffect());
		assert.equal(Exit.isSuccess(exit), true);
		if (Exit.isSuccess(exit)) {
			assert.equal(exit.value.blocked, false);
			assert.equal(exit.value.depth, 0);
			assert.equal(exit.value.maxDepth, 2);
		}
	});

	it("fails with SubagentDepthExceeded when blocked", async () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const exit = await Effect.runPromiseExit(checkSubagentDepthEffect());
		assert.equal(Exit.isFailure(exit), true);
		if (Exit.isFailure(exit)) {
			const errorOpt = Cause.findErrorOption(exit.cause);
			assert.equal(Option.isSome(errorOpt), true);
			if (Option.isSome(errorOpt)) {
				assert.ok(errorOpt.value instanceof SubagentDepthExceeded);
				assert.equal(errorOpt.value.depth, 2);
				assert.equal(errorOpt.value.maxDepth, 2);
			}
		}
	});
});

describe("getSubagentDepthEnv", () => {
	it("increments from depth=0", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");
	});

	it("uses provided max depth override", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv(1);
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "1");
	});

	it("respects inherited PI_SUBAGENT_MAX_DEPTH when override is absent", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "5");
	});

	it("uses the explicit child override even when a looser inherited env max exists", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		const env = getSubagentDepthEnv(1);
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "1");
	});

	it("falls back to depth=1 when env var is invalid (NaN)", () => {
		process.env.PI_SUBAGENT_DEPTH = "not-a-number";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
	});
});
