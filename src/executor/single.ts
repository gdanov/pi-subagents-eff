/**
 * Single-agent execution mode.
 *
 * Replaces execution.ts. Consumes PiSpawner.spawnPi as a Stream<PiEvent>,
 * folds the events into a SingleResult, writes artifacts via ArtifactStore,
 * and surfaces failures as tagged errors instead of the legacy exit-code
 * sentinel scheme.
 *
 * Implementation lands in Phase 5.
 */
export {};
