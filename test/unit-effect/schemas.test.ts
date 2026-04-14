/**
 * Tests for src/schema/subagent-params.ts and src/schema/chain.ts.
 *
 * Two layers:
 *   1. Decode-side: round-trip representative payloads through
 *      Schema.decodeUnknownEffect — the legacy code's shape MUST decode.
 *   2. JSONSchema-side: Schema.toJsonSchemaDocument output must contain
 *      enough structure to satisfy the legacy schemas.test.ts contract
 *      (context enum, count minimum, status action).
 *
 * Note: optional fields produce `anyOf: [type, null]` in the generator
 * output. The typebox-bridge (Phase 11) collapses these to bare types
 * for Pi tool registration; we don't assert the bridged shape here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Schema } from "effect";
import {
	StatusParamsSchema,
	SubagentParamsSchema,
	TaskItemSchema,
} from "../../src/schema/subagent-params.ts";
import {
	ChainItemSchema,
	ParallelStepSchema,
	SequentialStepSchema,
} from "../../src/schema/chain.ts";

describe("SubagentParamsSchema decode", () => {
	it("decodes single mode {agent, task}", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SubagentParamsSchema)({
				agent: "scout",
				task: "find configs",
			}),
		);
		assert.equal(decoded.agent, "scout");
		assert.equal(decoded.task, "find configs");
	});

	it("decodes parallel mode with count and skill array", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SubagentParamsSchema)({
				tasks: [
					{ agent: "worker", task: "do A", count: 3, skill: ["safe-bash"] },
					{ agent: "worker", task: "do B", skill: false },
				],
			}),
		);
		assert.equal(decoded.tasks?.length, 2);
		assert.equal(decoded.tasks?.[0]?.count, 3);
		assert.equal(decoded.tasks?.[1]?.skill, false);
	});

	it("decodes chain mode with mixed sequential and parallel steps", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SubagentParamsSchema)({
				chain: [
					{ agent: "scout", task: "list" },
					{ parallel: [{ agent: "worker", task: "{previous}" }, { agent: "worker", task: "{previous}" }] },
					{ agent: "reviewer", output: "review.md" },
				],
			}),
		);
		assert.equal(decoded.chain?.length, 3);
	});

	it("decodes context fork mode", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SubagentParamsSchema)({ context: "fork" }),
		);
		assert.equal(decoded.context, "fork");
	});

	it("rejects non-integer count", async () => {
		const exit = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(TaskItemSchema)({
				agent: "worker",
				task: "x",
				count: 1.5,
			}),
		);
		assert.equal(exit._tag, "Failure");
	});

	it("rejects unknown context literal", async () => {
		const exit = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(SubagentParamsSchema)({ context: "weird" }),
		);
		assert.equal(exit._tag, "Failure");
	});
});

describe("ChainItemSchema decode", () => {
	it("decodes a sequential step", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(ChainItemSchema)({ agent: "worker", task: "build" }),
		);
		assert.equal((decoded as { agent: string }).agent, "worker");
	});

	it("decodes a parallel step", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(ChainItemSchema)({
				parallel: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }],
				concurrency: 2,
			}),
		);
		assert.equal((decoded as { parallel: ReadonlyArray<unknown> }).parallel.length, 2);
	});
});

describe("StatusParamsSchema decode", () => {
	it("decodes empty {}", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(StatusParamsSchema)({}),
		);
		assert.equal(decoded.action, undefined);
	});

	it("decodes id-prefix lookup", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(StatusParamsSchema)({ id: "abc12" }),
		);
		assert.equal(decoded.id, "abc12");
	});
});

/**
 * Schemas with an `identifier` annotation are extracted into the
 * document's `definitions` table and referenced via `$ref` from the
 * root. Pi's tool registration follows the ref; tests need to do the
 * same lookup explicitly.
 */
function resolveRoot(doc: ReturnType<typeof Schema.toJsonSchemaDocument>): {
	properties?: Record<string, unknown>;
} {
	const schema = doc.schema as { $ref?: string; properties?: Record<string, unknown> };
	if (!schema.$ref) return schema;
	const refName = schema.$ref.replace(/^#\/(?:\$defs|definitions)\//, "");
	const defs = (doc as unknown as { definitions?: Record<string, unknown> }).definitions ?? {};
	return defs[refName] as { properties?: Record<string, unknown> };
}

describe("SubagentParams JSONSchema shape", () => {
	const doc = Schema.toJsonSchemaDocument(SubagentParamsSchema);
	const root = resolveRoot(doc);
	const props = root.properties ?? {};

	it("includes context field with fresh/fork enum", () => {
		const ctx = props.context as { anyOf?: ReadonlyArray<{ enum?: ReadonlyArray<string> }> } | undefined;
		assert.ok(ctx, "context schema should exist");
		// optional union -> anyOf with the literal-enum branch + null
		const enumBranch = ctx?.anyOf?.find((m) => Array.isArray(m?.enum));
		assert.ok(enumBranch, "expected an enum branch in context anyOf");
		assert.deepEqual([...(enumBranch?.enum ?? [])].sort(), ["fork", "fresh"]);
	});

	it("includes count >= 1 on tasks[]", () => {
		const tasks = props.tasks as
			| { anyOf?: ReadonlyArray<{ items?: { properties?: Record<string, unknown> } }> }
			| undefined;
		const itemsBranch = tasks?.anyOf?.find((m) => m?.items);
		const count = itemsBranch?.items?.properties?.count as
			| { anyOf?: ReadonlyArray<{ allOf?: ReadonlyArray<{ minimum?: number }> }> }
			| undefined;
		assert.ok(count, "tasks[].count schema should exist");
		const minimumNode = count?.anyOf
			?.flatMap((m) => m?.allOf ?? [])
			.find((n) => typeof n?.minimum === "number");
		assert.equal(minimumNode?.minimum, 1);
	});

	it("StatusParams exposes an action field", () => {
		const statusDoc = Schema.toJsonSchemaDocument(StatusParamsSchema);
		const statusRoot = resolveRoot(statusDoc);
		assert.ok(statusRoot.properties?.action, "status action schema should exist");
	});
});

describe("Chain step schemas", () => {
	it("SequentialStep allows missing task (defaults applied at runtime)", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(SequentialStepSchema)({ agent: "worker" }),
		);
		assert.equal(decoded.agent, "worker");
		assert.equal(decoded.task, undefined);
	});

	it("ParallelStep requires non-empty parallel array (single member is fine)", async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(ParallelStepSchema)({ parallel: [{ agent: "x", task: "y" }] }),
		);
		assert.equal(decoded.parallel.length, 1);
	});
});
