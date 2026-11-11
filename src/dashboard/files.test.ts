import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// settings.ts fixes HOME at import, so the guard is exercised in a child process.
function guard(home: string, paths: string[]): Array<string | null> {
  const child = Bun.spawnSync([process.execPath, "-e",
    `import { allowedArtifact } from ${JSON.stringify(join(import.meta.dir, "files.ts"))}; console.log(JSON.stringify(${JSON.stringify(paths)}.map(allowedArtifact)));`],
    { env: { ...process.env, IGDASH_HOME: home, IGDASH_ROOT: "" }, stdout: "pipe", stderr: "pipe" });
  return JSON.parse(child.stdout.toString());
}

test("artifacts are readable when the home folder is reached through a symlink", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "patronum-files-")));
  try {
    const real = join(base, "real-home"), link = join(base, "linked-home"), outside = join(base, "outside");
    for (const dir of ["data/media/h/post", "data/analysis/h", "data/h-unique"]) mkdirSync(join(real, dir), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(real, "data/media/h/post/a.jpg"), "x");
    writeFileSync(join(real, "data/analysis/h/analysis.json"), "{}");
    writeFileSync(join(real, "data/h-unique/a.jpg"), "x");
    writeFileSync(join(outside, "secret.json"), "{}");
    symlinkSync(join(outside, "secret.json"), join(real, "data/analysis/h/escape.json"));
    symlinkSync(real, link);

    const paths = ["data/media/h/post/a.jpg", "data/analysis/h/analysis.json", "data/h-unique/a.jpg"];
    expect(guard(link, paths)).toEqual(paths.map((path) => join(link, path)));
    expect(guard(real, paths)).toEqual(paths.map((path) => join(real, path)));
    // A link that leaves the home, and a folder that holds no collection output, stay refused.
    expect(guard(link, ["data/analysis/h/escape.json", "data/dbos/patronum.sqlite", "../outside/secret.json"])).toEqual([null, null, null]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
