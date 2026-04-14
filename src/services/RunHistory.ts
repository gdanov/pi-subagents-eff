/**
 * RunHistory service.
 *
 * Append-only JSONL log of every subagent run, plus a Stream-based reader.
 * Replaces run-history.ts entirely.
 *
 * Depends on FileSystem + Clock (timestamp).
 */
import { Context, Effect, Layer, Stream } from "effect";
import type { FsWriteError } from "../errors.ts";

export interface HistoryEntry {
	readonly id: string;
	readonly agent: string;
	readonly task: string;
	readonly mode: "single" | "parallel" | "chain" | "management";
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly exitCode: number;
}

export interface RunHistoryService {
	readonly record: (entry: HistoryEntry) => Effect.Effect<void, FsWriteError>;
	readonly list: Stream.Stream<HistoryEntry>;
}

export class RunHistory extends Context.Service<RunHistory, RunHistoryService>()("pi-subagents/RunHistory") {}

export const RunHistoryLive = Layer.sync(RunHistory)(() => {
	throw new Error("RunHistory.Live not yet implemented (Phase 3)");
});

export const makeRunHistoryTest = (): Layer.Layer<RunHistory, never, never> =>
	Layer.sync(RunHistory)(() => {
		throw new Error("RunHistory.Test not yet implemented (Phase 3)");
	});
