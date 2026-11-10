---
name: patronum
description: Operate and inspect this repository with the `./bin/patronum` command. Use when asked whether the checkout is ready, why a collection job failed, what was collected for an Instagram handle, where a profile's files are, which tests cover a change, or how to sign in, check the model, or start the dashboard. Also use before running any `bun src/cmd/...` or `go run ./cmd/...` program directly.
metadata:
  patronum-stub: "1"
---
<!-- Installed by "patronum skill setup". Remove it with "patronum skill remove". -->

Run `./bin/patronum skill show` from the project directory you are working in and follow the guide it prints. Do not `cd` to the folder this file was loaded from. The guide comes from the patronum command itself, so it describes the commands that checkout really has.

If that fails, start with `./bin/patronum status --json`, then `./bin/patronum commands --json` and `./bin/patronum <command> --help`.
