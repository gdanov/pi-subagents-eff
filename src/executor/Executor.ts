/**
 * Executor — top-level dispatcher for the `subagent` tool.
 *
 * Replaces subagent-executor.ts. Routes by params:
 *   - action present  -> management.ts
 *   - tasks[]         -> parallel.ts
 *   - chain[]         -> chain.ts
 *   - else            -> single.ts
 *
 * Wraps each path in the recursion-depth guard from domain/depth.ts and,
 * when async=true, forks a daemon fiber via async.ts.
 *
 * Implementation lands in Phase 5+ once single/chain/parallel/async are ported.
 */
export {};
