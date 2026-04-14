/**
 * SessionStore service.
 *
 * Encapsulates session-directory derivation logic from index.ts:53-60
 * (subagentSessionRoot + mkdtemp fallback) and utils.ts session helpers
 * (findLatestSessionFile).
 *
 * Depends on FileSystem.
 */
import { Context, Effect, Layer } from "effect";
import type { FsReadError, FsWriteError } from "../errors.ts";

export interface SessionStoreService {
	readonly subagentSessionRoot: (parentSessionFile: string | null) => Effect.Effect<string, FsWriteError>;
	readonly findLatest: (dir: string) => Effect.Effect<string | undefined, FsReadError>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()("pi-subagents/SessionStore") {}

export const SessionStoreLive = Layer.sync(SessionStore)(() => {
	throw new Error("SessionStore.Live not yet implemented (Phase 3)");
});

export const makeSessionStoreTest = (): Layer.Layer<SessionStore, never, never> =>
	Layer.sync(SessionStore)(() => {
		throw new Error("SessionStore.Test not yet implemented (Phase 3)");
	});
