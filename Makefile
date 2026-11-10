# patronum — repo-local beads
#
# Always prefer ./bin/bd over whatever `bd` is on PATH.
# System Homebrew/local copies drift; this one is a pinned GitHub release.

BIN    := $(CURDIR)/bin
BD     := $(BIN)/bd
PREFIX ?= pt
BEADS_VERSION ?= 1.2.1
BEADS_REPOSITORY ?= gastownhall/beads

.PHONY: all bd bootstrap formulas doctor hooks clean diagrams igflow-recovery debug-setup debug-check debug-go debug-lldb

DEBUG_PACKAGE ?= ./cmd/igunique
DEBUG_TEST ?= ^TestSelectPostMedia$$

all: bd

bd:
	@mkdir -p $(BIN)
	BEADS_VERSION=$(BEADS_VERSION) BEADS_REPOSITORY=$(BEADS_REPOSITORY) ./scripts/install-bd.sh $(BD)
	@./bin/bd version

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

diagrams:
	@./scripts/render-diagrams.sh

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
