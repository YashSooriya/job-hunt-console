#!/usr/bin/env bash
set -euo pipefail

workdir="$1"
log_path="$2"
pid_path="$3"
cd "$workdir"
/usr/local/bin/supabase functions serve chatgpt-bridge --no-verify-jwt --workdir "$workdir" >"$log_path" 2>&1 &
child_pid=$!
printf '%s\n' "$child_pid" >"$pid_path"
wait "$child_pid"
