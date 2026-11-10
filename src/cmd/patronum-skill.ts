/**
 * The guide agents follow when they use the patronum command.
 *
 * The guide is patronum-skill.md, next to this file, so it always matches
 * the commands this checkout has. The SKILL.md files that agents load are
 * short stubs that say "run patronum skill show"; `patronum skill setup`
 * writes them and `patronum skill remove` takes them away.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT, inRepo } from "../paths.js";

export const SKILL_NAME = "patronum";
export const SKILL_DESCRIPTION = "Operate and inspect this repository with the `./bin/patronum` command. Use when asked whether the checkout is ready, why a collection job failed, what was collected for an Instagram handle, where a profile's files are, which tests cover a change, or how to sign in, check the model, or start the dashboard. Also use before running any `bun src/cmd/...` or `go run ./cmd/...` program directly.";
/** Bump when the stub's wording changes, so `status` can tell an old stub from a current one. */
export const STUB_VERSION = "1";
const MARKER = "<!-- Installed by \"patronum skill setup\". Remove it with \"patronum skill remove\". -->";

/** The full guide, as agents should read it. */
export function skillGuide(): string {
  return readFileSync(inRepo("src/cmd/patronum-skill.md"), "utf8");
}

export type SkillScope = "project" | "user";

/** Where a stub goes, and the command an agent in that place should run. */
export function skillTarget(scope: SkillScope): { path: string; command: string } {
  return scope === "project"
    ? { path: join(REPO_ROOT, ".claude/skills", SKILL_NAME, "SKILL.md"), command: "./bin/patronum" }
    : { path: join(homedir(), ".claude/skills", SKILL_NAME, "SKILL.md"), command: join(REPO_ROOT, "bin/patronum") };
}

/** The short SKILL.md an agent loads. It sends the agent to the command for the real guide. */
export function skillStub(command: string): string {
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
metadata:
  patronum-stub: "${STUB_VERSION}"
---
${MARKER}

Run \`${command} skill show\` from the project directory you are working in and follow the guide it prints. Do not \`cd\` to the folder this file was loaded from. The guide comes from the patronum command itself, so it describes the commands that checkout really has.

If that fails, start with \`${command} status --json\`, then \`${command} commands --json\` and \`${command} <command> --help\`.
`;
}

export type SkillInstall = { scope: SkillScope; path: string; state: "current" | "outdated" | "foreign" | "missing" };

/** Is a stub installed at each place, and is it this version's? */
export function skillStatus(): SkillInstall[] {
  return (["project", "user"] as const).map((scope) => {
    const { path, command } = skillTarget(scope);
    if (!existsSync(path)) return { scope, path, state: "missing" };
    const text = readFileSync(path, "utf8");
    if (!text.includes(MARKER)) return { scope, path, state: "foreign" };
    return { scope, path, state: text === skillStub(command) ? "current" : "outdated" };
  });
}

/** Write the stub. A SKILL.md that someone else wrote is left alone unless `force` is set. */
export function installSkill(scope: SkillScope, force = false): SkillInstall {
  const { path, command } = skillTarget(scope);
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MARKER) && !force) return { scope, path, state: "foreign" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, skillStub(command));
  return { scope, path, state: "current" };
}

/** Remove a stub this command wrote. Anything else in the folder, such as evals, stays. */
export function removeSkill(scope: SkillScope): SkillInstall {
  const { path } = skillTarget(scope);
  if (!existsSync(path)) return { scope, path, state: "missing" };
  if (!readFileSync(path, "utf8").includes(MARKER)) return { scope, path, state: "foreign" };
  rmSync(path);
  return { scope, path, state: "missing" };
}
