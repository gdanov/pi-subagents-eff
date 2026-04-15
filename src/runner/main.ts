/**
 * Background-runner entry point (separate process).
 *
 * Replaces subagent-runner.ts. Invoked via:
 *   spawn(process.execPath, ["--experimental-strip-types",
 *     "<plugin>/src/runner/main.ts", "<config-path>"])
 *
 * CRITICAL: this process has NO parent pi.events bus. Its runtime
 * must compose only the file-based services (FileSystem, ArtifactStore,
 * RunHistory, PiSpawner, SessionStore, ModelResolver, AgentDirectory,
 * ConfigReader, Clock). It must NOT include PiEventBusLive or NotifierLive.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../domain/messages.ts";
import { DEFAULT_MAX_OUTPUT } from "../domain/constants.ts";
import type { Usage } from "../domain/results.ts";
import { ArtifactStore } from "../services/ArtifactStore.ts";
import { FileSystem } from "../services/FileSystem.ts";
import { ModelResolver } from "../services/ModelResolver.ts";
import { getPiSpawnCommand } from "../services/PiSpawner.ts";
import { SubagentsClock } from "../services/Clock.ts";
import { buildPiArgs, piArgsNeedTempDir } from "../executor/pi-args.ts";

// ============================================================================
// Config types — wire-compatible with subagent-runner.ts
// ============================================================================

export interface SubagentStepConfig {
	readonly agent: string;
	readonly task: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly modelCandidates?: ReadonlyArray<string>;
	readonly skills?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly tools?: ReadonlyArray<string>;
	readonly mcpDirectTools?: ReadonlyArray<string>;
	readonly systemPrompt?: string;
	readonly sessionFile?: string;
	readonly outputPath?: string;
	readonly maxSubagentDepth?: number;
}

export interface SubagentParallelGroup {
	readonly parallel: ReadonlyArray<SubagentStepConfig>;
	readonly concurrency?: number;
	readonly failFast?: boolean;
	readonly worktree?: boolean;
}

export type RunnerStep = SubagentStepConfig | SubagentParallelGroup;

export interface SubagentRunConfig {
	readonly id: string;
	readonly steps: ReadonlyArray<RunnerStep>;
	readonly resultPath: string;
	readonly cwd: string;
	readonly placeholder: string;
	readonly taskIndex?: number;
	readonly totalTasks?: number;
	readonly maxOutputBytes?: number;
	readonly maxOutputLines?: number;
	readonly artifactsDir?: string;
	readonly share?: boolean;
	readonly sessionDir?: string;
	readonly asyncDir: string;
	readonly sessionId?: string | null;
	readonly piPackageRoot?: string;
	readonly piArgv1?: string;
	readonly worktreeSetupHook?: string;
	readonly worktreeSetupHookTimeoutMs?: number;
}

// ============================================================================
// Result shape
// ============================================================================

interface StepResult {
	readonly agent: string;
	readonly output: string;
	readonly exitCode: number | null;
	readonly error?: string;
	readonly model?: string;
	readonly attemptedModels?: ReadonlyArray<string>;
}

interface ResultWithSuccess extends StepResult {
	readonly success: boolean;
}

interface RunResult {
	readonly id: string;
	readonly agent: string;
	readonly success: boolean;
	readonly summary: string;
	readonly results: ReadonlyArray<{
		readonly agent: string;
		readonly output: string;
		readonly success: boolean;
		readonly skipped?: boolean;
		readonly model?: string;
		readonly attemptedModels?: ReadonlyArray<string>;
	}>;
	readonly exitCode: number;
	readonly timestamp: number;
	readonly durationMs: number;
	readonly truncated: boolean;
	readonly artifactsDir?: string;
	readonly cwd: string;
	readonly asyncDir: string;
	readonly sessionId?: string | null;
	readonly sessionFile?: string;
}

// ============================================================================
// Pure helpers
// ============================================================================

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	if (!maxDepth) return {};
	return { PI_SUBAGENT_MAX_DEPTH: String(maxDepth) };
}

function isRetryableFailure(error?: string): boolean {
	if (!error) return false;
	const nonRetryable = [
		"context_length",
		"invalid_request",
		"authentication",
		"rate_limit",
		"overloaded",
		"model_not_found",
		"api_key",
	];
	return !nonRetryable.some((m) => (error as string).toLowerCase().includes(m));
}

function detectSubagentError(
	messages: Array<{ readonly role?: string; readonly content?: unknown }>,
): { hasError: boolean; errorType?: string; details?: string } {
	for (const msg of messages) {
		if (msg.role === "system" && msg.content) {
			const content = msg.content as Array<{ readonly type?: string; readonly text?: string }>;
			for (const block of content) {
				if (block.type === "text") {
					const text = block.text as string | undefined;
					if (text?.includes("SUBAGENT_ERROR:")) {
						const match = text.match(/SUBAGENT_ERROR:(\w+)(?::(.*))?/);
						if (match) {
							return { hasError: true, errorType: match[1], details: match[2] };
						}
					}
				}
			}
		}
	}
	return { hasError: false };
}

// ============================================================================
// Pi streaming (Node spawn — mirrors legacy runPiStreaming)
// ============================================================================

interface StreamingResult {
	exitCode: number | null;
	stderr: string;
	messages: Array<Record<string, unknown>>;
	usageInput: number;
	usageOutput: number;
	usageCacheRead: number;
	usageCacheWrite: number;
	usageCost: number;
	usageTurns: number;
	model?: string;
	error?: string;
	finalOutput: string;
}

function runPiStreaming(
	spec: { command: string; args: ReadonlyArray<string> },
	cwd: string,
	outputFile: string,
	env: Record<string, string | undefined>,
	onStdout?: (line: string) => void,
	onStderr?: (data: string) => void,
): Promise<StreamingResult> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...env };
		const child = spawn(spec.command, [...spec.args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
		});
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Array<Record<string, unknown>> = [];
		let usageInput = 0;
		let usageOutput = 0;
		let usageCacheRead = 0;
		let usageCacheWrite = 0;
		let usageCost = 0;
		let usageTurns = 0;
		let model: string | undefined;
		let error: string | undefined;
		const rawStdoutLines: string[] = [];

		const processStdoutLine = (line: string) => {
			onStdout?.(line);
			const parsed = (() => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})();
			if (parsed) {
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (parsed.type === "tool_execution_start" && parsed.toolName) {
					const argsPreview = extractToolArgsPreview(parsed.args as Record<string, unknown> || {});
					const toolLine = argsPreview ? `${parsed.toolName}: ${argsPreview}` : String(parsed.toolName);
					outputStream.write(`${toolLine}\n`);
				}
				if ((parsed.type === "message_end" || parsed.type === "tool_result_end") && msg) {
					messages.push(msg);
					const text = extractTextFromContent(msg.content);
					if (text) {
						for (const l of text.split("\n")) outputStream.write(`${l}\n`);
					}
					if (parsed.type === "message_end" && msg.role === "assistant") {
						if (msg.model) model = msg.model as string;
						if (msg.errorMessage) error = msg.errorMessage as string;
						const u = msg.usage as {
							input?: number;
							output?: number;
							inputTokens?: number;
							outputTokens?: number;
							cacheRead?: number;
							cacheWrite?: number;
							cost?: { total?: number };
						} | undefined;
						if (u) {
							usageTurns++;
							usageInput += u.input ?? u.inputTokens ?? 0;
							usageOutput += u.output ?? u.outputTokens ?? 0;
							usageCacheRead += u.cacheRead ?? 0;
							usageCacheWrite += u.cacheWrite ?? 0;
							usageCost += u.cost?.total ?? 0;
						}
					}
				}
			} else {
				rawStdoutLines.push(line);
				outputStream.write(`${line}\n`);
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const data = chunk.toString("utf-8");
			stderr += data;
			stderrBuf += data;
			outputStream.write(data);
			onStderr?.(data);
		});

		child.on("close", (exitCode) => {
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			outputStream.end();
			const finalOutput =
				getFinalOutput(
					messages as unknown as ReadonlyArray<{
						readonly role: string;
						readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
					}>,
				) || rawStdoutLines.join("\n").trim();
			resolve({
				exitCode,
				stderr,
				messages,
				usageInput,
				usageOutput,
				usageCacheRead,
				usageCacheWrite,
				usageCost,
				usageTurns,
				model,
				error,
				finalOutput,
			});
		});

		child.on("error", (spawnError) => {
			outputStream.end();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({
				exitCode: 1,
				stderr,
				messages,
				usageInput,
				usageOutput,
				usageCacheRead,
				usageCacheWrite,
				usageCost,
				usageTurns,
				model,
				error: error ?? spawnErrorMessage,
				finalOutput: rawStdoutLines.join("\n").trim(),
			});
		});
	});
}

// ============================================================================
// Single step execution
// ============================================================================

async function runSingleStep(
	step: SubagentStepConfig,
	ctx: {
		previousOutput: string;
		placeholder: string;
		cwd: string;
		sessionEnabled: boolean;
		sessionDir?: string;
		artifactsDir?: string;
		id: string;
		flatIndex: number;
		flatStepCount: number;
		outputFile: string;
		piPackageRoot?: string;
		piArgv1?: string;
	},
): Promise<StepResult> {
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	const task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	// Create temp dir if needed for long tasks or system prompts
	let tempDir = "";
	const needsTempDir = piArgsNeedTempDir({
		baseArgs: [],
		task,
		sessionEnabled,
		systemPrompt: step.systemPrompt,
	});
	if (needsTempDir) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	}

	const { args, env, dirsToCreate, fileWrites } = buildPiArgs(
		{
			baseArgs: ["--mode", "json", "-p"],
			task,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: step.model,
			tools: step.tools,
			extensions: step.extensions,
			skills: step.skills,
			systemPrompt: step.systemPrompt,
			mcpDirectTools: step.mcpDirectTools,
			promptFileStem: step.agent,
		},
		tempDir,
	);

	// Create required directories
	for (const dir of dirsToCreate) {
		fs.mkdirSync(dir, { recursive: true });
	}
	// Write temp files
	for (const fw of fileWrites) {
		fs.writeFileSync(path.join(tempDir, fw.relativePath), fw.contents, { mode: fw.mode });
	}

	const { command, args: spawnArgs } = getPiSpawnCommand(args, {
		...(ctx.piPackageRoot ? { piPackageRoot: ctx.piPackageRoot } : {}),
		...(ctx.piArgv1 ? { argv1: ctx.piArgv1 } : {}),
	});

	const spawnEnv = {
		...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
		...getSubagentDepthEnv(step.maxSubagentDepth),
	};

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? [...step.modelCandidates]
		: step.model ? [step.model] : ["default"];

	const attemptedModels: string[] = [];
	let finalResult: StreamingResult | undefined;

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const result = await runPiStreaming(
			{ command, args: spawnArgs },
			step.cwd ?? ctx.cwd,
			ctx.outputFile,
			spawnEnv,
		);

		// Cleanup temp dir
		if (tempDir) {
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}

		const hiddenError = result.exitCode === 0 && !result.error
			? detectSubagentError(result.messages as Array<{ role?: string; content?: unknown }>)
			: null;
		const effectiveExitCode = hiddenError?.hasError ? 1 : (result.exitCode ?? 1);
		const stepError = hiddenError?.hasError
			? hiddenError.details
				? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
				: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
			: result.error
				|| (result.exitCode !== 0 && result.stderr.trim()
					? result.stderr.trim()
					: undefined);

		if (candidate) attemptedModels.push(candidate);
		finalResult = { ...result, exitCode: effectiveExitCode, model: candidate ?? result.model, error: stepError };

		if (effectiveExitCode === 0 && !stepError) break;
		if (!isRetryableFailure(stepError) || i === candidates.length - 1) break;
	}

	return {
		agent: step.agent,
		output: finalResult?.finalOutput ?? "",
		exitCode: finalResult?.exitCode ?? 1,
		error: finalResult?.error,
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
	};
}

function flattenSteps(steps: ReadonlyArray<RunnerStep>): ReadonlyArray<SubagentStepConfig> {
	const result: SubagentStepConfig[] = [];
	for (const step of steps) {
		if ("parallel" in step) {
			for (const t of step.parallel) {
				result.push(t);
			}
		} else {
			result.push(step);
		}
	}
	return result;
}

// ============================================================================
// Status management
// ============================================================================

interface StatusStep {
	agent: string;
	status: "pending" | "running" | "complete" | "failed";
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	exitCode?: number | null;
	skills?: ReadonlyArray<string>;
	model?: string;
	attemptedModels?: ReadonlyArray<string>;
	error?: string;
}

interface RunStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	lastUpdate: number;
	pid: number;
	cwd: string;
	currentStep: number;
	steps: StatusStep[];
	artifactsDir?: string;
	sessionDir?: string;
	outputFile?: string;
	sessionFile?: string;
}

function writeStatus(statusPath: string, status: RunStatus): void {
	fs.mkdirSync(path.dirname(statusPath), { recursive: true });
	fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
}

function appendEvent(eventsPath: string, event: Record<string, unknown>): void {
	fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}

// ============================================================================
// Main run
// ============================================================================

async function runSubagent(config: SubagentRunConfig): Promise<RunResult> {
	const flatSteps = flattenSteps(config.steps);
	const sessionEnabled = Boolean(config.sessionDir)
		|| config.steps.some((s) => !("parallel" in s) && Boolean((s as SubagentStepConfig).sessionFile));

	const statusPath = path.join(config.asyncDir, "status.json");
	const eventsPath = path.join(config.asyncDir, "events.jsonl");
	fs.mkdirSync(config.asyncDir, { recursive: true });

	const overallStartTime = Date.now();
	const status: RunStatus = {
		runId: config.id,
		mode: flatSteps.length > 1 ? "chain" : "single",
		state: "running",
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd: config.cwd,
		currentStep: 0,
		steps: flatSteps.map((s) => ({
			agent: s.agent,
			status: "pending",
			skills: s.skills,
			model: s.model,
			attemptedModels: s.modelCandidates && s.modelCandidates.length > 0 ? s.modelCandidates : s.model ? [s.model] : undefined,
		})),
		artifactsDir: config.artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(config.asyncDir, "output-0.log"),
	};
	writeStatus(statusPath, status);

	appendEvent(eventsPath, {
		type: "subagent.run.started",
		ts: overallStartTime,
		runId: config.id,
		mode: status.mode,
		cwd: config.cwd,
		pid: process.pid,
	});

	const results: ResultWithSuccess[] = [];
	let previousOutput = "";
	let flatIndex = 0;

	for (let stepIndex = 0; stepIndex < config.steps.length; stepIndex++) {
		const step = config.steps[stepIndex]!;

		if ("parallel" in step) {
			// Parallel group
			const groupStartFlatIndex = flatIndex;
			const concurrency = step.concurrency ?? 4;
			const failFast = step.failFast ?? false;

			appendEvent(eventsPath, {
				type: "subagent.parallel.started",
				ts: Date.now(),
				runId: config.id,
				stepIndex,
				agents: step.parallel.map((t) => t.agent),
				count: step.parallel.length,
			});

			// Mark all as running
			for (let t = 0; t < step.parallel.length; t++) {
				status.steps[groupStartFlatIndex + t]!.status = "running";
				status.steps[groupStartFlatIndex + t]!.startedAt = Date.now();
			}
			status.currentStep = groupStartFlatIndex;
			status.lastUpdate = Date.now();
			status.outputFile = path.join(config.asyncDir, `output-${groupStartFlatIndex}.log`);
			writeStatus(statusPath, status);

			const parallelResults: ResultWithSuccess[] = [];
			let aborted = false;

			// Process in batches
			for (let ci = 0; ci < step.parallel.length; ci += concurrency) {
				if (aborted && failFast) break;
				const batch = step.parallel.slice(ci, ci + concurrency);
				const batchResults = await Promise.all(
					batch.map((task, localIdx) => {
						if (aborted && failFast) {
							return Promise.resolve({
								agent: task.agent,
								output: "(skipped — fail-fast)",
								exitCode: -1 as number | null,
							} as StepResult);
						}
						const fi = groupStartFlatIndex + ci + localIdx;
						const outputFile = path.join(config.asyncDir, `output-${fi}.log`);
						const taskSessionDir = config.sessionDir
							? path.join(config.sessionDir, `parallel-${ci + localIdx}`)
							: undefined;
						return runSingleStep(task, {
							previousOutput,
							placeholder: config.placeholder,
							cwd: config.cwd,
							sessionEnabled,
							sessionDir: taskSessionDir,
							artifactsDir: config.artifactsDir,
							id: config.id,
							flatIndex: fi,
							flatStepCount: flatSteps.length,
							outputFile,
							piPackageRoot: config.piPackageRoot,
							piArgv1: config.piArgv1,
						}).then((r) => {
							status.steps[fi]!.status = r.exitCode === 0 ? "complete" : "failed";
							status.steps[fi]!.endedAt = Date.now();
							status.steps[fi]!.durationMs = Date.now() - (status.steps[fi]!.startedAt ?? Date.now());
							status.steps[fi]!.exitCode = r.exitCode;
							status.steps[fi]!.model = r.model;
							status.steps[fi]!.attemptedModels = r.attemptedModels;
							status.steps[fi]!.error = r.error;
							status.lastUpdate = Date.now();
							writeStatus(statusPath, status);
							appendEvent(eventsPath, {
								type: r.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
								ts: Date.now(),
								runId: config.id,
								stepIndex: fi,
								agent: r.agent,
								exitCode: r.exitCode,
								durationMs: status.steps[fi]!.durationMs,
							});
							if (r.exitCode !== 0 && failFast) aborted = true;
							return { ...r, success: r.exitCode === 0 } as ResultWithSuccess;
						});
					}),
				);
				parallelResults.push(...(batchResults as ResultWithSuccess[]));
			}

			flatIndex += step.parallel.length;

			appendEvent(eventsPath, {
				type: "subagent.parallel.completed",
				ts: Date.now(),
				runId: config.id,
				stepIndex,
				success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
			});

			for (const pr of parallelResults) {
				results.push(pr);
			}

			previousOutput = parallelResults.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");

			if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
				break;
			}
		} else {
			// Sequential step
			const seqStep = step as SubagentStepConfig;
			const stepStartTime = Date.now();
			const outputFile = path.join(config.asyncDir, `output-${flatIndex}.log`);

			status.currentStep = flatIndex;
			status.steps[flatIndex]!.status = "running";
			status.steps[flatIndex]!.startedAt = stepStartTime;
			status.lastUpdate = stepStartTime;
			status.outputFile = outputFile;
			writeStatus(statusPath, status);

			appendEvent(eventsPath, {
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: config.id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			});

			const singleResult = await runSingleStep(seqStep, {
				previousOutput,
				placeholder: config.placeholder,
				cwd: config.cwd,
				sessionEnabled,
				sessionDir: config.sessionDir,
				artifactsDir: config.artifactsDir,
				id: config.id,
				flatIndex,
				flatStepCount: flatSteps.length,
				outputFile,
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
			});

			const stepEndTime = Date.now();
			previousOutput = singleResult.output;
			results.push({
				success: singleResult.exitCode === 0,
				...singleResult,
			});

			status.steps[flatIndex]!.status = singleResult.exitCode === 0 ? "complete" : "failed";
			status.steps[flatIndex]!.endedAt = stepEndTime;
			status.steps[flatIndex]!.durationMs = stepEndTime - stepStartTime;
			status.steps[flatIndex]!.exitCode = singleResult.exitCode;
			status.steps[flatIndex]!.model = singleResult.model;
			status.steps[flatIndex]!.attemptedModels = singleResult.attemptedModels;
			status.steps[flatIndex]!.error = singleResult.error;
			status.lastUpdate = stepEndTime;
			writeStatus(statusPath, status);

			appendEvent(eventsPath, {
				type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: config.id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: singleResult.exitCode,
				durationMs: status.steps[flatIndex]!.durationMs,
			});

			flatIndex++;
			if (singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	const runEndedAt = Date.now();
	status.state = results.every((r) => r.success) ? "complete" : "failed";
	(status as { endedAt?: number }).endedAt = runEndedAt;
	status.lastUpdate = runEndedAt;
	writeStatus(statusPath, status);

	appendEvent(eventsPath, {
		type: "subagent.run.completed",
		ts: runEndedAt,
		runId: config.id,
		status: status.state,
		durationMs: runEndedAt - overallStartTime,
	});

	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	let truncated = false;
	if (config.maxOutputBytes || config.maxOutputLines) {
		const maxConfig = { ...DEFAULT_MAX_OUTPUT };
		if (config.maxOutputBytes) maxConfig.bytes = config.maxOutputBytes;
		if (config.maxOutputLines) maxConfig.lines = config.maxOutputLines;
		const bytes = Buffer.byteLength(summary, "utf-8");
		const lines = summary.split("\n").length;
		if (bytes > maxConfig.bytes || lines > maxConfig.lines) {
			summary = summary.slice(0, maxConfig.bytes);
			truncated = true;
		}
	}

	const agentName = flatSteps.length === 1
		? flatSteps[0]!.agent
		: `chain:${flatSteps.map((s) => s.agent).join("->")}`;

	const runResult: RunResult = {
		id: config.id,
		agent: agentName,
		success: results.every((r) => r.success),
		summary,
		results: results.map((r) => ({
			agent: r.agent,
			output: r.output,
			success: r.success,
			model: r.model,
			attemptedModels: r.attemptedModels,
		})),
		exitCode: results.every((r) => r.success) ? 0 : 1,
		timestamp: runEndedAt,
		durationMs: runEndedAt - overallStartTime,
		truncated,
		artifactsDir: config.artifactsDir,
		cwd: config.cwd,
		asyncDir: config.asyncDir,
		sessionId: config.sessionId,
	};

	fs.writeFileSync(config.resultPath, JSON.stringify(runResult, null, 2), "utf-8");

	return runResult;
}

// ============================================================================
// Entry point
// ============================================================================

async function loadConfig(arg: string | undefined): Promise<SubagentRunConfig> {
	if (arg) {
		const content = fs.readFileSync(arg, "utf-8");
		const config = JSON.parse(content) as SubagentRunConfig;
		// Best-effort temp config cleanup
		try { fs.unlinkSync(arg); } catch { /* ignored */ }
		return config;
	}

	// Read from stdin
	return new Promise<SubagentRunConfig>((resolve) => {
		let input = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => { input += chunk; });
		process.stdin.on("end", () => { resolve(JSON.parse(input) as SubagentRunConfig); });
	});
}

async function main(): Promise<void> {
	const configArg = process.argv[2];
	let config: SubagentRunConfig;
	try {
		config = await loadConfig(configArg);
	} catch (err) {
		console.error("Failed to load config:", err);
		process.exit(1);
	}

	try {
		await runSubagent(config);
	} catch (runErr) {
		console.error("Subagent runner error:", runErr);
		process.exit(1);
	}
}

main();
