#!/usr/bin/env bash
set -euo pipefail
# Resolve relative to this script; Node owns child lifecycle and labeled cleanup.
cd "$(dirname "$0")/.."
exec node test/run-e2e-isolated.mjs "$@"
