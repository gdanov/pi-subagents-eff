/**
 * ModelResolver service.
 *
 * Pure-ish logic ported from model-fallback.ts. Given an explicit
 * primary model, an ordered fallback list, the current Pi model
 * registry, and a preferred provider (from the parent session), produce
 * the candidate list to try in order.
 *
 * The legacy `splitThinkingSuffix` and the `RETRYABLE_MODEL_FAILURE_PATTERNS`
 * regex set are also exposed here.
 *
 * Made a service so tests can inject a fake registry and so the
 * executor (Phase 5) can swap implementations during a model-fallback
 * integration test without monkey-patching imports.
 */
import { Context, Effect, Layer } from "effect";

export interface AvailableModelInfo {
	readonly provider: string;
	readonly id: string;
	readonly fullId: string;
}

export interface ModelCandidatesInput {
	readonly primaryModel?: string;
	readonly fallbackModels?: ReadonlyArray<string>;
	readonly availableModels?: ReadonlyArray<AvailableModelInfo>;
	readonly preferredProvider?: string;
}

export interface ModelResolverService {
	readonly buildCandidates: (input: ModelCandidatesInput) => Effect.Effect<ReadonlyArray<string>>;
	readonly isRetryableFailure: (errorMessage: string | undefined) => boolean;
	readonly splitThinkingSuffix: (model: string) => {
		readonly baseModel: string;
		readonly thinkingSuffix: string;
	};
	readonly resolveCandidate: (
		model: string | undefined,
		availableModels?: ReadonlyArray<AvailableModelInfo>,
		preferredProvider?: string,
	) => string | undefined;
}

export class ModelResolver extends Context.Service<ModelResolver, ModelResolverService>()(
	"pi-subagents/ModelResolver",
) {}

// ============================================================================
// Pure helpers
// ============================================================================

export function splitThinkingSuffix(model: string): {
	readonly baseModel: string;
	readonly thinkingSuffix: string;
} {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels?: ReadonlyArray<AvailableModelInfo>,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	const only = matches[0];
	if (!only) return model;
	return `${only.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(input: ModelCandidatesInput): ReadonlyArray<string> {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const list = [input.primaryModel, ...(input.fallbackModels ?? [])];
	for (const raw of list) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(
			raw.trim(),
			input.availableModels,
			input.preferredProvider,
		);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

// ============================================================================
// Live (a thin Effect wrapper around the pure helpers above)
// ============================================================================

export const ModelResolverLive = Layer.succeed(ModelResolver)(
	ModelResolver.of({
		buildCandidates: (input) => Effect.sync(() => buildModelCandidates(input)),
		isRetryableFailure: isRetryableModelFailure,
		splitThinkingSuffix,
		resolveCandidate: resolveModelCandidate,
	}),
);

export const ModelResolverTest = ModelResolverLive;
