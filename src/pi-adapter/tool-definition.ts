/**
 * Pi tool-definition adapter.
 *
 * `effectTool({ name, parameters: EffectSchema, execute })` returns a
 * Pi ToolDefinition whose `.execute` callback runs the user's Effect on
 * the shared ManagedRuntime, applies `Effect.catchTags` to map every
 * tagged error to a user-facing message, and resolves the Promise.
 *
 * Also generates the JSON Schema from the Effect Schema (via
 * Schema.toStandardJSONSchemaV1) and post-processes it via the
 * typebox-bridge to coerce the four anyOf nodes that today's Type.Any()
 * workarounds at schemas.ts:8,58,72,99 paper over.
 *
 * Implementation lands at Phase 11 (entry swap).
 */
export {};
