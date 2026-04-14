/**
 * Subagent recursion-depth guard.
 *
 * Ported from types.ts:395-427. Two surfaces:
 *
 * 1. Pure helpers (`normalizeMaxSubagentDepth`, `resolveCurrentMaxSubagentDepth`,
 *    `resolveChildMaxSubagentDepth`, `getSubagentDepthEnv`) — used by the
 *    spawn path to construct the child process env.
 *
 * 2. `checkSubagentDepthEffect` — Effect that fails with
 *    `SubagentDepthExceeded` if the current depth has reached the limit.
 *    This replaces the legacy `checkSubagentDepth` boolean-return shape
 *    in the executor; the legacy `checkSubagentDepth` plain function is
 *    preserved here too so the existing recursion-guard.test.ts keeps
 *    its contract until the test is migrated in Phase 2.5.
 *
 * Reads `PI_SUBAGENT_DEPTH` and `PI_SUBAGENT_MAX_DEPTH` from process.env
 * directly. These envs are part of the cross-process subagent contract
 * (parent process exports them; child process reads them) — wrapping
 * them in a Service would be over-engineering.
 */
import { Effect } from "effect";
import { SubagentDepthExceeded } from "../errors.ts";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "./constants.ts";

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return (
		normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH) ??
		normalizeMaxSubagentDepth(configMaxDepth) ??
		DEFAULT_SUBAGENT_MAX_DEPTH
	);
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

/** Plain shape preserved for parity with legacy callers and tests. */
export interface DepthCheck {
	readonly blocked: boolean;
	readonly depth: number;
	readonly maxDepth: number;
}

export function checkSubagentDepth(configMaxDepth?: number): DepthCheck {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

/**
 * Effect-shaped depth check used by the new Executor.
 * Fails with SubagentDepthExceeded when the parent depth has reached
 * the configured maximum.
 */
export const checkSubagentDepthEffect = (
	configMaxDepth?: number,
): Effect.Effect<DepthCheck, SubagentDepthExceeded> =>
	Effect.suspend(() => {
		const result = checkSubagentDepth(configMaxDepth);
		return result.blocked
			? Effect.fail(new SubagentDepthExceeded({ depth: result.depth, maxDepth: result.maxDepth }))
			: Effect.succeed(result);
	});

/**
 * Build the env to pass into a spawned child subagent process — bumps
 * PI_SUBAGENT_DEPTH by 1 and stamps PI_SUBAGENT_MAX_DEPTH (either the
 * explicit child override, the inherited env, or the default).
 */
export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(
			normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth(),
		),
	};
}
