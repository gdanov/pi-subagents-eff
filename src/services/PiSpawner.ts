/**
 * PiSpawner service.
 *
 * Owns the lifecycle of a spawned `pi` child process. `spawnPi` returns
 * a Scope-owned Stream of `PiEvent`s; when the surrounding scope closes
 * (caller interruption, error, or happy-path completion), the child is
 * signaled SIGTERM and, if it hasn't exited within 3 s, SIGKILL'd.
 *
 * Replaces:
 *   - execution.ts:185 (the synchronous runner's spawn + stdout loop)
 *   - async-execution.ts:124 (the detached background runner's spawn)
 *   - pi-spawn.ts (command resolution — ported as pure helpers alongside
 *     the service)
 *
 * Event shape is intentionally small: one `stdout` event per line,
 * `stderr` events as raw chunks (the legacy code only aggregates
 * stderr on failure), and a final `exit` event with the code + signal.
 * JSON parsing moves into `executor/single.ts` (Phase 5) which consumes
 * this stream — keeping PiSpawner event-agnostic means the same stream
 * can back the sync single-mode runner AND the subagent-runner
 * subprocess (Phase 10).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect";
import { PiSpawnError } from "../errors.ts";

// ============================================================================
// Pure helpers — ported from pi-spawn.ts
// ============================================================================

const require = createRequire(import.meta.url);

export interface PiSpawnDeps {
	readonly platform?: NodeJS.Platform;
	readonly execPath?: string;
	readonly argv1?: string;
	readonly existsSync?: (filePath: string) => boolean;
	readonly readFileSync?: (filePath: string, encoding: "utf-8") => string;
	readonly resolvePackageJson?: () => string;
	readonly piPackageRoot?: string;
}

export interface PiSpawnCommand {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
}

export function resolvePiPackageRoot(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	// Intentionally a single try/catch: this function is called during
	// spawn-command resolution where every fs call might throw and
	// none of the failures are actionable; falling back to the bare
	// "pi" command handles every failure mode uniformly.
	try {
		let dir = path.dirname(fs.realpathSync(entry));
		while (dir !== path.dirname(dir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
				if (pkg.name === "@mariozechner/pi-coding-agent") return dir;
			} catch {
				// Walk up; some dirs won't have a package.json.
			}
			dir = path.dirname(dir);
		}
	} catch {
		// realpath can throw on broken symlinks; fall through.
	}
	return undefined;
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync =
		deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) return argvPath;
	}

	try {
		const resolvePackageJson =
			deps.resolvePackageJson ??
			(() => {
				const root = deps.piPackageRoot ?? resolvePiPackageRoot();
				if (root) return path.join(root, "package.json");
				return require.resolve("@mariozechner/pi-coding-agent/package.json");
			});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath =
			typeof binField === "string" ? binField : (binField?.pi ?? Object.values(binField ?? {})[0]);
		if (!binPath) return undefined;
		const candidate = normalizePath(path.resolve(path.dirname(packageJsonPath), binPath));
		if (isRunnableNodeScript(candidate, existsSync)) return candidate;
	} catch {
		return undefined;
	}
	return undefined;
}

export function getPiSpawnCommand(args: ReadonlyArray<string>, deps: PiSpawnDeps = {}): PiSpawnCommand {
	const piCliPath = resolveWindowsPiCliScript(deps);
	if (piCliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [piCliPath, ...args],
		};
	}
	return { command: "pi", args };
}

// ============================================================================
// Stream event shape
// ============================================================================

export type PiEvent =
	| { readonly type: "stdout"; readonly line: string }
	| { readonly type: "stderr"; readonly data: string }
	| { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null };

export interface SpawnSpec {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnOptions {
	/**
	 * When true, detaches the child so the parent can exit first (used by
	 * async-execution for background runs). Stream ends immediately after
	 * the child is unref'd; no `exit` event is emitted.
	 */
	readonly detached?: boolean;
	/**
	 * When true, the Live implementation unrefs the spawned child and
	 * terminates the stream with `Queue.endUnsafe` right away (detached
	 * mode). Consumer keeps the pid via the scope-close callback.
	 */
	readonly ignoreStdio?: boolean;
}

export interface PiSpawnerService {
	readonly spawnPi: (
		spec: SpawnSpec,
		opts?: SpawnOptions,
	) => Stream.Stream<PiEvent, PiSpawnError>;
}

export class PiSpawner extends Context.Service<PiSpawner, PiSpawnerService>()(
	"pi-subagents/PiSpawner",
) {}

// ============================================================================
// Live
// ============================================================================

const SIGTERM_GRACE_MS = 3000;

function buildLiveStream(spec: SpawnSpec, opts?: SpawnOptions): Stream.Stream<PiEvent, PiSpawnError> {
	return Stream.callback<PiEvent, PiSpawnError>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const child = spawn(spec.command, [...spec.args], {
					cwd: spec.cwd,
					env: spec.env ? { ...process.env, ...spec.env } : process.env,
					stdio: opts?.ignoreStdio ? "ignore" : ["ignore", "pipe", "pipe"],
					detached: opts?.detached ?? false,
				});

				if (opts?.detached) child.unref();
				if (opts?.ignoreStdio) {
					// Nothing more to stream; signal completion so Stream.take
					// callers unblock immediately.
					Queue.endUnsafe(queue);
					return child;
				}

				let stdoutBuf = "";
				child.stdout?.on("data", (d: Buffer) => {
					stdoutBuf += d.toString("utf-8");
					const lines = stdoutBuf.split("\n");
					stdoutBuf = lines.pop() ?? "";
					for (const line of lines) {
						Queue.offerUnsafe(queue, { type: "stdout", line });
					}
				});
				child.stderr?.on("data", (d: Buffer) => {
					Queue.offerUnsafe(queue, { type: "stderr", data: d.toString("utf-8") });
				});
				child.on("error", (err) => {
					Queue.failCauseUnsafe(
						queue,
						Cause.fail(
							new PiSpawnError({ command: spec.command, args: [...spec.args], cause: err }),
						),
					);
				});
				child.on("close", (code, signal) => {
					// Flush any tail line without a trailing newline.
					if (stdoutBuf.length > 0) {
						Queue.offerUnsafe(queue, { type: "stdout", line: stdoutBuf });
						stdoutBuf = "";
					}
					Queue.offerUnsafe(queue, { type: "exit", code, signal });
					Queue.endUnsafe(queue);
				});

				return child;
			}),
			(child) => releaseChild(child),
		),
	);
}

function releaseChild(child: ChildProcess): Effect.Effect<void> {
	return Effect.sync(() => {
		// Already exited — nothing to do.
		if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
		child.kill("SIGTERM");
		// SIGKILL escalation after 3 s.
		//
		// `.unref()` is load-bearing: without it a cooperating child
		// that SIGTERMs cleanly within 3 s still has the escalation
		// timer sitting in the Node event loop, which can delay
		// process shutdown by up to SIGTERM_GRACE_MS. With .unref()
		// the timer no longer blocks the event loop — DO NOT REMOVE.
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null && !child.killed) {
				child.kill("SIGKILL");
			}
		}, SIGTERM_GRACE_MS).unref();
	});
}

export const PiSpawnerLive = Layer.succeed(PiSpawner)(
	PiSpawner.of({ spawnPi: buildLiveStream }),
);

// ============================================================================
// Test
// ============================================================================

/**
 * Script-driven Test layer: each `spawnPi` call returns the next
 * scripted event list in order. If the script is exhausted, subsequent
 * calls fail with PiSpawnError.
 */
export interface FakeSpawnScript {
	readonly spec?: (actual: SpawnSpec) => void;
	readonly events: ReadonlyArray<PiEvent>;
}

export interface PiSpawnerTestBuild {
	readonly layer: Layer.Layer<PiSpawner, never, never>;
	readonly controls: {
		readonly spawnCount: () => number;
		readonly lastSpec: () => SpawnSpec | undefined;
	};
}

export function makePiSpawnerTest(scripts: ReadonlyArray<FakeSpawnScript>): PiSpawnerTestBuild {
	let i = 0;
	let lastSpec: SpawnSpec | undefined;

	const spawnPi = (spec: SpawnSpec): Stream.Stream<PiEvent, PiSpawnError> => {
		lastSpec = spec;
		const script = scripts[i++];
		if (!script) {
			return Stream.fail(
				new PiSpawnError({ command: spec.command, args: [...spec.args], cause: "test: script exhausted" }),
			);
		}
		script.spec?.(spec);
		return Stream.fromIterable(script.events);
	};

	return {
		layer: Layer.succeed(PiSpawner)(PiSpawner.of({ spawnPi })),
		controls: {
			spawnCount: () => i,
			lastSpec: () => lastSpec,
		},
	};
}
