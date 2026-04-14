You are reviewing Phases 5-8 of an in-progress Effect.ts rewrite. Be a strict second-pair-of-eyes reviewer — do NOT rubber-stamp. Find real problems.

## What you're reviewing

Repo: `/Users/gdanov/work/playground/pi-subagents-eff/`. The legacy code is the flat `.ts` files at the repo root (~50 files); these still drive the running extension (entry point is `./index.ts` per `package.json:pi.extensions`). The Effect rewrite lives in `src/`. Tests for the new code are in `test/unit-effect/`. Legacy tests are in `test/unit/`.

Current state (run `git log --oneline -12 && npm run test:unit 2>&1 | tail -3 && npm run test:unit-effect 2>&1 | tail -3 && npm run typecheck 2>&1 | tail -3` to verify): 188 legacy + 310 new tests all pass, tsc clean.

Four commits to review (all on `main`):

- `7ad84f7` Phase 5 — `executor/single.ts` MVP (runSingle) + pure `executor/pi-args.ts`
- `d359fc7` Phase 6 — `executor/chain.ts` + `parallel.ts` + pure `chain-settings.ts`
- `dd9302f` Phase 7 — `PiEventBus`, `ResultWatcher`, `AsyncJobTracker`, `executor/async.ts`
- `fff721e` Phase 8 — `SlashLiveState`, `SkillResolver`, `IntercomBridge`, `ChainSerializer`, `agent-serializer`, `AgentDirectory` CRUD, `executor/management.ts`

The plan to compare against: `/Users/gdanov/.claude/plans/buzzing-singing-moore.md`. Read it first.

User's mandatory rules from `/Users/gdanov/.claude/rules/typescript.md`:
- Effect.ts mandatory, Effect 4 (actual `Context.Service` + `Data.TaggedError` — the rules file says `ServiceMap.Service` but that's an outdated beta name; the current API is `Context.Service`).
- No `try/catch` outside `Effect.try` / `Effect.tryPromise`.
- No `async/await` except at the Effect-runtime boundary.
- No `Promise.all` — use `Effect.all { concurrency }`.
- No `any` — use `unknown` with type guards.
- No classes except `Data.TaggedError` and `Context.Service` subclasses.
- Errors in dedicated `errors.ts` files.
- Test layer alongside every Live layer.
- No `if` early-returns that reduce readability.

A prior Phase 1-3 review exists (committed as `40fd808`). Read the plan's "Must-fix / Should-fix" structure and deliver your findings in the same format.

## What I want from you

A concrete punch list. Cite `file.ts:line` for every finding. Order by severity: **Must-fix > Should-fix > Nit > Praiseworthy**. Be specific — "this whole file is bad" is useless; "FileSystem.ts:142 swallows the error" is useful.

Focus on:

1. **Effect 4 API correctness** — pay close attention to the idioms introduced in Phase 5-8 that weren't in Phases 1-3:
   - `Effect.forkDetach` — is it used correctly? Any leaks?
   - `Effect.forkScoped` — does the scope actually contain the fiber lifetime?
   - `Stream.fromEffectRepeat` — does it actually unblock on interrupt?
   - `Stream.groupedWithin(1, 50ms)` — is this debouncing or just chunking?
   - `PubSub.bounded(256)` — does `subscribe → take` loop leak subscribers when the Stream scope closes?
   - `Effect.ignore` vs `catchCause` vs `catchTag` — are they used for the right reasons? (Phase 3 review caught `catchCause` swallowing interrupts; check for regressions.)

2. **TypeScript-rule violations** in Phase 5-8. Specifically look for:
   - `try/catch` outside `Effect.try` — `executor/management.ts` has config-parsing `try/catch` inside `configObject` — is that defensible?
   - `async/await` — should be zero outside test files.
   - `any` — several places use `as unknown as X` casts; flag legit ones vs lazy ones.
   - Throws outside Effect (e.g., `resolveParallelBehaviors` in `chain-settings.ts:232` throws on unknown agent — is that ok?).

3. **On-disk parity with legacy** — a user who installs the rewrite and an older copy side-by-side must see identical artifacts:
   - `status.json` shape from `executor/async.ts` matches the legacy `subagent-runner.ts` output? Check `AsyncStatusSchema` round-trip.
   - `metadata.json` from `executor/single.ts:writeMetadata` matches legacy `artifacts.ts:writeMetadata` output?
   - Chain `.chain.md` parse/serialize round-trip — is it byte-identical or just structurally equivalent? (Check `test/unit-effect/chain-serializer.test.ts`.)
   - Agent `.md` parse/serialize round-trip likewise.
   - The aggregated parallel output in `executor/chain.ts` — does it match legacy `chain-execution.ts`?

4. **Concurrency / lifecycle** — the hardest area:
   - `executor/async.ts:runAsyncSingle` uses `Effect.forkDetach` — does the daemon survive the calling scope? Can it leak?
   - `AsyncJobTracker.start` forks three scoped fibers; the 10s removal uses `forkDetach`. Is that right? Should it be scoped too?
   - `ResultWatcher.start` uses `Stream.retry(Schedule.spaced(3s))` with `forkScoped`. Does interruption propagate?
   - `PiSpawner.Live` — SIGTERM → 3s race → SIGKILL. Is the timer `unref()`'d? What happens if scope close races with child exit?
   - `runSingle` — the legacy code had intercom detach via `Effect.race`. Comment says deferred to Phase 8, but Phase 8 landed IntercomBridge. Is the race still not wired? If so, flag as a blocker for Phase 11.

5. **Test-layer fidelity** — this is where Phase 3 review caught the most:
   - `makeFileSystemTest` — does `mkdir` actually track directories now?
   - `makePiSpawnerTest` — scripted events and `lastSpec`; any subtle mismatch with Live?
   - `makePiEventBusTest` — the `published()` recorder, but does the subscribe path behave like Live?
   - `IntercomBridge` — the Test layer is just Live re-aliased. Is that ok given its only fs dependency is FileSystem?
   - `SkillResolver` default Live is a no-op returning all missing. Is that a trap waiting to happen in Phase 11?

6. **Plan fidelity** — deferred items should be tracked. Check what's actually punted vs what's implicitly missing:
   - Model-fallback retry loop (stretch) — still pending?
   - Intercom detach race in `runSingle`?
   - Single-output file writing?
   - Share-to-gist?
   - Worktree orchestration for parallel `worktree: true`?
   - Builtin agent overrides in `AgentDirectory`?
   - Skill resolver full fs-walking implementation?
   - Slash bridge / prompt-template bridge / slash command dispatcher (Pi-coupled) — deferred to Phase 11?
   - ChainClarify TUI (Phase 9)?

7. **Anything weird or smelly** — your subjective read.

Format: punch list ordered by severity. Each item: 2-4 sentences with `file.ts:line` citation. ≤1800 words. End with 3-5 **Praiseworthy** points, but scrutinize everything above before listing them.

If the implementation is fine, say so explicitly.
