/**
 * pi-subagents extension entry — Effect-based.
 *
 * Replaces the legacy index.ts. Composes the full Live layer once via
 * pi-adapter/runtime.ts and registers the `subagent` and `subagent_status`
 * tools using the effectTool wrapper from pi-adapter/tool-definition.ts.
 *
 * The on-disk extension config (`~/.pi/agent/extensions/subagent/config.json`),
 * artifact paths, status.json shape, and event-bus channels remain
 * byte-compatible with the legacy implementation — see the golden-artifact
 * diff in test/golden/.
 *
 * Implementation lands at Phase 11 (entry swap). Until then this file
 * stays empty so package.json:pi.extensions can keep pointing at the
 * legacy ./index.ts.
 */
export {};
