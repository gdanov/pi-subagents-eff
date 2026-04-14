/**
 * Tests for src/domain/output.ts. The legacy code did not have a
 * dedicated truncation test (truncateOutput was only exercised
 * indirectly via integration tests). Add direct unit coverage now
 * since truncation behavior is part of the on-disk artifact contract.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, truncateOutput } from "../../src/domain/output.ts";

describe("formatBytes", () => {
	it("renders byte counts under 1024 with the B suffix", () => {
		assert.equal(formatBytes(0), "0B");
		assert.equal(formatBytes(512), "512B");
		assert.equal(formatBytes(1023), "1023B");
	});

	it("renders KB at 1 decimal", () => {
		assert.equal(formatBytes(1024), "1.0KB");
		assert.equal(formatBytes(1536), "1.5KB");
	});

	it("renders MB at 1 decimal", () => {
		assert.equal(formatBytes(1024 * 1024), "1.0MB");
		assert.equal(formatBytes(2 * 1024 * 1024 + 512 * 1024), "2.5MB");
	});
});

describe("truncateOutput", () => {
	it("returns input untouched when within both caps", () => {
		const result = truncateOutput("hello\nworld", { bytes: 1024, lines: 100 });
		assert.equal(result.text, "hello\nworld");
		assert.equal(result.truncated, false);
		assert.equal(result.originalBytes, undefined);
		assert.equal(result.originalLines, undefined);
	});

	it("clips lines beyond the line cap and prepends a marker", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
		const result = truncateOutput(lines, { bytes: 1024, lines: 5 });
		assert.equal(result.truncated, true);
		assert.equal(result.originalLines, 20);
		assert.match(result.text, /^\[TRUNCATED: showing first 5 of 20 lines/);
		assert.match(result.text, /line0\nline1\nline2\nline3\nline4$/);
	});

	it("clips bytes on a UTF-8 boundary without splitting code points", () => {
		// 'é' is two bytes in UTF-8.
		const big = "é".repeat(100); // 200 bytes
		const result = truncateOutput(big, { bytes: 50, lines: 100 });
		assert.equal(result.truncated, true);
		assert.equal(result.originalBytes, 200);
		// Strip the marker line; the remainder must be a valid prefix.
		const body = result.text.split("\n").slice(1).join("\n");
		assert.ok(Buffer.byteLength(body, "utf-8") <= 50);
		assert.equal(body, "é".repeat(Math.floor(50 / 2)));
	});

	it("includes the artifact path in the marker when provided", () => {
		const result = truncateOutput("aaaa\n".repeat(10), { bytes: 1024, lines: 5 }, "/tmp/full.txt");
		assert.match(result.text, /full output at \/tmp\/full\.txt/);
		assert.equal(result.artifactPath, "/tmp/full.txt");
	});
});
