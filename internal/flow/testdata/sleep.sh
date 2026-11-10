#!/usr/bin/env bash
# sleep.sh: forks a child sleeper and blocks. exec_test.go cancels the
# context and checks that both the direct pid and the descendant are
# reaped via the process-group SIGTERM/SIGKILL path.
set -u
echo "sleeper pid=$$"
sleep 60 &
child_pid=$!
echo "child pid=${child_pid}"
wait
