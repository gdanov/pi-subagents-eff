/**
 * Pi-adapter runtime construction.
 *
 * Composes all Live layers into a single Layer and creates the
 * ManagedRuntime once at extension-registration time. The host
 * pi.events / pi.commands / pi.api references are captured at that
 * moment so PiEventBusLive and SlashBridgeLive can close over them.
 *
 * Exposes:
 *   - buildRuntime(api): ManagedRuntime
 *   - dispose(runtime): Promise<void> for extension reload
 *
 * Implementation lands when the executor first needs to be invoked
 * (Phase 5).
 */
export {};
