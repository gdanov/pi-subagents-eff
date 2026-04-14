/**
 * Agent Manager TUI (interactive).
 *
 * Replaces agent-manager.ts and the five companion files
 * (agent-manager-{list,detail,edit,parallel,chain-detail}.ts).
 *
 * Per the plan, this file stays imperative — pi-tui's input loop is
 * deeply callback-driven and wrapping every onKey in Effect.callback
 * roughly doubles LOC for no concurrency benefit. The Effect-side caller
 * uses `Effect.tryPromise(() => showAgentManager(...))` and any service
 * calls inside the dialog (save, load) bridge back via runtime.runPromise.
 *
 * Implementation lands in Phase 9.
 */
export {};
