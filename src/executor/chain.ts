/**
 * Chain execution mode.
 *
 * Replaces chain-execution.ts + chain-serializer.ts. Uses Effect.reduce
 * over the step array, threading {previous} from one step into the next.
 * Parallel substeps inside a chain step share the same Effect.all
 * concurrency primitive used by executor/parallel.ts.
 *
 * Template resolution ({task}/{previous}/{chain_dir}) lives here as a
 * pure helper; failures surface as ChainTemplateError / ChainStepFailed.
 *
 * Implementation lands in Phase 6.
 */
export {};
