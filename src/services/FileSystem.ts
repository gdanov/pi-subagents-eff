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
import * as os from "node:os";
import * as path from "node:path";
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
	/** Create a unique temp directory under os.tmpdir(); returns the absolute path. */
	readonly mkdtemp: (prefix: string) => Effect.Effect<string, FsWriteError>;
	readonly rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Effect.Effect<void, FsWriteError>;
	readonly isDirectory: (path: string) => Effect.Effect<boolean, never>;
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

function mkdirEffect(p: string): Effect.Effect<void, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.mkdir(p, { recursive: true }).then(() => undefined),
		catch: (cause) => new FsWriteError({ path: p, cause }),
	});
}

function mkdtempEffect(prefix: string): Effect.Effect<string, FsWriteError> {
	return Effect.tryPromise({
		try: () => fsp.mkdtemp(path.join(os.tmpdir(), prefix)),
		catch: (cause) => new FsWriteError({ path: os.tmpdir(), cause }),
	});
}

function isDirectoryEffect(p: string): Effect.Effect<boolean, never> {
	return Effect.promise(() =>
		fsp.stat(p).then(
			(s) => s.isDirectory(),
			() => false,
		),
	);
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
function watchStreamLive(p: string): Stream.Stream<WatchEvent, FsWatchError> {
	return Stream.callback<WatchEvent, FsWatchError>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const watcher = fs.watch(p, { encoding: "utf-8" }, (eventType, filename) => {
					if (filename === null) return;
					Queue.offerUnsafe(queue, {
						type: eventType === "rename" ? "rename" : "change",
						file: filename,
					});
				});
				watcher.on("error", (err) => {
					Queue.failCauseUnsafe(queue, Cause.fail(new FsWatchError({ path: p, cause: err })));
				});
				// Without this, callers waiting on a take(N)-pipe hang forever
				// when the watched directory disappears (the OS closes the
				// underlying handle but never fires another data event).
				watcher.on("close", () => {
					Queue.endUnsafe(queue);
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
	mkdtemp: mkdtempEffect,
	rm: rmEffect,
	isDirectory: isDirectoryEffect,
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
	const dirs = new Set<string>();
	const watchers = new Map<string, Set<Queue.Queue<WatchEvent, FsWatchError | Cause.Done>>>();
	const encoder = new TextEncoder();
	let mkdtempCounter = 0;

	function ensureParents(p: string): void {
		// Track each path component as a directory so empty-but-created
		// directories are distinguishable from missing ones.
		const parts = p.split("/").filter(Boolean);
		let acc = p.startsWith("/") ? "" : "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = `${acc}/${parts[i]}`;
			dirs.add(acc);
		}
	}

	function setFile(p: string, contents: string | Uint8Array): void {
		const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
		store.set(p, bytes);
		stats.set(p, { mtimeMs: Date.now(), size: bytes.byteLength });
		ensureParents(p);
	}

	for (const [k, v] of Object.entries(initial ?? {})) setFile(k, v);

	function isKnownDirectory(p: string): boolean {
		if (dirs.has(p)) return true;
		// A path is also a directory if any tracked file lives under it.
		const prefix = p.endsWith("/") ? p : `${p}/`;
		for (const k of store.keys()) if (k.startsWith(prefix)) return true;
		for (const d of dirs) if (d.startsWith(prefix)) return true;
		return false;
	}

	const test: FileSystemService = {
		read: (p) => {
			const bytes = store.get(p);
			if (!bytes) return Effect.fail(new FsNotFound({ path: p }));
			return Effect.succeed(new TextDecoder("utf-8").decode(bytes));
		},
		readBytes: (p) => {
			const bytes = store.get(p);
			if (!bytes) return Effect.fail(new FsNotFound({ path: p }));
			return Effect.succeed(bytes);
		},
		write: (p, contents) =>
			Effect.sync(() => {
				setFile(p, contents);
			}),
		append: (p, contents) =>
			Effect.sync(() => {
				const existing = store.get(p);
				const next = existing
					? new Uint8Array([...existing, ...encoder.encode(contents)])
					: encoder.encode(contents);
				setFile(p, next);
			}),
		exists: (p) => Effect.succeed(store.has(p) || isKnownDirectory(p)),
		mkdir: (p) =>
			Effect.sync(() => {
				dirs.add(p);
				ensureParents(`${p}/.keep`);
			}),
		mkdtemp: (prefix) =>
			Effect.sync(() => {
				mkdtempCounter += 1;
				const dir = `/tmp/${prefix}${mkdtempCounter.toString(36).padStart(6, "0")}`;
				dirs.add(dir);
				return dir;
			}),
		rm: (p) =>
			Effect.sync(() => {
				store.delete(p);
				stats.delete(p);
				dirs.delete(p);
				// Drop child entries when removing a directory recursively.
				const prefix = p.endsWith("/") ? p : `${p}/`;
				for (const k of [...store.keys()]) {
					if (k.startsWith(prefix)) {
						store.delete(k);
						stats.delete(k);
					}
				}
				for (const d of [...dirs]) if (d.startsWith(prefix)) dirs.delete(d);
				// Notify watchers that the dir went away.
				const set = watchers.get(p);
				if (set) for (const q of set) Queue.endUnsafe(q);
			}),
		isDirectory: (p) => Effect.succeed(isKnownDirectory(p)),
		readDir: (p) => {
			if (!isKnownDirectory(p)) return Effect.fail(new FsNotFound({ path: p }));
			const prefix = p.endsWith("/") ? p : `${p}/`;
			const fileEntries = [...store.keys()]
				.filter((k) => k.startsWith(prefix))
				.map((k) => k.slice(prefix.length).split("/")[0])
				.filter((v): v is string => v !== undefined && v.length > 0);
			const dirEntries = [...dirs]
				.filter((k) => k.startsWith(prefix) && k !== p)
				.map((k) => k.slice(prefix.length).split("/")[0])
				.filter((v): v is string => v !== undefined && v.length > 0);
			return Effect.succeed([...new Set([...fileEntries, ...dirEntries])]);
		},
		stat: (p) => {
			const s = stats.get(p);
			if (s) return Effect.succeed(s);
			if (isKnownDirectory(p)) return Effect.succeed({ mtimeMs: 0, size: 0 });
			return Effect.fail(new FsNotFound({ path: p }));
		},
		watch: (p) =>
			Stream.callback<WatchEvent, FsWatchError>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const set = watchers.get(p) ?? new Set();
						set.add(queue);
						watchers.set(p, set);
						return queue;
					}),
					(q) =>
						Effect.sync(() => {
							watchers.get(p)?.delete(q);
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
