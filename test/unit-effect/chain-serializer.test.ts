/**
 * Tests for src/executor/chain-serializer.ts.
 *
 * Round-trip parse↔serialize preserves the on-disk shape per
 * the `.chain.md` contract.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChain, serializeChain } from "../../src/executor/chain-serializer.ts";

describe("parseChain", () => {
	it("parses two-step chain with task bodies", () => {
		const md = `---
name: my-chain
description: do things
---

## scout

Find the configs.

## planner

Plan the changes.
`;
		const chain = parseChain(md, "user", "/p.chain.md");
		assert.equal(chain.name, "my-chain");
		assert.equal(chain.description, "do things");
		assert.equal(chain.steps.length, 2);
		assert.equal(chain.steps[0]?.agent, "scout");
		assert.equal(chain.steps[0]?.task, "Find the configs.");
		assert.equal(chain.steps[1]?.agent, "planner");
		assert.equal(chain.steps[1]?.task, "Plan the changes.");
	});

	it("parses step config (output/reads/model/skills/progress)", () => {
		const md = `---
name: c
description: d
---

## scout
output: context.md
reads: shared.md, other.md
model: anthropic/claude-sonnet-4
skills: safe-bash
progress: true

Find configs.
`;
		const chain = parseChain(md, "project", "/c.chain.md");
		const step = chain.steps[0]!;
		assert.equal(step.output, "context.md");
		assert.deepEqual([...(step.reads as readonly string[])], ["shared.md", "other.md"]);
		assert.equal(step.model, "anthropic/claude-sonnet-4");
		assert.deepEqual([...(step.skills as readonly string[])], ["safe-bash"]);
		assert.equal(step.progress, true);
	});

	it("parses output: false / reads: false / skills: false sentinels", () => {
		const md = `---
name: c
description: d
---

## scout
output: false
reads: false
skills: false
progress: false

Body.
`;
		const step = parseChain(md, "user", "/x.chain.md").steps[0]!;
		assert.equal(step.output, false);
		assert.equal(step.reads, false);
		assert.equal(step.skills, false);
		assert.equal(step.progress, false);
	});

	it("captures extraFields for non-known frontmatter keys", () => {
		const md = `---
name: c
description: d
custom: value
---

## a

x
`;
		const chain = parseChain(md, "user", "/x.chain.md");
		assert.equal(chain.extraFields?.custom, "value");
	});

	it("throws when name or description missing", () => {
		assert.throws(() => parseChain("---\nname: x\n---\n## a\nx", "user", "/x"), /must include name and description/);
	});
});

describe("serializeChain", () => {
	it("round-trips a chain through parse → serialize → parse", () => {
		const md = `---
name: my-chain
description: do things
---

## scout
output: ctx.md
reads: shared.md
model: anthropic/claude-sonnet-4

Find configs.

## planner
reads: ctx.md
progress: true

Plan changes.
`;
		const chain = parseChain(md, "user", "/p.chain.md");
		const re = parseChain(serializeChain(chain), "user", "/p.chain.md");
		assert.equal(re.name, chain.name);
		assert.equal(re.description, chain.description);
		assert.equal(re.steps.length, chain.steps.length);
		for (let i = 0; i < re.steps.length; i++) {
			assert.equal(re.steps[i]?.agent, chain.steps[i]?.agent);
			assert.equal(re.steps[i]?.task, chain.steps[i]?.task);
			assert.deepEqual(re.steps[i]?.reads, chain.steps[i]?.reads);
		}
	});

	it("serializeChain output is byte-identical for canonical-shape input", () => {
		// The legacy `.chain.md` on-disk format is public API; any
		// whitespace / key-ordering drift risks breaking `git diff` on
		// chains checked into project repos. Pin the canonical shape.
		const chain = {
			name: "two-step",
			description: "do the thing",
			source: "user" as const,
			filePath: "/p.chain.md",
			steps: [
				{
					agent: "scout",
					task: "Find configs.",
					output: "ctx.md",
					reads: ["shared.md"],
					model: "anthropic/claude-sonnet-4",
				},
				{
					agent: "planner",
					task: "Plan changes.",
					reads: ["ctx.md"],
					progress: true,
				},
			],
		};
		const expected = `---
name: two-step
description: do the thing
---

## scout
output: ctx.md
reads: shared.md
model: anthropic/claude-sonnet-4

Find configs.

## planner
reads: ctx.md
progress: true

Plan changes.
`;
		assert.equal(serializeChain(chain), expected);
	});

	it("full byte-identical round-trip on a representative chain", () => {
		// parse(serialize(parse(x))) must produce a byte-identical
		// second serialization even if the first input had whitespace
		// oddities. This catches silent drift in key emission order.
		const original = `---
name: rt
description: round trip
---

## scout
output: out.md

Body one.

## reviewer
reads: out.md
progress: false

Body two.
`;
		const first = serializeChain(parseChain(original, "user", "/rt.chain.md"));
		const second = serializeChain(parseChain(first, "user", "/rt.chain.md"));
		assert.equal(first, second, "serialize must be idempotent under re-parse");
	});

	it("serialize emits frontmatter + per-step config + body", () => {
		const out = serializeChain({
			name: "x",
			description: "d",
			source: "user",
			filePath: "/x.chain.md",
			steps: [
				{
					agent: "scout",
					task: "T",
					output: "out.md",
					reads: ["a.md"],
					model: "m",
					skills: ["s1", "s2"],
					progress: true,
				},
			],
		});
		assert.match(out, /^---\nname: x\ndescription: d\n---\n/);
		assert.match(out, /## scout/);
		assert.match(out, /output: out\.md/);
		assert.match(out, /reads: a\.md/);
		assert.match(out, /model: m/);
		assert.match(out, /skills: s1, s2/);
		assert.match(out, /progress: true/);
		assert.match(out, /\nT\n/);
	});
});
