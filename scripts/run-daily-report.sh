#!/usr/bin/env bash
# Run Wear Active daily operational reporting from repo root.
# Usage: ./scripts/run-daily-report.sh [-- extra npm args]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npm run reports:daily -- "$@"
