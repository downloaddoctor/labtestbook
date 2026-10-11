#!/bin/sh
# Parse-check every JS module in the repo (src + root shell files) as ESM.
# Catches syntax errors that a browser would hit at import time.
# No package.json in this repo, so we force module parsing via stdin
# (`node --input-type=module --check < file`). Run from the repo root.
#
# Errors go to the console only — no temp files are written.

set -e

FILES=$(git ls-files '*.js' 2>/dev/null | sort || true)
if [ -z "$FILES" ]; then
  echo "check-modules: no tracked .js files"
  exit 0
fi

fail=0
count=0
for f in $FILES; do
  count=$((count + 1))
  if ! ERR=$(node --input-type=module --check < "$f" 2>&1 >/dev/null); then
    echo "SYNTAX ERROR: $f"
    printf '%s\n' "$ERR" | sed 's/^/  /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "check-modules: FAILED ($count files checked)"
  exit 1
fi

echo "check-modules: OK ($count files)"
