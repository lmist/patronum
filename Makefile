# patronum — repo-local beads
#
# Always prefer ./bin/bd over whatever `bd` is on PATH.
# System Homebrew/local copies drift; this one is the pinned release that
# mise installs. `make bd` links bin/bd to it; nothing is downloaded or built here.

BIN    := $(CURDIR)/bin
BD     := $(BIN)/bd
PREFIX ?= pt
BEADS_VERSION ?= 1.2.1
BEADS_REPOSITORY ?= gastownhall/beads
BEADS_TOOL := github:$(BEADS_REPOSITORY)@$(BEADS_VERSION)

.PHONY: all bd bootstrap formulas doctor hooks clean igflow-recovery debug-setup debug-check debug-go debug-lldb

DEBUG_PACKAGE ?= ./cmd/igunique
DEBUG_TEST ?= ^TestSelectPostMedia$$

all: bd

bd:
	@command -v mise >/dev/null || { echo "make bd needs mise (https://mise.jdx.dev): it installs the pinned Beads release" >&2; exit 1; }
	@mkdir -p $(BIN)
	@mise install --quiet $(BEADS_TOOL)
	@ln -sfn "$$(mise where $(BEADS_TOOL))/bd" $(BD)
	@if [ -d .beads ]; then chmod 700 .beads; fi
	@./bin/bd version | head -1

bootstrap:
	@./scripts/bootstrap.sh

formulas:
	@./scripts/check-formulas.sh

hooks:
	@PATH="$(BIN):$$PATH" ./bin/bd hooks install
	@./scripts/install-extra-hooks.sh

doctor:
	@PATH="$(BIN):$$PATH" ./bin/bd doctor --check=artifacts
	@PATH="$(BIN):$$PATH" ./bin/bd doctor --check=conventions
	@PATH="$(BIN):$$PATH" ./bin/bd doctor --check=pollution
	@./scripts/check-formulas.sh

igflow-recovery:
	go test -tags=recovery -count=1 -timeout 180s ./cmd/igflow ./internal/flow

debug-setup:
	bun scripts/debug-go.mjs setup

debug-check:
	bun scripts/debug-go.mjs check

debug-go:
	bun scripts/debug-go.mjs test '$(DEBUG_PACKAGE)' '$(DEBUG_TEST)'

debug-lldb:
	bun scripts/debug-go.mjs lldb '$(DEBUG_PACKAGE)' '$(DEBUG_TEST)'

clean:
	rm -f $(BD) $(BD).exe
