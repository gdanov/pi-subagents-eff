/**
 * Tests for src/services/SkillResolver.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import {
	buildSkillInjection,
	makeSkillResolverTest,
	SkillResolver,
	SkillResolverNoop,
	type ResolvedSkill,
} from "../../src/services/SkillResolver.ts";

describe("buildSkillInjection", () => {
	it("returns empty string for no skills", () => {
		assert.equal(buildSkillInjection([]), "");
	});

	it("formats one skill with the legacy <skill> wrapper", () => {
		const skills: ResolvedSkill[] = [
			{ name: "safe-bash", path: "/p/safe-bash.md", source: "user", content: "Body 1" },
		];
		assert.equal(
			buildSkillInjection(skills),
			'<skill name="safe-bash">\nBody 1\n</skill>',
		);
	});

	it("joins multiple skills with double newlines", () => {
		const skills: ResolvedSkill[] = [
			{ name: "a", path: "/a.md", source: "user", content: "A" },
			{ name: "b", path: "/b.md", source: "builtin", content: "B" },
		];
		assert.equal(
			buildSkillInjection(skills),
			'<skill name="a">\nA\n</skill>\n\n<skill name="b">\nB\n</skill>',
		);
	});
});

describe("SkillResolverNoop (default Live until full impl lands)", () => {
	it("returns every name as missing", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* SkillResolver;
					return yield* r.resolve(["a", "b"], "/cwd");
				}),
				SkillResolverNoop,
			),
		);
		assert.deepEqual([...result.resolved], []);
		assert.deepEqual([...result.missing], ["a", "b"]);
	});
});

describe("makeSkillResolverTest", () => {
	it("returns fixtures for known names; missing for the rest", async () => {
		const fixture: ResolvedSkill = {
			name: "safe-bash",
			path: "/x.md",
			source: "user",
			content: "fixture body",
		};
		const layer = makeSkillResolverTest({ "safe-bash": fixture });
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* SkillResolver;
					return yield* r.resolve(["safe-bash", "missing"], "/cwd");
				}),
				layer,
			),
		);
		assert.equal(result.resolved.length, 1);
		assert.equal(result.resolved[0]?.name, "safe-bash");
		assert.deepEqual([...result.missing], ["missing"]);
	});
});
