# Evals for the patronum skill

Six cases check that an agent with this skill uses `./bin/patronum` correctly: readiness, diagnosing a failed job, summarising a profile, finding files, choosing tests, and refusing to retry a job from the command line.

```bash
claude plugin eval .claude/skills/patronum --scaffold --allow-tools Bash --no-publish -j 4 --threshold 0.8
```

- Each case runs three times with the skill and three times without it, and reports the difference. A full run is 36 agent runs and costs about $6.
- `--scaffold` runs `fixture/scaffold.sh`, which builds each agent's workspace: a small copy of the checkout plus a made-up home folder (`fixture/make-home.ts`) holding one failed job and one half-finished profile. No real data or credentials are copied.
- `--allow-tools Bash` is needed because the agent has to run the command. The runner sandboxes it to the workspace.
- `--no-publish` keeps the report on this machine. Results land in `results/`, which Git ignores.
- Add `--case <name>` to run one case, and `--keep-temp` to keep the trace of each run.

When a with-skill run fails, read its trace before changing a grader: the first two failures this suite caught were a missing absolute path in `patronum paths` and a skill sentence that sent agents to the wrong directory.
