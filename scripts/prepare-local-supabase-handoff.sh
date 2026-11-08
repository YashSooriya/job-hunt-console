#!/usr/bin/env bash
# Run as root inside Ubuntu-24.04 WSL with the official Supabase CLI installed.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'Usage: bash prepare-local-supabase-handoff.sh REPOSITORY_PATH NEW_LOCAL_WORKDIR' >&2
  exit 2
fi

repo="$(realpath -- "$1")"
workdir="$(realpath -m -- "$2")"
cli=/usr/local/bin/supabase

if [[ $EUID -ne 0 || ! -x "$cli" ]]; then
  echo "Use the root WSL shell with Supabase CLI at $cli." >&2
  exit 2
fi
if [[ ! -f "$repo/package-lock.json" || ! -f "$repo/scripts/run-m08-application-review-local-supabase.ps1" ]]; then
  echo 'Use the JobHuntAI development checkout with the M08 runner.' >&2
  exit 2
fi
if [[ "$workdir/" == "$repo/"* || -e "$workdir" ]]; then
  echo 'Choose a new disposable directory outside the repository.' >&2
  exit 2
fi

mkdir -- "$workdir"
"$cli" init --workdir "$workdir"

python3 - "$workdir/supabase/config.toml" <<'PY'
import re
import sys
from pathlib import Path

config = Path(sys.argv[1])
settings = {
    "": {"project_id": '"jobhuntai-m02-local-20261106"'},
    "api": {"port": "56321"},
    "db": {"port": "56322", "shadow_port": "56320", "major_version": "17"},
    "db.pooler": {"port": "56329"},
    "db.seed": {"enabled": "false"},
    "studio": {"port": "56323"},
    "local_smtp": {"port": "56324"},
    "inbucket": {"port": "56324"},
    "analytics": {"port": "56327"},
    "auth.email": {"enable_confirmations": "false"},
}
required = {
    ("", "project_id"), ("api", "port"), ("db", "port"), ("db", "major_version"),
    ("db.seed", "enabled"), ("auth.email", "enable_confirmations"),
}
section = ""
updated = set()
lines = []
for line in config.read_text(encoding="utf-8").splitlines():
    heading = re.fullmatch(r"\s*\[([\w.]+)\]\s*", line)
    if heading:
        section = heading.group(1)
    assignment = re.match(r"^([A-Za-z_][A-Za-z_0-9]*)\s*=", line)
    if assignment:
        key = assignment.group(1)
        replacement = settings.get(section, {}).get(key)
        if replacement is not None:
            line = f"{key} = {replacement}"
            updated.add((section, key))
    lines.append(line)
if missing := required - updated:
    raise SystemExit(f"Unexpected Supabase config template; missing settings: {sorted(missing)}")
config.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

# Some historical migrations patch function definitions by matching exact
# SQL fragments. Normalize Windows checkout line endings before staging them.
python3 - "$repo/database/migrations" "$workdir/supabase/migrations" <<'PY'
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
destination.mkdir(parents=True, exist_ok=True)
for migration in source.glob("*.sql"):
    (destination / migration.name).write_bytes(migration.read_bytes().replace(b"\r\n", b"\n"))
PY
tar -C "$repo" --exclude='.env*' --exclude='node_modules' -cf - supabase/functions \
  | tar -C "$workdir" -xf -
# The Bridge and scheduled worker import these modules outside supabase/.
for source in job-fit-memory-v4/{response,contract,dispatch-contract,worker,analysis}.ts job-fit-v3/{priority,contract}.ts; do
  install -D -m 644 -- "$repo/apps/web/lib/$source" "$workdir/apps/web/lib/$source"
done

printf 'Prepared disposable Supabase workdir: %s\n' "$workdir"
printf 'Use the start and readiness commands in docs/CODEX_CONTINUATION.md.\n'
