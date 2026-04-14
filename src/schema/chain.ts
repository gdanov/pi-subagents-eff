/**
 * Effect Schema for chain-step types.
 *
 * Replaces schemas.ts (SequentialStepSchema, ParallelStepSchema, ChainItem)
 * and the chain-step types embedded in settings.ts.
 *
 * ChainItem is a real Schema.Union(SequentialStep, ParallelStep)
 * discriminated by the presence of the `parallel` key (not by a tag —
 * matches the on-disk shape).
 *
 * Implementation lands in Phase 2.
 */
export {};
