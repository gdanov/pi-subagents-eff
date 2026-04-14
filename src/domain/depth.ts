/**
 * Subagent recursion-depth guard — pure helper.
 *
 * Replaces types.ts:413-427 (checkSubagentDepth boolean returns).
 * In the new model, the executor calls a small Effect that fails with
 * SubagentDepthExceeded if the limit is reached.
 *
 * Implementation lands in Phase 2.
 */
export {};
