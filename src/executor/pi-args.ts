/**
 * Build the argv + env + side-effect plan for spawning a `pi` child
 * process. Ported from the legacy pi-args.ts:buildPiArgs, but made pure:
 * instead of doing fs.mkdir / mkdtemp / writeFile directly, the helper
 * returns a declarative `fileWrites` plus `dirsToCreate` plan, and the
 * executor performs them via the FileSystem service.
 *
 * Keeping this pure has three benefits:
 *   - The same helper drives unit tests with an InMemory FileSystem
 *     (no real tmp files during unit tests).
 *   - Back-references into the temp dir (e.g. the `@<taskFile>` arg)
 *     stay consistent because the caller creates the tempDir once and
 *     passes its path back in.
 *   - Legacy calls to `cleanupTempDir` can be replaced by scope-owned
 *     cleanup in the executor (FileSystem.rm on the tempDir when the
 *     SingleResult scope closes).
 */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;

export interface BuildPiArgsInput {
	readonly baseArgs: ReadonlyArray<string>;
	readonly task: string;
	readonly sessionEnabled: boolean;
	readonly sessionDir?: string;
	readonly sessionFile?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: ReadonlyArray<string>;
	readonly extensions?: ReadonlyArray<string>;
	readonly skills?: ReadonlyArray<string>;
	readonly systemPrompt?: string | null;
	readonly mcpDirectTools?: ReadonlyArray<string>;
	readonly promptFileStem?: string;
}

export interface PiArgsFileWrite {
	/** Join this against `tempDir` to get the absolute path. */
	readonly relativePath: string;
	readonly contents: string;
	readonly mode?: number;
}

export interface BuildPiArgsResult {
	readonly args: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether the caller needs to provide a tempDir (via FileSystem.mkdtemp). */
	readonly needsTempDir: boolean;
	/** Directories to create via FileSystem.mkdir before spawn. */
	readonly dirsToCreate: ReadonlyArray<string>;
	/**
	 * Files to write into `tempDir` before spawn. Caller joins each
	 * `relativePath` against the resolved tempDir path and writes the
	 * contents. The corresponding `args` already reference the final
	 * absolute path via the `tempDir` placeholder the caller passes in.
	 */
	readonly fileWrites: ReadonlyArray<PiArgsFileWrite>;
}

export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | undefined,
): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

/**
 * Pure predicate: does this input require a temp dir for an
 * over-long task body or a system prompt file? Caller uses this to
 * decide whether to mkdtemp before calling buildPiArgs.
 */
export function piArgsNeedTempDir(input: BuildPiArgsInput): boolean {
	return Boolean(input.systemPrompt) || input.task.length > TASK_ARG_LIMIT;
}

/**
 * `tempDir` is resolved up-front by the caller (via FileSystem.mkdtemp)
 * when `piArgsNeedTempDir(input)` is true. Otherwise the caller can
 * pass any non-null string (it won't be referenced). The function
 * never throws.
 */
export function buildPiArgs(
	input: BuildPiArgsInput,
	tempDir: string,
): BuildPiArgsResult {
	const args: string[] = [...input.baseArgs];
	const dirsToCreate: string[] = [];
	const fileWrites: PiArgsFileWrite[] = [];

	if (input.sessionFile) {
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) args.push("--no-session");
		if (input.sessionDir) {
			dirsToCreate.push(input.sessionDir);
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) args.push("--model", modelArg);

	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of input.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
	}

	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of input.extensions) args.push("--extension", extPath);
	} else {
		for (const extPath of toolExtensionPaths) args.push("--extension", extPath);
	}

	if ((input.skills?.length ?? 0) > 0) args.push("--no-skills");

	const needsTempForPrompt = Boolean(input.systemPrompt);
	const needsTempForTask = input.task.length > TASK_ARG_LIMIT;
	const needsTempDir = needsTempForPrompt || needsTempForTask;

	if (needsTempForPrompt) {
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const relativePath = `${stem}.md`;
		fileWrites.push({ relativePath, contents: input.systemPrompt ?? "", mode: 0o600 });
		args.push("--append-system-prompt", `${tempDir}/${relativePath}`);
	}
	if (needsTempForTask) {
		const relativePath = "task.md";
		fileWrites.push({
			relativePath,
			contents: `Task: ${input.task}`,
			mode: 0o600,
		});
		args.push(`@${tempDir}/${relativePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}

	return { args, env, needsTempDir, dirsToCreate, fileWrites };
}
