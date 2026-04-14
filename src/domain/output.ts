/**
 * Output truncation helpers — pure logic ported from types.ts:433-481.
 *
 * `truncateOutput` enforces both a byte cap and a line cap, prepends a
 * `[TRUNCATED: ...]` marker on truncation, and optionally references an
 * artifact path where the full output was preserved. The byte cap uses
 * a binary search to slice on a UTF-8 boundary without splitting code
 * points (matters for multi-byte content; the legacy code's behavior
 * is preserved).
 *
 * `formatBytes` is a tiny human-readable formatter ("123B" / "1.2KB" /
 * "3.4MB").
 */

export interface TruncationResult {
	readonly text: string;
	readonly truncated: boolean;
	readonly originalBytes?: number;
	readonly originalLines?: number;
	readonly artifactPath?: string;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface TruncationConfig {
	readonly bytes: number;
	readonly lines: number;
}

export function truncateOutput(
	output: string,
	config: TruncationConfig,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	const truncatedLines = lines.length > config.lines ? lines.slice(0, config.lines) : lines;

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		// Binary search for the largest prefix whose UTF-8 byte length fits.
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
