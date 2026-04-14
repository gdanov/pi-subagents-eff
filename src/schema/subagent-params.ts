/**
 * Effect Schema definitions for the `subagent` tool input.
 *
 * Replaces schemas.ts (SubagentParams, StatusParams, TaskItem). The
 * Type.Any() workarounds at schemas.ts:8,72,99 (SkillOverride, config,
 * output) become real Schema.Union nodes here; the typebox-bridge
 * post-processor flattens the JSONSchema for Google API compatibility
 * at registration time.
 *
 * Implementation lands in Phase 2.
 */
export {};
