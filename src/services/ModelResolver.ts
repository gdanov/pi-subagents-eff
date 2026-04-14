/**
 * ModelResolver service.
 *
 * Pure-ish logic from model-fallback.ts: given an explicit override, an
 * ordered fallback list, the current Pi model registry, and a preferred
 * provider (from session), produce the candidate list to try in order.
 *
 * Made a service so tests can inject a fake registry.
 */
import { Context, Effect, Layer } from "effect";

export interface ModelCandidates {
	readonly primary: string;
	readonly fallbacks: ReadonlyArray<string>;
}

export interface ModelResolverService {
	readonly buildCandidates: (input: {
		readonly override?: string;
		readonly fallbacks?: ReadonlyArray<string>;
		readonly preferredProvider?: string;
	}) => Effect.Effect<ModelCandidates>;
	readonly isRetryableFailure: (errorMessage: string) => boolean;
}

export class ModelResolver extends Context.Service<ModelResolver, ModelResolverService>()(
	"pi-subagents/ModelResolver",
) {}

export const ModelResolverLive = Layer.sync(ModelResolver)(() => {
	throw new Error("ModelResolver.Live not yet implemented (Phase 3)");
});

export const makeModelResolverTest = (): Layer.Layer<ModelResolver, never, never> =>
	Layer.sync(ModelResolver)(() => {
		throw new Error("ModelResolver.Test not yet implemented (Phase 3)");
	});
