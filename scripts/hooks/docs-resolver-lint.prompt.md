# Docs / resolver lint (Patronum)

A code change touched paths that the agent docs claim to describe. **Lint is due** before you consider the task finished.

## Scope

1. **`AGENTS.md`** — agent resolver map, commands, decision shortcuts, Stagehand notes, verified claims
2. **`HUMANS.md`** — human-facing commands, flags, workflows, mental model
3. **Everything the AGENTS.md resolver table points at** — each `Path` cell and any scripts/env/data paths named there
4. **`package.json` scripts** and CLI help (`src/cmd/cli.ts` → `helpText()`) if commands changed

## How to lint (be smart, not noisy)

1. List what actually changed this session (git diff / edited files).
2. Parse the **Resolver table** in `AGENTS.md` — every Path must exist; every Symbol named should still be exported/used.
3. If you added modules (e.g. map/notifications/browse), either:
   - add resolver rows + decision shortcuts, **or**
   - confirm they are intentionally out of the map (rare).
4. Commands in both docs must match **real** scripts (`bun run …` / `bun src/…`). No stale `npm`/`tsx` if the project is Bun-first.
5. `HUMANS.md` stays plain-language; `AGENTS.md` stays agent/resolver dense — keep command tables aligned, not copy-pasted fluff.
6. Do **not** invent Verified claims you did not run. Soften or drop stale Verified bullets.
7. Secrets stay out of docs (no real keys, passwords, context ids as secrets).

## Done when

- [ ] `AGENTS.md` resolver table matches the codebase
- [ ] `HUMANS.md` command list matches `package.json` + CLI help
- [ ] Decision shortcuts / workflows still make sense after the change
- [ ] No orphan new entrypoints that agents cannot discover

Apply the smallest doc edit that restores truth. Then continue the user’s original task if anything remains.
