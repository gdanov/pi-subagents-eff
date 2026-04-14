/**
 * Tests for src/domain/messages.ts. The legacy code did not have direct
 * unit tests for these helpers; covering them now lets us swap the
 * call sites in Phase 5 with confidence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractTextFromContent,
	extractToolArgsPreview,
	getDisplayItems,
	getFinalOutput,
	getSingleResultOutput,
} from "../../src/domain/messages.ts";

describe("getFinalOutput", () => {
	it("returns the last assistant text part", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [] },
			{ role: "assistant", content: [{ type: "toolCall", name: "ls", arguments: {} }, { type: "text", text: "second" }] },
		];
		assert.equal(getFinalOutput(messages), "second");
	});

	it("returns empty string when no assistant text exists", () => {
		assert.equal(getFinalOutput([]), "");
		assert.equal(
			getFinalOutput([{ role: "assistant", content: [{ type: "toolCall", name: "ls", arguments: {} }] }]),
			"",
		);
	});

	it("getSingleResultOutput prefers explicit finalOutput", () => {
		assert.equal(
			getSingleResultOutput({
				finalOutput: "explicit",
				messages: [{ role: "assistant", content: [{ type: "text", text: "fallback" }] }],
			}),
			"explicit",
		);
	});

	it("getSingleResultOutput falls back to last assistant text", () => {
		assert.equal(
			getSingleResultOutput({
				messages: [{ role: "assistant", content: [{ type: "text", text: "fallback" }] }],
			}),
			"fallback",
		);
	});
});

describe("getDisplayItems", () => {
	it("flattens text and toolCall parts in order", () => {
		const items = getDisplayItems([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "thinking" },
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
					{ type: "text", text: "done" },
				],
			},
		]);
		assert.deepEqual(items, [
			{ type: "text", text: "thinking" },
			{ type: "tool", name: "bash", args: { command: "ls" } },
			{ type: "text", text: "done" },
		]);
	});

	it("ignores non-assistant messages", () => {
		const items = getDisplayItems([
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: [{ type: "text", text: "instructions" }] },
		]);
		assert.deepEqual(items, []);
	});
});

describe("extractToolArgsPreview", () => {
	it("formats MCP tool calls with server/tool/args", () => {
		assert.equal(
			extractToolArgsPreview({ server: "github", tool: "search", args: "needle in haystack" }),
			"github/search needle in haystack",
		);
	});

	it("uses the first matching priority key", () => {
		assert.equal(extractToolArgsPreview({ command: "ls -la /tmp" }), "ls -la /tmp");
		assert.equal(
			extractToolArgsPreview({ path: "/some/path", command: "cat" }),
			"cat",
			"command takes priority over path",
		);
	});

	it("truncates long preview values", () => {
		const long = "x".repeat(100);
		const result = extractToolArgsPreview({ command: long });
		assert.equal(result.length, 60);
		assert.ok(result.endsWith("..."));
	});

	it("falls back to the first non-empty string field", () => {
		assert.equal(
			extractToolArgsPreview({ random_key: "value" }),
			"random_key=value",
		);
	});

	it("returns empty string for empty args", () => {
		assert.equal(extractToolArgsPreview({}), "");
	});
});

describe("extractTextFromContent", () => {
	it("returns string content directly", () => {
		assert.equal(extractTextFromContent("hello"), "hello");
	});

	it("joins text-typed parts with newlines", () => {
		assert.equal(
			extractTextFromContent([
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			]),
			"one\ntwo",
		);
	});

	it("recurses into tool_result parts", () => {
		assert.equal(
			extractTextFromContent([
				{ type: "tool_result", content: [{ type: "text", text: "nested" }] },
			]),
			"nested",
		);
	});

	it("falls back to a part's `text` field even without a type tag", () => {
		assert.equal(
			extractTextFromContent([{ text: "no-type" }]),
			"no-type",
		);
	});

	it("returns empty string for unsupported shapes", () => {
		assert.equal(extractTextFromContent(undefined), "");
		assert.equal(extractTextFromContent(null), "");
		assert.equal(extractTextFromContent(42), "");
		assert.equal(extractTextFromContent({ no: "matching parts" }), "");
	});
});
