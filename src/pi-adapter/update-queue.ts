/**
 * onUpdate-callback bridge.
 *
 * The Pi tool framework hands the executor a Promise-returning
 * `onUpdate(result)` callback. Inside Effect, we offer updates to a
 * Queue; a drain fiber takes from the Queue and calls the original
 * callback. Decouples Effect's structured concurrency from Pi's
 * Promise-based UI loop.
 *
 * Implementation lands at Phase 11 (entry swap).
 */
export {};
