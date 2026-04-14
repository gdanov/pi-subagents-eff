/**
 * FileSystem service.
 *
 * Two layers in this file:
 *   - FileSystemLive  : node:fs/promises wrapper. Maps ENOENT to
 *                       FsNotFound; everything else to FsReadError /
 *                       FsWriteError / FsWatchError. `watch` is a
 *                       Stream.callback wrapping a node fs.FSWatcher;
 *                       Scope close stops the watcher.
 *   - makeFileSystemTest({ files }) : in-memory map. `watch` is backed
 *                       by a Queue that the test driver can offer
 *                       synthetic events into via the returned helpers.
 *
 * The Test layer's helpers are exposed alongside the Layer so unit
 * tests can drive watchers deterministically without sleeping.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect";
import { FsNotFound, FsReadError, FsWatchError, FsWriteError } from "../errors.ts";

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
	readonly stat: (
		path: string,
	) => Effect.Effect<{ readonly mtimeMs: number; readonly size: number }, FsReadError | FsNotFound>;
	readonly watch: (path: string) => Stream.Stream<WatchEvent, FsWatchError>;
}

export class FileSystem extends Context.Service<FileSystem, FileSystemService>()("pi-subagents/FileSystem") {}

// ============================================================================
// Live
// ============================================================================

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function readEffect(path: string): Effect.Effect<string, FsReadError | FsNotFound> {
	return Effect.tryPromise({
		try: () => fsp.readFile(path, "utf-8"),
		catch: (cause) => (isEnoent(cause) ? new FsNotFound({ path }) : new FsReadError({ path, cause })),
	});
}

function readBytesEffect(path: string): Effect.Effect<Uint8Array, FsReadError | FsNotFound> {
	return Effect.tryPromise({
		try: () => fsp.readFile(path).then((b) => new Uint8Array(b)),
		catch: (cause) => (isEnoent(cause) ? new FsNotFound({ path }) : new FsReadError({ path, cause })),
	});
}

function writeEffect(path: string, contents: string | Uint8Array): Effect.Effect<void, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.writeFile(path, contents),
		catch: (cause) => new FsWriteError({ path, cause }),
	});
}

function appendEffect(path: string, contents: string): Effect.Effect<void, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.appendFile(path, contents),
		catch: (cause) => new FsWriteError({ path, cause }),
	});
}

function existsEffect(path: string): Effect.Effect<boolean, never> {
	return Effect.promise(() => fsp.access(path).then(() => true, () => false));
}

function mkdirEffect(path: string): Effect.Effect<void, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.mkdir(path, { recursive: true }).then(() => undefined),
		catch: (cause) => new FsWriteError({ path, cause }),
	});
}

function rmEffect(path: string, opts?: { recursive?: boolean; force?: boolean }): Effect.Effect<void, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.rm(path, { recursive: opts?.recursive ?? false, force: opts?.force ?? false }),
		catch: (cause) => new FsWriteError({ path, cause }),
	});
}

function readDirEffect(path: string): Effect.Effect<ReadonlyArray<string>, FsReadError | FsNotFound> {
	return Effect.tryPromise({
		try: () => fsp.readdir(path),
		catch: (cause) => (isEnoent(cause) ? new FsNotFound({ path }) : new FsReadError({ path, cause })),
	});
}

function statEffect(
	path: string,
): Effect.Effect<{ readonly mtimeMs: number; readonly size: number }, FsReadError | FsNotFound> {
	return Effect.tryPromise({
		try: () => fsp.stat(path).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size })),
		catch: (cause) => (isEnoent(cause) ? new FsNotFound({ path }) : new FsReadError({ path, cause })),
	});
}

/**
 * Live `watch`: opens a node fs.FSWatcher inside Stream.callback's
 * scope and forwards each (eventType, filename) event into the queue.
 * On scope close (caller cancellation, error, or completion) the
 * watcher is closed.
 *
 * Errors from the underlying watcher (e.g., the watched directory was
 * deleted) end the stream with an FsWatchError so the caller's retry
 * schedule can decide whether to restart.
 */
function watchStreamLive(path: string): Stream.Stream<WatchEvent, FsWatchError> {
	return Stream.callback<WatchEvent, FsWatchError>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const watcher = fs.watch(path, { encoding: "utf-8" }, (eventType, filename) => {
					if (filename === null) return;
					Queue.offerUnsafe(queue, {
						type: eventType === "rename" ? "rename" : "change",
						file: filename,
					});
				});
				watcher.on("error", (err) => {
					Queue.failCauseUnsafe(queue, Cause.fail(new FsWatchError({ path, cause: err })));
				});
				return watcher;
			}),
			(watcher) => Effect.sync(() => watcher.close()),
		),
	);
}

const liveService: FileSystemService = {
	read: readEffect,
	readBytes: readBytesEffect,
	write: writeEffect,
	append: appendEffect,
	exists: existsEffect,
	mkdir: mkdirEffect,
	rm: rmEffect,
	readDir: readDirEffect,
	stat: statEffect,
	watch: watchStreamLive,
};

export const FileSystemLive = Layer.succeed(FileSystem)(FileSystem.of(liveService));

// ============================================================================
// Test
// ============================================================================

/** Helper handle returned alongside the Test layer for in-test driving. */
export interface FileSystemTestControls {
	readonly emit: (path: string, ev: WatchEvent) => void;
	readonly endWatch: (path: string) => void;
	readonly listFiles: () => ReadonlyArray<string>;
	readonly getFile: (path: string) => string | undefined;
}

export interface FileSystemTestBuild {
	readonly layer: Layer.Layer<FileSystem, never, never>;
	readonly controls: FileSystemTestControls;
}

/**
 * Build a Test layer over an in-memory filesystem.
 *
 * `files` seeds the initial state. The returned `controls` object lets
 * tests inspect/mutate the in-memory store and push synthetic watch
 * events into any subscriber's queue.
 */
export function makeFileSystemTest(
	initial?: Readonly<Record<string, string | Uint8Array>>,
): FileSystemTestBuild {
	const store = new Map<string, Uint8Array>();
	const stats = new Map<string, { mtimeMs: number; size: number }>();
	const watchers = new Map<string, Set<Queue.Queue<WatchEvent, FsWatchError | Cause.Done>>>();
	const encoder = new TextEncoder();

	function setFile(path: string, contents: string | Uint8Array): void {
		const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
		store.set(path, bytes);
		stats.set(path, { mtimeMs: Date.now(), size: bytes.byteLength });
	}

	for (const [k, v] of Object.entries(initial ?? {})) setFile(k, v);

	const test: FileSystemService = {
		read: (path) => {
			const bytes = store.get(path);
			if (!bytes) return Effect.fail(new FsNotFound({ path }));
			return Effect.succeed(new TextDecoder("utf-8").decode(bytes));
		},
		readBytes: (path) => {
			const bytes = store.get(path);
			if (!bytes) return Effect.fail(new FsNotFound({ path }));
			return Effect.succeed(bytes);
		},
		write: (path, contents) =>
			Effect.sync(() => {
				setFile(path, contents);
			}),
		append: (path, contents) =>
			Effect.sync(() => {
				const existing = store.get(path);
				const next = existing
					? new Uint8Array([...existing, ...encoder.encode(contents)])
					: encoder.encode(contents);
				setFile(path, next);
			}),
		exists: (p) => {
			if (store.has(p)) return Effect.succeed(true);
			// A directory "exists" if any tracked file lives under it.
			const prefix = p.endsWith("/") ? p : `${p}/`;
			for (const k of store.keys()) if (k.startsWith(prefix)) return Effect.succeed(true);
			return Effect.succeed(false);
		},
		mkdir: (_path) => Effect.void,
		rm: (path) =>
			Effect.sync(() => {
				store.delete(path);
				stats.delete(path);
			}),
		readDir: (path) => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const entries = [...store.keys()]
				.filter((k) => k.startsWith(prefix))
				.map((k) => k.slice(prefix.length).split("/")[0])
				.filter((v): v is string => v !== undefined);
			const unique = [...new Set(entries)];
			if (unique.length === 0 && !store.has(path)) {
				// empty directory is fine, but a fully missing path returns FsNotFound
				const anyPrefix = [...store.keys()].some((k) => k.startsWith(prefix));
				if (!anyPrefix) return Effect.fail(new FsNotFound({ path }));
			}
			return Effect.succeed(unique);
		},
		stat: (path) => {
			const s = stats.get(path);
			if (!s) return Effect.fail(new FsNotFound({ path }));
			return Effect.succeed(s);
		},
		watch: (path) =>
			Stream.callback<WatchEvent, FsWatchError>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const set = watchers.get(path) ?? new Set();
						set.add(queue);
						watchers.set(path, set);
						return queue;
					}),
					(q) =>
						Effect.sync(() => {
							watchers.get(path)?.delete(q);
						}),
				),
			),
	};

	const controls: FileSystemTestControls = {
		emit: (path, ev) => {
			const set = watchers.get(path);
			if (!set) return;
			for (const q of set) Queue.offerUnsafe(q, ev);
		},
		endWatch: (path) => {
			const set = watchers.get(path);
			if (!set) return;
			for (const q of set) Queue.endUnsafe(q);
		},
		listFiles: () => [...store.keys()],
		getFile: (path) => {
			const bytes = store.get(path);
			return bytes ? new TextDecoder("utf-8").decode(bytes) : undefined;
		},
	};

	return {
		layer: Layer.succeed(FileSystem)(FileSystem.of(test)),
		controls,
	};
}
