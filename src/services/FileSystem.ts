/**
 * FileSystem service.
 *
 * Absorbs every fs.* call site in the legacy code (artifacts.ts, settings.ts,
 * agents.ts, run-history.ts, result-watcher.ts, single-output.ts, etc.).
 *
 * `watch(dir)` returns a Scope-owned Stream of raw fs.watch events; the
 * ResultWatcher service composes this with debouncing and filtering.
 *
 * Live  : node:fs / node:fs/promises wrapper.
 * Test  : in-memory Map<path, Buffer> with a manual emitter for `watch`.
 *
 * NOTE: this stub only declares the tag and an empty Live layer. Methods
 * are added as porting phases need them (Phase 3).
 */
import { Context, Effect, Layer, Stream } from "effect";
import type { FsNotFound, FsReadError, FsWatchError, FsWriteError } from "../errors.ts";

export interface WatchEvent {
	readonly type: "rename" | "change";
	readonly file: string;
}

export interface FileSystemService {
	readonly read: (path: string) => Effect.Effect<string, FsReadError | FsNotFound>;
	readonly readBytes: (path: string) => Effect.Effect<Uint8Array, FsReadError | FsNotFound>;
	readonly write: (path: string, contents: string | Uint8Array) => Effect.Effect<void, FsWriteError>;
	readonly append: (path: string, contents: string) => Effect.Effect<void, FsWriteError>;
	readonly exists: (path: string) => Effect.Effect<boolean, never>;
	readonly mkdir: (path: string) => Effect.Effect<void, FsWriteError>;
	readonly rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Effect.Effect<void, FsWriteError>;
	readonly readDir: (path: string) => Effect.Effect<ReadonlyArray<string>, FsReadError | FsNotFound>;
	readonly stat: (path: string) => Effect.Effect<{ readonly mtimeMs: number; readonly size: number }, FsReadError | FsNotFound>;
	readonly watch: (path: string) => Stream.Stream<WatchEvent, FsWatchError>;
}

export class FileSystem extends Context.Service<FileSystem, FileSystemService>()("pi-subagents/FileSystem") {}

/** Live layer — populated in Phase 3. */
export const FileSystemLive = Layer.sync(FileSystem)(() => {
	throw new Error("FileSystem.Live not yet implemented (Phase 3)");
});

/** Test layer fixture-builder — populated in Phase 3. */
export const makeFileSystemTest = (
	_initial?: Readonly<Record<string, string | Uint8Array>>,
): Layer.Layer<FileSystem, never, never> =>
	Layer.sync(FileSystem)(() => {
		throw new Error("FileSystem.Test not yet implemented (Phase 3)");
	});
