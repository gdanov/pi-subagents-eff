/**
 * Shared schema fragments used by both subagent-params.ts and chain.ts.
 *
 * Lives in its own module to break a would-be circular import between
 * those two (subagent-params re-exports ChainItem; chain steps re-use
 * the SkillOverride / Output / Reads shapes).
 */
import { Schema } from "effect";

/** string | string[] | boolean — see schemas.ts:8. */
export const SkillOverrideSchema = Schema.Union([
	Schema.String,
	Schema.Array(Schema.String),
	Schema.Boolean,
]).annotate({
	description:
		"Skill name(s) to inject (comma-separated), array of strings, or boolean (false disables, true uses default)",
});

/** filename string | false — see schemas.ts:26. */
export const OutputOverrideSchema = Schema.Union([Schema.String, Schema.Boolean]).annotate({
	description: "Output filename to write in {chain_dir} (string), or false to disable file output",
});

/** array of filenames | false — see schemas.ts:27. */
export const ReadsOverrideSchema = Schema.Union([
	Schema.Array(Schema.String),
	Schema.Boolean,
]).annotate({
	description: "Files to read from {chain_dir} before running (array of filenames), or false to disable",
});
