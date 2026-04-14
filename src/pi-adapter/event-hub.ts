/**
 * Pi events <-> Effect Hub bridge.
 *
 * Lazy `pi.events.on(channel)` registration via Effect.acquireRelease so
 * the listener is removed when the subscribing fiber's scope closes.
 * Emits go straight through `pi.events.emit`.
 *
 * Used by PiEventBusLive (constructed in pi-adapter/runtime.ts).
 *
 * Implementation lands when PiEventBusLive is needed (Phase 7).
 */
export {};
