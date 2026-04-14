/**
 * SessionStore service.
 *
 * Two responsibilities:
 *
 *   1. `subagentSessionRoot(parentSessionFile)` — derive the per-session
 *      subagent base directory. Mirrors index.ts:53-60. If the parent
 *      has a session file, the subagent root is `{sessionsDir}/{baseName}/`;
 *      otherwise it falls back to a fresh mkdtemp.
 *
 *   2. `findLatest(sessionDir)` — find the most recently modified
 *      `*.jsonl` session file in a directory. Mirrors utils.ts:159.
 *
 * Both depend on FileSystem (mkdtemp goes through a small helper since
 * FileSystem doesn't currently expose `mkdtemp`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { FsReadError, FsWriteError } from "../errors.ts";
import { FileSystem } from "./FileSystem.ts";
import { FsWriteError as FsWriteErrorClass } from "../errors.ts";

export interface SessionStoreService {
	readonly subagentSessionRoot: (parentSessionFile: string | null) => Effect.Effect<string, FsWriteError>;
	readonly findLatest: (sessionDir: string) => Effect.Effect<string | undefined, FsReadError>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()(
	"pi-subagents/SessionStore",
) {}

// ============================================================================
// Live
// ============================================================================

export const SessionStoreLive = Layer.effect(SessionStore)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;

		const subagentSessionRoot = (parentSessionFile: string | null) =>
			Effect.gen(function* () {
				if (parentSessionFile) {
					const baseName = path.basename(parentSessionFile, ".jsonl");
					const sessionsDir = path.dirname(parentSessionFile);
					return path.join(sessionsDir, baseName);
				}
				// mkdtemp isn't on FileSystem (Node-specific, sync-only).
				// Wrap directly here; callers see it as part of SessionStore.
				return yield* Effect.try({
					try: () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-")),
					catch: (cause) =>
						new FsWriteErrorClass({ path: os.tmpdir(), cause }),
				});
			});

		const findLatest = (sessionDir: string) =>
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(sessionDir);
				if (!exists) return undefined;

				const entries = yield* fsApi.readDir(sessionDir).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
				);
				const candidates = entries.filter((f) => f.endsWith(".jsonl"));
				if (candidates.length === 0) return undefined;

				const stats = yield* Effect.all(
					candidates.map((file) =>
						Effect.gen(function* () {
							const full = path.join(sessionDir, file);
							const stat = yield* fsApi.stat(full).pipe(
								Effect.catchTag("FsNotFound", () => Effect.succeed({ mtimeMs: 0, size: 0 })),
							);
							return { path: full, mtime: stat.mtimeMs };
						}),
					),
				);
				const sorted = [...stats].sort((a, b) => b.mtime - a.mtime);
				return sorted[0]?.path;
			});

		return SessionStore.of({ subagentSessionRoot, findLatest });
	}),
);

export const SessionStoreTest: Layer.Layer<SessionStore, never, FileSystem> = SessionStoreLive;
