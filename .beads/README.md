# Beads in this repo

Issue prefix: **pt**. Binary: **./bin/bd** (v1.2.1 from `vendor/beads`).

Do not follow the generic beads README. Start at `/AGENT_INSTRUCTIONS.md` and
`/docs/RESOLVERS.md`. Patronum's product map is `/AGENTS.md`.

```bash
export PATH="$PWD/bin:$PATH"
bd prime
bd ready
```

`bd init` already ran. Fresh clones should `bd bootstrap --yes`, never
`bd init --force`.
