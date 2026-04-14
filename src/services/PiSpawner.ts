/**
 * PiSpawner service.
 *
 * Owns the `pi` child-process lifecycle. `spawnPi` returns a Scope-owned
 * Stream<PiEvent> — closing the scope sends SIGTERM, then races a 3 s
 * timer against actual exit and follows up with SIGKILL if needed
 * (replaces execution.ts:289-303 + the AbortSignal plumbing at
 * execution.ts:288).
 *
 * Replaces execution.ts:185 (sync runner) and async-execution.ts:124
 * (detached background runner).
 *
 * Live  : node:child_process.spawn + line-splitting JSON event parser.
 * Test  : FakeSpawner returning Stream.fromIterable of scripted events.
 */
import { Context, Effect, Layer, Stream } from "effect";
import type { PiNonZeroExit, PiSpawnError } from "../errors.ts";

/** Raw spawn arguments produced by the legacy pi-spawn.ts/pi-args.ts modules. */
export interface SpawnSpec {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * One JSON event line produced by the pi child process.
 * Kept as `unknown` here; the executor decodes via Schema once shapes are
 * ported in Phase 2.
 */
export type PiEvent = unknown;

export interface SpawnOptions {
	/** When true, the spawned process is detached and the parent unrefs. */
	readonly detached?: boolean;
}

export interface PiSpawnerService {
	readonly spawnPi: (
		spec: SpawnSpec,
		opts?: SpawnOptions,
	) => Stream.Stream<PiEvent, PiSpawnError | PiNonZeroExit>;
}

export class PiSpawner extends Context.Service<PiSpawner, PiSpawnerService>()("pi-subagents/PiSpawner") {}

export const PiSpawnerLive = Layer.sync(PiSpawner)(() => {
	throw new Error("PiSpawner.Live not yet implemented (Phase 4)");
});

export const makePiSpawnerTest = (
	_script?: ReadonlyArray<PiEvent>,
): Layer.Layer<PiSpawner, never, never> =>
	Layer.sync(PiSpawner)(() => {
		throw new Error("PiSpawner.Test not yet implemented (Phase 4)");
	});
