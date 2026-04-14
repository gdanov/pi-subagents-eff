/**
 * ArtifactStore service.
 *
 * Owns the on-disk artifact layout. Replaces artifacts.ts.
 *
 * The legacy jsonl-writer.ts handled stream back-pressure for the
 * `pi` subprocess output stream — that responsibility now lives in
 * `executor/single.ts` (Phase 5) which sinks an `Effect.Stream` of
 * events to a Sink built from `appendJsonlLine` here. Keeping
 * ArtifactStore as a flat synchronous-style append API keeps the
 * service surface small.
 *
 * Depends on: FileSystem, Clock (for cleanup mtime comparison).
 */
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { FsWriteError } from "../errors.ts";
import { TEMP_ARTIFACTS_DIR } from "../domain/constants.ts";
import type { ArtifactPaths } from "../domain/artifacts.ts";
import { FileSystem } from "./FileSystem.ts";

const CLEANUP_MARKER_FILE = ".last-cleanup";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface ArtifactStoreService {
	/** Resolve the artifacts directory for a session (or temp if no session). */
	readonly resolveDir: (sessionFile: string | null) => string;
	/** Build the four artifact paths for a single (run, agent, index) tuple. */
	readonly paths: (artifactsDir: string, runId: string, agent: string, index?: number) => ArtifactPaths;
	/** Ensure the artifacts directory exists. */
	readonly ensureDir: (dir: string) => Effect.Effect<void, FsWriteError>;
	readonly writeInput: (path: string, body: string) => Effect.Effect<void, FsWriteError>;
	readonly writeOutput: (path: string, body: string) => Effect.Effect<void, FsWriteError>;
	readonly writeMetadata: (path: string, body: object) => Effect.Effect<void, FsWriteError>;
	/** Append one JSONL line (caller adds the trailing newline). */
	readonly appendJsonlLine: (path: string, line: string) => Effect.Effect<void, FsWriteError>;
	/**
	 * Best-effort cleanup of artifacts older than `maxAgeDays`. Skips
	 * non-existent dirs, swallows per-file errors, and rate-limits
	 * itself to once per 24h via a marker file.
	 */
	readonly cleanupOlderThan: (dir: string, maxAgeDays: number) => Effect.Effect<void, FsWriteError>;
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
	"pi-subagents/ArtifactStore",
) {}

// ============================================================================
// Pure helpers (no Effect)
// ============================================================================

function resolveDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, "subagent-artifacts");
	}
	return TEMP_ARTIFACTS_DIR;
}

function buildPaths(
	artifactsDir: string,
	runId: string,
	agent: string,
	index?: number,
): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

// ============================================================================
// Live
// ============================================================================

export const ArtifactStoreLive = Layer.effect(ArtifactStore)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;

		const ensureDir = (dir: string) => fsApi.mkdir(dir);

		const cleanupOlderThan = (
			dir: string,
			maxAgeDays: number,
		): Effect.Effect<void, FsWriteError> =>
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(dir);
				if (!exists) return;

				const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
				const now = Date.now();

				const markerStat = yield* fsApi.stat(markerPath).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed(undefined)),
					Effect.catchTag("FsReadError", () => Effect.succeed(undefined)),
				);
				// Rate-limit: skip if the last cleanup ran in the past 24h.
				if (markerStat && now - markerStat.mtimeMs < ONE_DAY_MS) return;

				const cutoff = now - maxAgeDays * ONE_DAY_MS;
				const entries = yield* fsApi.readDir(dir).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
					Effect.catchTag("FsReadError", () => Effect.succeed<ReadonlyArray<string>>([])),
				);

				for (const file of entries) {
					if (file === CLEANUP_MARKER_FILE) continue;
					const filePath = path.join(dir, file);
					// Best-effort per-file: Effect.ignore swallows ordinary
					// failures (FsNotFound mid-scan, FsReadError, FsWriteError)
					// so one bad entry can't block cleanup of the rest, but
					// it still propagates interruption — important if the
					// extension is shutting down mid-cleanup.
					yield* Effect.ignore(
						Effect.gen(function* () {
							const stat = yield* fsApi.stat(filePath);
							if (stat.mtimeMs < cutoff) yield* fsApi.rm(filePath);
						}),
					);
				}

				yield* fsApi.write(markerPath, String(now));
			});

		return ArtifactStore.of({
			resolveDir,
			paths: buildPaths,
			ensureDir,
			writeInput: (p, body) => fsApi.write(p, body),
			writeOutput: (p, body) => fsApi.write(p, body),
			writeMetadata: (p, body) => fsApi.write(p, JSON.stringify(body, null, 2)),
			appendJsonlLine: (p, line) => fsApi.append(p, `${line}\n`),
			cleanupOlderThan,
		});
	}),
);

// ============================================================================
// Test
// ============================================================================

/**
 * Test layer: backed by the same FileSystem service the test composed.
 * Useful when a test wants to inspect emitted artifacts via the
 * FileSystem.Test controls. No separate fixture-builder needed.
 */
export const ArtifactStoreTest: Layer.Layer<ArtifactStore, never, FileSystem> = ArtifactStoreLive;
