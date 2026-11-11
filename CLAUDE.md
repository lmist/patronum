# Claude / Codex / Cursor

Patronum map: [AGENTS.md](AGENTS.md). Beads contract:
[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) and
[docs/RESOLVERS.md](docs/RESOLVERS.md).

```bash
export PATH="$PWD/bin:$PATH"
bd prime
bd ready
patronum status --json     # is this checkout ready
patronum commands --json   # every command, with side effects
patronum map               # what each folder is for
```

`./bin/bd` is the only Beads binary this repo trusts. It is the
`gastownhall/beads` v1.2.1 release binary, installed by mise and linked by
`make bd`; `./scripts/bd` will not fall through to PATH.

<!-- bd-doctor-divergence: ok -->
