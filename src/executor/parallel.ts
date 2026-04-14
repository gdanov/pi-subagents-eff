/**
 * Parallel execution mode.
 *
 * Replaces parallel-utils.ts. Uses Effect.all(items, { concurrency }) for
 * the bounded fan-out (replaces the hand-rolled mapConcurrent at
 * parallel-utils.ts:54-78), `aggregateParallelOutputs` stays as a pure
 * helper, and `flattenSteps` likewise.
 *
 * Implementation lands in Phase 6.
 */
export {};
