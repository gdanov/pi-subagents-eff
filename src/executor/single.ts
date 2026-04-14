/**
 * Single-agent execution — Effect-native port of execution.ts.
 *
 * The runtime shape of this module:
 *   runSingle(input, options)
 *     -> Effect<SingleResult, PiSpawnError | FsWriteError | ...,
 *               PiSpawner | FileSystem | ArtifactStore | ModelResolver
 *              | SubagentsClock | Scope>
 *
 * High-level flow:
 *   1. Resolve model via ModelResolver (bare-id → provider/id when
 *      unambiguous; preferred provider if set).
 *   2. Build pi args + plan temp-dir side-effects (pi-args.ts).
 *   3. Create tempDir (if needed) + session dir; write prompt/task
 *      files. All via FileSystem service.
 *   4. Resolve spawn command (getPiSpawnCommand).
 *   5. Consume the PiSpawner stream event-by-event, folding into a
 *      mutable-inside-Effect result accumulator (Ref<SingleResult>)
 *      and a progress accumulator (Ref<AgentProgress>).
 *   6. On exit: write artifacts (input, output, jsonl, metadata) via
 *      ArtifactStore, optionally record RunHistory.
 *   7. Return the finalized SingleResult.
 *
 * Intentionally omitted from this MVP — tracked for Phase 5.x / 8:
 *   - Skill injection (systemPrompt pass-through only).
 *   - Model-fallback retry loop (Phase 5.5).
 *   - Intercom-detach race (accept a detachSignal param, no-op when
 *     absent; full wiring in Phase 8 with IntercomBridge).
 *   - Share-to-gist session upload.
 *   - Single-output file writing.
 *
 * The returned SingleResult is strict-compatible with the schema in
 * src/domain/results.ts; callers can encode it via SingleResultSchema
 * for artifact JSON parity.
 */
import * as path from "node:path";
import { Effect, Ref, Stream } from "effect";
import type { AgentProgress, ProgressSummary } from "../domain/progress.ts";
import type {
	ModelAttempt,
	SingleResult,
	Usage,
} from "../domain/results.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../domain/messages.ts";
import { DEFAULT_MAX_OUTPUT } from "../domain/constants.ts";
import { truncateOutput } from "../domain/output.ts";
import { ArtifactStore } from "../services/ArtifactStore.ts";
import { FileSystem } from "../services/FileSystem.ts";
import { ModelResolver, type AvailableModelInfo } from "../services/ModelResolver.ts";
import { PiSpawner, getPiSpawnCommand, type PiEvent } from "../services/PiSpawner.ts";
import { buildPiArgs, piArgsNeedTempDir } from "./pi-args.ts";

// ============================================================================
// Input shape
// ============================================================================

/**
 * Minimal AgentConfig surface this module needs. Accepts anything
 * structurally compatible with the legacy AgentConfig (agents.ts) or
 * the new src/services/AgentDirectory.ts shape.
 */
export interface RunSingleAgent {
	readonly name: string;
	readonly systemPrompt: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly mcpDirectTools?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly skills?: ReadonlyArray<string>;
	readonly fallbackModels?: ReadonlyArray<string>;
}

export interface RunSingleInput {
	readonly agent: RunSingleAgent;
	readonly task: string;
	readonly runId: string;
	/** 0-based index within a parallel/chain batch; surfaces in artifact filenames. */
	readonly index?: number;
}

export interface RunSingleOptions {
	readonly cwd?: string;
	readonly sessionEnabled?: boolean;
	readonly sessionDir?: string;
	readonly sessionFile?: string;
	/** Explicit override; wins over agent.model. */
	readonly modelOverride?: string;
	/** Pi model registry for bare-id → provider/id resolution. */
	readonly availableModels?: ReadonlyArray<AvailableModelInfo>;
	readonly preferredModelProvider?: string;
	/** Streamed partial-result callback; invoked at every onUpdate-worthy event. */
	readonly onUpdate?: (partial: {
		readonly result: SingleResult;
		readonly progress: AgentProgress;
	}) => void;
	/** Environment overrides spliced onto process.env. */
	readonly extraEnv?: Readonly<Record<string, string>>;
	/** Opt-in: write a metadata.json artifact at completion. */
	readonly writeMetadata?: boolean;
	/** Opt-in: write a JSONL event stream artifact. */
	readonly writeJsonl?: boolean;
	/**
	 * Remove the spawn-temp directory after the run. Default true —
	 * matches the legacy cleanupTempDir behavior. Set false in tests
	 * that need to inspect the prompt / task-body files post-run.
	 */
	readonly cleanupTempDir?: boolean;
}

// ============================================================================
// Internal: event folding
// ============================================================================

interface PiJsonEvent {
	readonly type?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
		readonly usage?: {
			readonly input?: number;
			readonly output?: number;
			readonly cacheRead?: number;
			readonly cacheWrite?: number;
			readonly cost?: { readonly total?: number };
		};
		readonly model?: string;
		readonly errorMessage?: string;
	};
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function appendRecentOutput(progress: AgentProgress, lines: ReadonlyArray<string>): AgentProgress {
	if (lines.length === 0) return progress;
	const kept = lines.filter((l) => l.trim().length > 0);
	if (kept.length === 0) return progress;
	const next = [...progress.recentOutput, ...kept];
	const trimmed = next.length > 50 ? next.slice(next.length - 50) : next;
	return { ...progress, recentOutput: trimmed };
}

function safeParseJson(line: string): PiJsonEvent | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as PiJsonEvent;
	} catch {
		// Non-JSON stdout lines are expected; only structured events are parsed.
		return null;
	}
}

// ============================================================================
// runSingle
// ============================================================================

export const runSingle = (
	input: RunSingleInput,
	options: RunSingleOptions = {},
) =>
	Effect.gen(function* () {
		const fsApi = yield* FileSystem;
		const store = yield* ArtifactStore;
		const spawner = yield* PiSpawner;
		const resolver = yield* ModelResolver;

		const startTime = Date.now();
		const cwd = options.cwd ?? process.cwd();

		// ------------------------------------------------------------------
		// Model resolution
		// ------------------------------------------------------------------
		const primary = options.modelOverride ?? input.agent.model;
		const candidates = yield* resolver.buildCandidates({
			primaryModel: primary,
			fallbackModels: input.agent.fallbackModels,
			availableModels: options.availableModels,
			preferredProvider: options.preferredModelProvider,
		});
		const effectiveModel = candidates[0] ?? primary;

		// ------------------------------------------------------------------
		// Build args + plan temp-dir side effects
		// ------------------------------------------------------------------
		const needsTempDir = piArgsNeedTempDir({
			baseArgs: ["--mode", "json", "-p"],
			task: input.task,
			sessionEnabled: options.sessionEnabled ?? true,
			systemPrompt: input.agent.systemPrompt,
		});

		const tempDir = needsTempDir ? yield* fsApi.mkdtemp("pi-subagent-") : "";

		const plan = buildPiArgs(
			{
				baseArgs: ["--mode", "json", "-p"],
				task: input.task,
				sessionEnabled: options.sessionEnabled ?? true,
				sessionDir: options.sessionDir,
				sessionFile: options.sessionFile,
				model: effectiveModel,
				thinking: input.agent.thinking,
				tools: input.agent.tools,
				extensions: input.agent.extensions,
				skills: input.agent.skills,
				systemPrompt: input.agent.systemPrompt || undefined,
				mcpDirectTools: input.agent.mcpDirectTools,
				promptFileStem: input.agent.name,
			},
			tempDir,
		);

		for (const dir of plan.dirsToCreate) yield* fsApi.mkdir(dir);
		for (const fw of plan.fileWrites) {
			yield* fsApi.write(path.join(tempDir, fw.relativePath), fw.contents);
		}

		// ------------------------------------------------------------------
		// Artifact setup
		// ------------------------------------------------------------------
		const artifactsDir = store.resolveDir(options.sessionFile ?? null);
		yield* store.ensureDir(artifactsDir);
		const artifactPaths = store.paths(artifactsDir, input.runId, input.agent.name, input.index);

		yield* store.writeInput(
			artifactPaths.inputPath,
			`# Task\n\n${input.task}\n\n# System Prompt\n\n${input.agent.systemPrompt}`,
		);

		// ------------------------------------------------------------------
		// Accumulator refs
		// ------------------------------------------------------------------
		const resultRef = yield* Ref.make<SingleResult>({
			agent: input.agent.name,
			task: input.task,
			exitCode: 0,
			messages: [],
			usage: emptyUsage(),
			model: effectiveModel,
			attemptedModels: effectiveModel ? [effectiveModel] : undefined,
			modelAttempts: [] as ReadonlyArray<ModelAttempt>,
			artifactPaths,
		});

		const progressRef = yield* Ref.make<AgentProgress>({
			index: input.index ?? 0,
			agent: input.agent.name,
			status: "running",
			task: input.task,
			skills: input.agent.skills ? [...input.agent.skills] : undefined,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
		});

		const stderrBufRef = yield* Ref.make<string>("");
		const jsonlLinesRef = yield* Ref.make<ReadonlyArray<string>>([]);

		const fireUpdate = Effect.gen(function* () {
			if (!options.onUpdate) return;
			const progress = yield* Ref.updateAndGet(progressRef, (p) => ({
				...p,
				durationMs: Date.now() - startTime,
			}));
			const result = yield* Ref.get(resultRef);
			options.onUpdate({ result, progress });
		});

		// ------------------------------------------------------------------
		// Event handler
		// ------------------------------------------------------------------
		const handleEvent = (event: PiEvent): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (event.type === "exit") {
					yield* Ref.update(resultRef, (r) => ({ ...r, exitCode: event.code ?? 0 }));
					return;
				}
				if (event.type === "stderr") {
					yield* Ref.update(stderrBufRef, (s) => s + event.data);
					return;
				}
				// stdout line
				if (options.writeJsonl) {
					yield* Ref.update(jsonlLinesRef, (arr) => [...arr, event.line]);
				}
				const parsed = safeParseJson(event.line);
				if (!parsed) return;

				const now = Date.now();

				if (parsed.type === "tool_execution_start") {
					const toolName = parsed.toolName ?? "";
					const argsPreview = extractToolArgsPreview(
						(parsed.args ?? {}) as Record<string, unknown>,
					);
					yield* Ref.update(progressRef, (p) => ({
						...p,
						toolCount: p.toolCount + 1,
						currentTool: toolName,
						currentToolArgs: argsPreview,
						durationMs: now - startTime,
					}));
					yield* fireUpdate;
					return;
				}

				if (parsed.type === "tool_execution_end") {
					yield* Ref.update(progressRef, (p) => {
						const recentTools = p.currentTool
							? [
									...p.recentTools,
									{
										tool: p.currentTool,
										args: p.currentToolArgs ?? "",
										endMs: now,
									},
								]
							: p.recentTools;
						return {
							...p,
							recentTools,
							currentTool: undefined,
							currentToolArgs: undefined,
							durationMs: now - startTime,
						};
					});
					yield* fireUpdate;
					return;
				}

				if (parsed.type === "message_end" && parsed.message) {
					const msg = parsed.message;
					yield* Ref.update(resultRef, (r) => {
						const uAdd = msg.usage;
						const nextUsage: Usage =
							msg.role === "assistant"
								? {
										input: r.usage.input + (uAdd?.input ?? 0),
										output: r.usage.output + (uAdd?.output ?? 0),
										cacheRead: r.usage.cacheRead + (uAdd?.cacheRead ?? 0),
										cacheWrite: r.usage.cacheWrite + (uAdd?.cacheWrite ?? 0),
										cost: r.usage.cost + (uAdd?.cost?.total ?? 0),
										turns: r.usage.turns + 1,
									}
								: r.usage;
						return {
							...r,
							messages: [...r.messages, msg as unknown],
							usage: nextUsage,
							model: r.model ?? msg.model,
							error: r.error ?? msg.errorMessage,
						};
					});
					if (msg.role === "assistant") {
						const recent = extractTextFromContent(msg.content).split("\n").slice(-10);
						yield* Ref.update(progressRef, (p) => {
							const withOutput = appendRecentOutput(p, recent);
							return {
								...withOutput,
								tokens:
									(withOutput.tokens ?? 0) +
									(msg.usage?.input ?? 0) +
									(msg.usage?.output ?? 0),
								durationMs: now - startTime,
							};
						});
					}
					yield* fireUpdate;
				}
			});

		// ------------------------------------------------------------------
		// Spawn + consume
		// ------------------------------------------------------------------
		const { command, args } = getPiSpawnCommand(plan.args);
		const env = {
			...Object.fromEntries(Object.entries(plan.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
			...(options.extraEnv ?? {}),
		};

		yield* spawner
			.spawnPi({ command, args, cwd, env })
			.pipe(Stream.runForEach(handleEvent));

		// ------------------------------------------------------------------
		// Finalize
		// ------------------------------------------------------------------
		const stderrBuf = yield* Ref.get(stderrBufRef);
		let finalResult = yield* Ref.get(resultRef);
		const finalProgress = yield* Ref.get(progressRef);

		if (finalResult.exitCode !== 0 && stderrBuf.trim() && !finalResult.error) {
			finalResult = { ...finalResult, error: stderrBuf.trim() };
		}

		// getFinalOutput takes a duck-typed MinimalMessage shape; we know
		// the executor always pushes message objects with a role, so
		// cast at the call site.
		const finalOutput = getFinalOutput(
			finalResult.messages as ReadonlyArray<{
				readonly role: string;
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			}>,
		);
		const truncation = truncateOutput(finalOutput, DEFAULT_MAX_OUTPUT, artifactPaths.outputPath);

		yield* store.writeOutput(artifactPaths.outputPath, finalOutput);

		if (options.writeJsonl) {
			const lines = yield* Ref.get(jsonlLinesRef);
			for (const line of lines) yield* store.appendJsonlLine(artifactPaths.jsonlPath, line);
		}

		const progressSummary: ProgressSummary = {
			toolCount: finalProgress.toolCount,
			tokens: finalProgress.tokens,
			durationMs: Date.now() - startTime,
		};

		if (options.writeMetadata) {
			yield* store.writeMetadata(artifactPaths.metadataPath, {
				agent: finalResult.agent,
				task: finalResult.task,
				exitCode: finalResult.exitCode,
				model: finalResult.model,
				usage: finalResult.usage,
				progressSummary,
			});
		}

		// Best-effort tempDir cleanup.
		// Effect.ignore — not catchCause — so interruption still aborts.
		// The tempDir is scoped under os.tmpdir(), so a leaked dir is
		// harmless (the OS cleans eventually). A failed rm is logged
		// by Effect's default runtime logger if a policy is attached
		// but is not treated as a run failure.
		const shouldCleanup = options.cleanupTempDir ?? true;
		if (tempDir && shouldCleanup) {
			yield* Effect.ignore(fsApi.rm(tempDir, { recursive: true, force: true }));
		}

		return {
			...finalResult,
			progressSummary,
			progress: {
				...finalProgress,
				status: finalResult.exitCode === 0 ? ("completed" as const) : ("failed" as const),
				durationMs: Date.now() - startTime,
			},
			finalOutput,
			truncation,
		};
	});
