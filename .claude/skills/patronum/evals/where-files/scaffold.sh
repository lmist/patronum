#!/bin/sh
# Build this case's workspace with the shared fixture.
exec sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../fixture/scaffold.sh"
