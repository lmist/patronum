/**
 * Loaded before every `bun test` (see bunfig.toml).
 *
 * Tests must never read or write the operator's real data, so each test run
 * gets its own empty home folder, whatever PATRONUM_HOME says in .env.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PATRONUM_HOME = mkdtempSync(join(tmpdir(), "patronum-test-home-"));
