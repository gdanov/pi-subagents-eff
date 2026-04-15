# Handoff — pi-subagents Effect 4.x rewrite

Resume point for a fresh Claude session. Read this top-to-bottom before editing.

## Plan

Primary reference: `/Users/gdanov/.claude/plans/buzzing-singing-moore.md`. It is the source of truth for the phase breakdown and architectural decisions.

## State at handoff

Branch: `main`. **12 commits ahead of origin/main**, never pushed.

| Phase | Commit | New tests |
|---|---|---|
| 1 — Skeleton (src/ tree, errors.ts, service stubs) | `6a53626` | — |
| 2 — Domain + Effect Schemas (types, schemas) | `2f9359a` | 90 |
| 3 — I/O services (FS, Clock, Config, Artifacts, RunHistory, Session, AgentDirectory, ModelResolver) | `e0d9db4` | 149 |
| 3 — Phase 1-3 review fixes | `40fd808` | 161 |
| 4 — Spawn services (PiSpawner, GitSpawner, GhSpawner) | `39ec87f` | 180 |
| 5 — executor/single.ts MVP (`runSingle`) + pi-args | `7ad84f7` | 206 |
| 6 — executor/chain.ts + parallel.ts + chain-settings | `d359fc7` | 244 |
| 7 — PiEventBus, ResultWatcher, AsyncJobTracker, executor/async.ts | `dd9302f` | 263 |
| 8 — SlashLiveState, SkillResolver (no-op), IntercomBridge, ChainSerializer, AgentDirectory CRUD, management dispatcher | `fff721e` | 310 |
| 8 — Phase 5-8 review fixes (after pi agent review) | `ff00ba0` | 314 |
| 9 — TUI Render + TextEditor pure formatters | `8a097e6` | — |
| 10 — Subprocess runner `src/runner/main.ts` | `224cd4d` | — |

Totals right now: **188 legacy + 314 new = 502 tests green**, `tsc --noEmit` clean.

## Verify state before changing anything

```bash
cd /Users/gdanov/work/playground/pi-subagents-eff
git log --oneline -5 && git status   # expect HEAD=224cd4d, clean
npm run typecheck                    # expect clean
npm run test:unit        2>&1 | tail -5   # expect 188 pass
npm run test:unit-effect 2>&1 | tail -5   # expect 314 pass
```

If any of these don't match, stop and investigate before editing.

## Remaining phases

| Phase | Scope | Estimated |
|---|---|---|
| **9** | TUI `AgentManager.ts` + `ChainClarify.ts` — deferred to Phase 11 (entry swap wires them). `Render.ts` + `TextEditor.ts` done. | Medium |
| **10** | **DONE** — `src/runner/main.ts` implemented. Tests needed. | Small-medium |
| **11** | **Entry swap milestone.** `src/pi-adapter/runtime.ts` (Layer composition + ManagedRuntime), `tool-definition.ts` (`effectTool` → Pi ToolDefinition), `event-hub.ts` (pi.events ↔ Hub), `update-queue.ts` (onUpdate callback bridge), `typebox-bridge.ts` (Effect Schema → JSONSchema with anyOf coercion). Flip `package.json:pi.extensions` to `src/index.ts`. | Medium-large |
| **12** | Delete legacy flat `.ts` files at repo root. | Trivial |

## Deferred / TODO items

- **Runner tests** — `test/unit-effect/runner.test.ts` covering sequential, parallel, model-fallback, status/event JSON writes.
- **Model-fallback retry loop** — wraps `runSingle` in a candidate iteration using `ModelResolver.buildCandidates` + `isRetryableFailure`. Small wrapper.
- **Intercom detach race in `runSingle`** — `Effect.race(piProcessStream, intercomDetachSignal)` producing `PiDetachedForIntercom`. Needs `IntercomBridge` wired (already exists, just not connected).
- **Single-output file writing** (`single-output.ts`) — small helper to resolve + persist the agent's final output to a caller-supplied path.
- **Share-to-gist session upload** — uses the already-implemented `GhSpawner`.
- **Worktree orchestration** — `createWorktrees` / `diffWorktrees` / setup-hooks on top of `GitSpawner`. Consumed by `executor/parallel.ts` when `worktree: true`.
- **Builtin agent overrides** — `agentOverrides` section in `~/.pi/agent/settings.json`. Fairly involved (legacy `agents.ts:218-347`).
- **Full skill resolver** — replace `SkillResolverNoop` with the fs-walking implementation. ~200 LOC. Has a contract-lock test that will need updating.
- **SlashBridge Pi wiring + prompt-template bridge + slash-commands dispatcher** — all Phase 11, Pi-API-coupled.
- **modelRegistry validation warnings** in management create/update — small.
- **Chain-step reference warnings on delete/rename** — small.

## Hard-won Effect 4.x API gotchas (not in the plan)

The plan predates the spike. These are **real differences** from Effect 3 / the user's global `~/.claude/rules/typescript.md`:

- `ServiceMap.Service` → **`Context.Service`** (the rules file is out of date on this)
- `Schema.decodeUnknown` → **`Schema.decodeUnknownEffect`** (also `decodeUnknownResult`, `decodeUnknownSync`, etc.)
- `Schema.toStandardJSONSchemaV1` returns the schema with JSONSchema grafted on; the usable generator is **`Schema.toJsonSchemaDocument`** (returns `{dialect, schema, definitions}`)
- `Effect.fork` → **`Effect.forkChild`** (scope-inheriting) / **`Effect.forkScoped`** (scope-owned) / **`Effect.forkDetach`** (daemon — was `forkDaemon`)
- `Effect.catchAll` does not exist. Use **`Effect.ignore`** (swallows error, propagates interrupt), **`Effect.catchCause`** (swallows everything including interrupt — rarely what you want), **`Effect.catchTag("X", ...)`** for typed errors
- `Effect.zipRight` → use `Effect.andThen` or sequence via `Effect.gen`
- `Stream.unwrapScoped` → **`Stream.unwrap`**
- `Stream.repeatEffect` → **`Stream.fromEffectRepeat`**
- `Stream.filterMap` takes a `Filter.Filter`, not an Option-returner. For option-shaped filtering, use `Stream.filter` + `Stream.map`
- `Layer.scoped` → use **`Layer.effect`** (it accepts scope-requiring effects)
- `PubSub.Subscription` is NOT a `Queue.Dequeue` — you can't pipe it through `Stream.fromQueue`. Build via `Stream.fromEffectRepeat(PubSub.take(sub))` inside `Stream.unwrap`
- `forkDetach` fibers are NOT interrupted by caller scope; only by runtime shutdown or completion

## Tree layout

```
src/
  errors.ts                   19 Data.TaggedError classes — all errors live here
  domain/                     pure types + helpers (constants, depth, fork-context, messages, output, progress, artifacts, async-state, results)
  schema/                     Effect Schema for SubagentParams / ChainItem / StatusParams + common shared fragments
  services/                   Live + Test layers, each file has both
    FileSystem, Clock, ConfigReader, ArtifactStore, RunHistory, SessionStore, AgentDirectory, ModelResolver
    PiSpawner, GitSpawner, GhSpawner
    PiEventBus, ResultWatcher, AsyncJobTracker
    SlashLiveState, SkillResolver, IntercomBridge
  executor/                   composes services
    single.ts, chain.ts, parallel.ts, async.ts, management.ts
    pi-args.ts, chain-settings.ts, chain-serializer.ts, agent-serializer.ts
    Executor.ts               EMPTY STUB — Phase 11
    single-output.ts          EMPTY STUB — follow-up
  pi-adapter/                 EMPTY STUBS — Phase 11
  tui/
    AgentManager.ts            stub (wired in Phase 11)
    ChainClarify.ts           stub (wired in Phase 11)
    Render.ts                 ✅ done
    TextEditor.ts             ✅ done
  runner/
    main.ts                   ✅ done (Phase 10)
  index.ts                    EMPTY STUB — Phase 11 entry swap

test/
  unit/           legacy tests (don't touch until Phase 12 delete)
  unit-effect/    new tests; naming mirrors src/ (service-name.test.ts, executor-name.test.ts)
```

## Conventions in this repo

- **Never edit** the legacy flat `.ts` files at the repo root. They drive the active extension until Phase 11 entry swap.
- **Tests colocate by file** not by phase — `test/unit-effect/foo.test.ts` mirrors `src/.../foo.ts`.
- **Service Test layers** should sit in the same file as Live. Most follow `makeXTest(fixtures)` → returns `{ layer, controls }`. A few are just `XTest = XLive` when the Test FileSystem already provides everything needed.
- **Every Live layer that does async-risky work** needs an `Effect.ignore` comment explaining why failures are swallowed (cleanup vs user-facing), because the pi review already caught one `Effect.catchCause` that silently ate interrupts.
- **On-disk formats are contract** — users check `.chain.md` into repos. `status.json` / `metadata.json` / `run-history.jsonl` shapes must stay byte-compatible. If you change on-disk shape, add a golden-artifact test.
- **TypeScript rules** in `~/.claude/rules/typescript.md` (except `ServiceMap.Service` — use `Context.Service`). No `try/catch` outside `Effect.try`. No `async/await`. No `Promise.all`. No `any`. Classes only for `Data.TaggedError` + `Context.Service`.

## Phase 11 pointers (next up)

The entry swap is the major milestone. The `src/pi-adapter/` stubs (`runtime.ts`, `tool-definition.ts`, `event-hub.ts`, `update-queue.ts`, `typebox-bridge.ts`) need implementation plus `src/index.ts` as the new entry point. `src/executor/Executor.ts` also needs implementation to route between single/chain/parallel/async paths.

Key wiring:
- `runtime.ts` composes all Live layers into one `ManagedRuntime`
- `tool-definition.ts` bridges Effect Schema → Pi ToolDefinition + typebox anyOf coercion
- `event-hub.ts` maps `pi.events` ↔ Hub for inter-comms
- TUI files (`AgentManager.ts`, `ChainClarify.ts`) get wired in via `runtime.runPromise` calls

The plan section `7. TUI integration strategy` says: keep imperative, cross the Effect boundary only at entry/exit. For each legacy file:

| Legacy | New | Approach |
|---|---|---|
| `agent-manager*.ts` (6 files) | `src/tui/AgentManager.ts` | Thin imperative wrapper invoked via `Effect.tryPromise(() => showAgentManager(...))`. |
| `chain-clarify.ts` | `src/tui/ChainClarify.ts` | Same. Debounced save inside the dialog uses `runtime.runPromise(saveEffect)`. |
| `render.ts`, `render-helpers.ts`, `formatters.ts` | `src/tui/Render.ts` | Pure formatters; no Effect. Takes `Details` data and produces `AgentToolResult<Details>` UI content. |
| `text-editor.ts` | `src/tui/TextEditor.ts` | Pure imperative component. |

Scope: don't try to make pi-tui Effect-native. The wrappers just need to accept a typed Promise handshake so the executor can `Effect.tryPromise` them.

## How to run the independent review (pi agent)

Pi needs API keys. They're set via direnv in `/Users/gdanov/work/playground/emacs-gravity/.envrc` (`MINIMAX_API_KEY`). Source that, then run:

```bash
source /Users/gdanov/work/playground/emacs-gravity/.envrc
cd /Users/gdanov/work/playground/pi-subagents-eff
pi -p --no-session --thinking high \
   --tools "read,bash,grep,find,ls" \
   --no-extensions --no-skills --no-prompt-templates --no-themes \
   @review-prompt.md
```

`review-prompt.md` is checked in at the repo root; adjust its body to target the new phases before running. Apply findings as a separate "review fixes" commit (see `40fd808` and `ff00ba0` for the established format).

## User preferences (baked in, don't re-ask)

- Full rewrite in Effect 4.x. Greenfield `src/` tree; legacy stays untouched until Phase 12.
- Compatible runtime — slash commands, on-disk JSON shapes, config paths, event names must stay identical. Schemas may tighten internal types as long as the JSONSchema generated for Pi tool registration stays Google-API-compatible (the four legacy `Type.Any()` anyOf-avoidance sites).
- All four Effect priorities matter: structured concurrency, tagged errors, service layers, Effect Schema.
- NEVER commit without explicit user request (per `~/.claude/rules/source-control.md`). User tells you when to commit.
- Work on `main` directly in this repo (user confirmed). Do not create branches/worktrees.
- NEVER push to origin without explicit request.

## One-shot resume command

```bash
cd /Users/gdanov/work/playground/pi-subagents-eff && \
  git log --oneline -5 && \
  cat HANDOFF.md | head -80 && \
  echo "---" && \
  cat /Users/gdanov/.claude/plans/buzzing-singing-moore.md | head -60
```
