/**
 * Background-runner entry point (separate process).
 *
 * Replaces subagent-runner.ts. Invoked via:
 *   spawn(process.execPath, ["--experimental-strip-types",
 *     "<plugin>/src/runner/main.ts", "<config-path>"])
 *
 * CRITICAL: this process has NO parent pi.events bus. Its ManagedRuntime
 * must compose only the file-based services (FileSystem, ArtifactStore,
 * RunHistory, PiSpawner, SessionStore, ModelResolver, AgentDirectory,
 * ConfigReader, Clock). It must NOT include PiEventBusLive or NotifierLive.
 *
 * Implementation lands in Phase 10.
 */
export {};
