/**
 * ArtifactStore service.
 *
 * Owns the artifact directory layout and write paths. Replaces:
 *   - artifacts.ts (paths, write input/output/metadata, cleanup)
 *   - jsonl-writer.ts (back-pressured event-stream append; becomes a Sink)
 *
 * Depends on FileSystem.
 *
 * Live : real on-disk artifacts under ${TEMP_ROOT_DIR} or ~/.pi/agent/artifacts.
 * Test : in-memory, drives the golden-artifact diff in CI.
 */
import { Context, Effect, Layer, Sink } from "effect";
import type { FsWriteError } from "../errors.ts";

export interface ArtifactPaths {
	readonly inputPath: string;
	readonly outputPath: string;
	readonly jsonlPath: string;
	readonly metadataPath: string;
}

export interface ArtifactStoreService {
	readonly paths: (dir: string, runId: string, agent: string, idx: number) => ArtifactPaths;
	readonly writeInput: (path: string, body: unknown) => Effect.Effect<void, FsWriteError>;
	readonly writeOutput: (path: string, body: unknown) => Effect.Effect<void, FsWriteError>;
	readonly writeMetadata: (path: string, body: unknown) => Effect.Effect<void, FsWriteError>;
	/** Sink that appends each chunk as a JSONL line; back-pressure handled internally. */
	readonly appendJsonl: (path: string) => Sink.Sink<void, string, never, FsWriteError>;
	readonly cleanupOlderThan: (dir: string, ageDays: number) => Effect.Effect<void, FsWriteError>;
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
	"pi-subagents/ArtifactStore",
) {}

export const ArtifactStoreLive = Layer.sync(ArtifactStore)(() => {
	throw new Error("ArtifactStore.Live not yet implemented (Phase 3)");
});

export const makeArtifactStoreTest = (): Layer.Layer<ArtifactStore, never, never> =>
	Layer.sync(ArtifactStore)(() => {
		throw new Error("ArtifactStore.Test not yet implemented (Phase 3)");
	});
