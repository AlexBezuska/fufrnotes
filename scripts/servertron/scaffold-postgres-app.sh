#!/usr/bin/env bash
set -euo pipefail

# Wrapper around the existing scaffold-postgres-app.sh, kept here so npm scripts can call it.
# This preserves the “Passhroom way” documented in docs/servertron-new-app-database.md.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec "$REPO_ROOT/scaffold-postgres-app.sh" "$@"
