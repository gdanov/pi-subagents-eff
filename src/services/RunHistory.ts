/**
 * RunHistory service.
 *
 * Append-only JSONL record of every subagent run. Replaces run-history.ts
 * with two behavioral upgrades:
 *
 *   - `record` is an Effect; failures surface as FsWriteError instead of
 *     being silently swallowed (the legacy code's try/catch was rationalized
 *     by "never crash the execution flow for history recording" — we keep
 *     that contract by having callers use Effect.catchAll/Effect.ignore at
 *     the call site rather than burying the swallow inside the service).
 *   - `list` and `loadForAgent` return `Effect`s rather than synchronous
 *     reads; rotation is still applied on read but is also explicit.
 *
 * Depends on FileSystem.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { FsReadError, FsWriteError } from "../errors.ts";
import { FileSystem } from "./FileSystem.ts";

export const HISTORY_PATH = path.join(os.homedir(), ".pi", "agent", "run-history.jsonl");
const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

export interface RunEntry {
	readonly agent: string;
	readonly task: string;
	readonly ts: number;
	readonly status: "ok" | "error";
	readonly duration: number;
	readonly exit?: number;
}

export interface RunHistoryService {
	readonly record: (input: {
		readonly agent: string;
		readonly task: string;
		readonly exitCode: number;
		readonly durationMs: number;
	}) => Effect.Effect<void, FsWriteError>;
	readonly listAll: Effect.Effect<ReadonlyArray<RunEntry>, FsReadError>;
	readonly loadForAgent: (agent: string) => Effect.Effect<ReadonlyArray<RunEntry>, FsReadError>;
}

export class RunHistory extends Context.Service<RunHistory, RunHistoryService>()(
	"pi-subagents/RunHistory",
) {}

// ============================================================================
// Live
// ============================================================================

export const RunHistoryLive = Layer.effect(RunHistory)(
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;

		const record = (input: {
			readonly agent: string;
			readonly task: string;
			readonly exitCode: number;
			readonly durationMs: number;
		}) =>
			Effect.gen(function* () {
				const entry: RunEntry = {
					agent: input.agent,
					task: input.task.slice(0, 200),
					ts: Math.floor(Date.now() / 1000),
					status: input.exitCode === 0 ? "ok" : "error",
					duration: input.durationMs,
					...(input.exitCode !== 0 ? { exit: input.exitCode } : {}),
				};
				yield* fsApi.mkdir(path.dirname(HISTORY_PATH));
				yield* fsApi.append(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
			});

		const readAndMaybeRotate: Effect.Effect<ReadonlyArray<RunEntry>, FsReadError> =
			Effect.gen(function* () {
				const exists = yield* fsApi.exists(HISTORY_PATH);
				if (!exists) return [] as ReadonlyArray<RunEntry>;

				const raw = yield* fsApi.read(HISTORY_PATH).pipe(
					Effect.catchTag("FsNotFound", () => Effect.succeed("")),
				);
				const allLines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
				const lines = allLines.length > ROTATE_READ_THRESHOLD ? allLines.slice(-ROTATE_KEEP) : allLines;

				if (lines.length !== allLines.length) {
					// Best-effort rewrite — if rotation fails the next read still
					// works (just keeps re-reading the long file).
					yield* fsApi
						.write(HISTORY_PATH, `${lines.join("\n")}\n`)
						.pipe(Effect.catchTag("FsWriteError", () => Effect.void));
				}

				// Skip malformed lines (matches legacy behavior). Done via
				// Effect.try + .pipe(Effect.option) so a single bad JSON
				// line is filtered out rather than aborting the whole read.
				const parsedOptions = yield* Effect.all(
					lines.map((line) =>
						Effect.try({
							try: () => JSON.parse(line) as RunEntry,
							catch: () => null,
						}).pipe(Effect.option),
					),
				);
				const parsed: RunEntry[] = [];
				for (const opt of parsedOptions) {
					if (opt._tag === "Some" && opt.value !== null) parsed.push(opt.value);
				}
				return parsed;
			});

		return RunHistory.of({
			record,
			listAll: readAndMaybeRotate,
			loadForAgent: (agent) =>
				readAndMaybeRotate.pipe(
					Effect.map((entries) => entries.filter((e) => e.agent === agent).reverse()),
				),
		});
	}),
);

export const RunHistoryTest: Layer.Layer<RunHistory, never, FileSystem> = RunHistoryLive;
