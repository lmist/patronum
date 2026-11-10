// Deterministic child process used only by dashboard HTTP regression tests.
import { existsSync } from "node:fs";
const command = process.argv[2];
if (command === "preflight" && existsSync("preflight-fail")) { console.log(JSON.stringify({ok:false,error:"llm",kind:"missing-key",hint:"Configure provider credentials"})); process.exit(4); }
console.log("fixture password=test-fixture-secret verification_code=654321");
await Bun.sleep(command === "run" || command === "session" ? 250 : 20);
console.log(JSON.stringify({ok:true,command,argv:process.argv.slice(2),profileDir:process.env.PATRONUM_CHROME_PROFILE_DIR ?? null}));
