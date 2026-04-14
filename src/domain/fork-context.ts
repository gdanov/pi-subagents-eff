/**
 * Fork-context helpers — ported from fork-context.ts.
 *
 * `resolveSubagentContext` is a pure widening: anything other than
 * exactly "fork" becomes "fresh". Kept synchronous because callers use
 * it inline during param parsing.
 *
 * `createForkContextResolver` produces a per-invocation resolver that
 * lazily creates branched session files. The legacy code threw on
 * missing parent session / leaf id / session-manager failure; we
 * preserve those failure modes but expose them as Effect-typed errors
 * via the `*Effect` constructor. The plain (throwing) constructor is
 * kept for parity with legacy call sites that haven't been ported yet.
 */
import { Effect } from "effect";
import { DEFAULT_FORK_PREAMBLE } from "./constants.ts";

export type SubagentExecutionContext = "fresh" | "fork";

/**
 * Prepend the fork preamble to a task string. Idempotent: a task that
 * already starts with the preamble is returned unchanged. Pass `false`
 * to skip the preamble entirely.
 *
 * Ported from types.ts:383-389.
 */
export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

export interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	createBranchedSession(leafId: string): string | undefined;
}

export interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

const noopResolver: ForkContextResolver = {
	sessionFileForIndex: () => undefined,
};

/**
 * Plain constructor matching legacy semantics (throws on misuse).
 * Use `createForkContextResolverEffect` from new code.
 */
export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") return noopResolver;

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const leafId = sessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				const sessionFile = sessionManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a session file.");
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}

/**
 * Effect-shaped constructor. Failures are still surfaced as plain
 * `Error` (legacy parity) wrapped in `Effect.try` — once the executor
 * is ported in Phase 5, these can be promoted to a dedicated
 * `ForkContextError` tagged class if it proves useful.
 */
export const createForkContextResolverEffect = (
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
): Effect.Effect<ForkContextResolver, Error> =>
	Effect.try({
		try: () => createForkContextResolver(sessionManager, requestedContext),
		catch: (e) => (e instanceof Error ? e : new Error(String(e))),
	});
