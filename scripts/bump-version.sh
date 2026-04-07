#!/usr/bin/env bash
# Bump semver in manifest.json (patch | minor | major). Does not run release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIND="${1:-}"

if [[ "$KIND" != "patch" && "$KIND" != "minor" && "$KIND" != "major" ]]; then
  echo "Usage: $0 patch|minor|major" >&2
  exit 1
fi

exec python3 - "$ROOT/manifest.json" "$KIND" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
kind = sys.argv[2]
data = json.loads(path.read_text(encoding="utf-8"))
raw = str(data.get("version", "")).strip().split(".")
if len(raw) != 3 or not all(x.isdigit() for x in raw):
    sys.exit(f"manifest.json version must be semver x.y.z, got {data.get('version')!r}")
major, minor, patch = (int(raw[0]), int(raw[1]), int(raw[2]))
if kind == "patch":
    patch += 1
elif kind == "minor":
    minor += 1
    patch = 0
else:
    major += 1
    minor = 0
    patch = 0
data["version"] = f"{major}.{minor}.{patch}"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(data["version"])
PY
