/**
 * Artifact-path and artifact-config schemas — ported from types.ts:134-148.
 *
 * ArtifactPaths: where the on-disk artifact files for one subagent run
 *                live. Encoded as plain JSON in metadata.json.
 * ArtifactConfig: per-run feature flags (enable, which sub-files to
 *                 write, retention days).
 *
 * The legacy `DEFAULT_ARTIFACT_CONFIG` lives in domain/constants.ts.
 */
import { Schema } from "effect";

export const ArtifactPathsSchema = Schema.Struct({
	inputPath: Schema.String,
	outputPath: Schema.String,
	jsonlPath: Schema.String,
	metadataPath: Schema.String,
}).annotate({ identifier: "ArtifactPaths" });

export type ArtifactPaths = typeof ArtifactPathsSchema.Type;

export const ArtifactConfigSchema = Schema.Struct({
	enabled: Schema.Boolean,
	includeInput: Schema.Boolean,
	includeOutput: Schema.Boolean,
	includeJsonl: Schema.Boolean,
	includeMetadata: Schema.Boolean,
	cleanupDays: Schema.Number,
}).annotate({ identifier: "ArtifactConfig" });

export type ArtifactConfig = typeof ArtifactConfigSchema.Type;
