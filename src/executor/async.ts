/**
 * Async (background) execution mode — Effect-native port of
 * async-execution.ts (single-mode subset).
 *
 * Phase 7 scope:
 *   - In-process daemon: forks runSingle as a detached fiber and
 *     returns the runId immediately.
 *   - Writes status.json snapshots so AsyncJobTracker's poller can
 *     pick up progress.
 *   - On completion writes a result file to RESULTS_DIR; ResultWatcher
 *     picks it up and publishes subagent:complete.
 *   - Publishes subagent:started at fork time.
 *
 * Out of scope (Phase 10): replacing the in-process daemon with the
 * subagent-runner subprocess. The boundary is a single function call
 * (currently `runSingle`); when Phase 10 lands, this becomes a
 * `PiSpawner.spawnPi` of the runner CLI without touching the
 * surrounding scaffolding.
 *
 * Status.json shape uses the on-disk schema from
 * src/domain/async-state.ts so legacy `pi /subagent_status` callers
 * see the same JSON.
 */
import * as path from "node:path";
import { Effect, Schema } from "effect";
import type { FsWriteError } from "../errors.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../domain/constants.ts";
import { AsyncStatusSchema } from "../domain/async-state.ts";
import { ArtifactStore } from "../services/ArtifactStore.ts";
import { FileSystem } from "../services/FileSystem.ts";
import { ModelResolver } from "../services/ModelResolver.ts";
import { PiEventBus } from "../services/PiEventBus.ts";
import { PiSpawner } from "../services/PiSpawner.ts";
import { runSingle, type RunSingleAgent, type RunSingleOptions } from "./single.ts";

export interface RunAsyncSingleInput {
	readonly agent: RunSingleAgent;
	readonly task: string;
	readonly runId: string;
}

export interface RunAsyncOptions extends RunSingleOptions {
	/**
	 * Override the async runs root (defaults to ASYNC_DIR).
	 * Tests pass a tempdir here.
	 */
	readonly asyncDirRoot?: string;
	/**
	 * Override the results-dir watch root (defaults to RESULTS_DIR).
	 */
	readonly resultsDir?: string;
}

export interface RunAsyncResult {
	readonly runId: string;
	readonly asyncDir: string;
}

const STARTED_CHANNEL = "subagent:started";

/**
 * Fork a single-agent run in the background. Returns immediately with
 * { runId, asyncDir }. The daemon fiber:
 *   1. publishes subagent:started
 *   2. runs runSingle
 *   3. writes the final status.json + a result file picked up by
 *      ResultWatcher
 *
 * The fiber is forked with forkDetach so the calling scope closing
 * (e.g., the tool execute returning) doesn't kill the run. The daemon
 * is responsible for its own cleanup.
 */
export const runAsyncSingle = (
	input: RunAsyncSingleInput,
	options: RunAsyncOptions = {},
): Effect.Effect<
	RunAsyncResult,
	FsWriteError,
	ArtifactStore | FileSystem | ModelResolver | PiEventBus | PiSpawner
> =>
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;
		const bus = yield* PiEventBus;

		const asyncDirRoot = options.asyncDirRoot ?? ASYNC_DIR;
		const resultsDir = options.resultsDir ?? RESULTS_DIR;
		const asyncDir = path.join(asyncDirRoot, input.runId);

		yield* fsApi.mkdir(asyncDir);
		yield* fsApi.mkdir(resultsDir);

		// Initial status.json (state: queued).
		const startedAt = Date.now();
		const initialStatus = yield* Schema.encodeUnknownEffect(AsyncStatusSchema)({
			runId: input.runId,
			mode: "single" as const,
			state: "queued" as const,
			startedAt,
		}).pipe(Effect.orDie);
		yield* fsApi.write(path.join(asyncDir, "status.json"), JSON.stringify(initialStatus, null, 2));

		// Announce: AsyncJobTracker subscribes to this channel.
		yield* bus.publish(STARTED_CHANNEL, {
			id: input.runId,
			asyncDir,
			agent: input.agent.name,
		});

		// Fork the actual run.
		yield* Effect.forkDetach(
			Effect.gen(function* () {
				// Flip status to running before doing work.
				const runningStatus = yield* Schema.encodeUnknownEffect(AsyncStatusSchema)({
					runId: input.runId,
					mode: "single" as const,
					state: "running" as const,
					startedAt,
					lastUpdate: Date.now(),
				}).pipe(Effect.orDie);
				yield* fsApi
					.write(path.join(asyncDir, "status.json"), JSON.stringify(runningStatus, null, 2))
					.pipe(Effect.ignore);

				const exit = yield* Effect.exit(
					runSingle(input, options),
				);

				const success = exit._tag === "Success" && exit.value.exitCode === 0;
				const finalStatus = yield* Schema.encodeUnknownEffect(AsyncStatusSchema)({
					runId: input.runId,
					mode: "single" as const,
					state: success ? ("complete" as const) : ("failed" as const),
					startedAt,
					endedAt: Date.now(),
					lastUpdate: Date.now(),
				}).pipe(Effect.orDie);
				yield* fsApi
					.write(path.join(asyncDir, "status.json"), JSON.stringify(finalStatus, null, 2))
					.pipe(Effect.ignore);

				// Result file: ResultWatcher picks it up and publishes
				// subagent:complete.
				const resultPayload = {
					id: input.runId,
					agent: input.agent.name,
					success,
					timestamp: Date.now(),
					asyncDir,
				};
				yield* fsApi
					.write(
						path.join(resultsDir, `${input.runId}.json`),
						JSON.stringify(resultPayload, null, 2),
					)
					.pipe(Effect.ignore);
			}),
		);

		return { runId: input.runId, asyncDir };
	});
