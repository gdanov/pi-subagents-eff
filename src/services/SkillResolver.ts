/**
 * SkillResolver service.
 *
 * Resolves skill names to ResolvedSkill records (name + content +
 * source) for system-prompt injection. Phase 8 ships:
 *
 *   - `buildSkillInjection` pure formatter (line-for-line port of
 *     skills.ts:511) — deterministic, always usable.
 *   - SkillResolver service tag with a default "no-op" Live layer
 *     that returns `{resolved: [], missing: names}`. The full
 *     fs-walking resolver from skills.ts (~200 lines, mtime-cached,
 *     six search paths) lands when an Effect-native consumer
 *     actually needs it — likely Phase 11 when the entry-point
 *     wires runSingle with skills enabled.
 *
 * Behavior parity guarantee: the no-op resolver produces exactly the
 * same on-disk artifacts as the legacy code does when no skills are
 * found (which is the common case for the smoke-test agents in
 * `agents/`). Production traffic that depends on real skill
 * resolution will see the no-op path until the upgrade.
 */
import { Context, Effect, Layer } from "effect";

export type SkillSource =
	| "project"
	| "user"
	| "project-package"
	| "user-package"
	| "project-settings"
	| "user-settings"
	| "extension"
	| "builtin"
	| "unknown";

export interface ResolvedSkill {
	readonly name: string;
	readonly path: string;
	readonly content: string;
	readonly source: SkillSource;
}

export interface SkillResolution {
	readonly resolved: ReadonlyArray<ResolvedSkill>;
	readonly missing: ReadonlyArray<string>;
}

// ============================================================================
// Pure formatter (ported from skills.ts:511)
// ============================================================================

export function buildSkillInjection(skills: ReadonlyArray<ResolvedSkill>): string {
	if (skills.length === 0) return "";
	return skills.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`).join("\n\n");
}

// ============================================================================
// Service surface
// ============================================================================

export interface SkillResolverService {
	/**
	 * Resolve `skillNames` against a primary cwd, optionally falling
	 * back to a different cwd for any names not found in the primary.
	 * Mirrors the legacy `resolveSkillsWithFallback` two-pass shape so
	 * the eventual full impl can drop in without changing call sites.
	 */
	readonly resolve: (
		skillNames: ReadonlyArray<string>,
		primaryCwd: string,
		fallbackCwd?: string,
	) => Effect.Effect<SkillResolution>;
}

export class SkillResolver extends Context.Service<SkillResolver, SkillResolverService>()(
	"pi-subagents/SkillResolver",
) {}

/**
 * No-op resolver: returns every name as missing. This is wire-
 * compatible with the legacy "no skills found" path. The executor
 * threads `missing` into a `skillsWarning` field on SingleResult.
 */
export const SkillResolverNoop = Layer.succeed(SkillResolver)(
	SkillResolver.of({
		resolve: (skillNames) =>
			Effect.succeed({
				resolved: [],
				missing: [...skillNames],
			}),
	}),
);

/** Default Live = no-op until the full resolver is ported. */
export const SkillResolverLive = SkillResolverNoop;

/**
 * Test layer with explicit fixtures. Tests pass a prepared map of
 * resolved skills; everything else returns missing.
 */
export const makeSkillResolverTest = (
	fixtures: Readonly<Record<string, ResolvedSkill>>,
): Layer.Layer<SkillResolver, never, never> =>
	Layer.succeed(SkillResolver)(
		SkillResolver.of({
			resolve: (skillNames) =>
				Effect.sync(() => {
					const resolved: ResolvedSkill[] = [];
					const missing: string[] = [];
					for (const name of skillNames) {
						const fix = fixtures[name];
						if (fix) resolved.push(fix);
						else missing.push(name);
					}
					return { resolved, missing };
				}),
		}),
	);
