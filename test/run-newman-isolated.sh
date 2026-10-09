#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Isolated Newman Test Runner
# Creates an owned, ephemeral PostgreSQL container on a random loopback port,
# initializes schema + seeds only inside the owned DB, launches a dedicated
# backend process on a free port, runs Newman, and cleans up strictly owned
# resources on exit/signal while preserving non-zero exit codes.
# ==============================================================================

# 1. Argument validation: Restrict strictly before any docker or network action.
NEWMAN_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--report" ]]; then
    NEWMAN_ARGS=(
      -r 'cli,htmlextra'
      --reporter-htmlextra-export reports/newman/informe-api.html
      --reporter-htmlextra-title "Pruebas de API - Logistica UTA"
      --reporter-htmlextra-browserTitle "Informe Newman"
    )
  else
    echo "Error: Forbidden or unknown argument '$arg'. The isolated runner only accepts '--report' or no arguments." >&2
    exit 1
  fi
done

# 2. Strict environment sanitization: Refuse external DATABASE_URL and clear inherited baseUrl.
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Error: Refusing external DATABASE_URL. The isolated runner manages its own ephemeral container and never connects to an external database." >&2
  exit 1
fi

unset baseUrl
unset BASE_URL

OWNER_NONCE="$(node -e 'console.log(require("crypto").randomUUID())')"
CONTAINER_ID=""
BACKEND_PID=""
BACKEND_LOG=""
RUNNER_EXIT_CODE=0

# Invoked indirectly via EXIT trap; https://www.shellcheck.net/wiki/SC2329
# shellcheck disable=SC2317,SC2329
cleanup() {
  local status=$?
  set +e
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${CONTAINER_ID:-}" ]]; then
    if [[ "$(docker inspect -f '{{ index .Config.Labels "delivery.issue6.owner" }}' "$CONTAINER_ID" 2>/dev/null)" == "$OWNER_NONCE" ]]; then
      docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
      if docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
        echo "Error: Owned container cleanup was not confirmed." >&2
        RUNNER_EXIT_CODE=1
      fi
    else
      echo "Error: Refusing cleanup without exact container ownership." >&2
      RUNNER_EXIT_CODE=1
    fi
  fi
  if [[ -n "${BACKEND_LOG:-}" && -f "$BACKEND_LOG" ]]; then
    rm -f "$BACKEND_LOG" >/dev/null 2>&1 || true
  fi
  if [[ $RUNNER_EXIT_CODE -ne 0 ]]; then
    exit "$RUNNER_EXIT_CODE"
  fi
  exit "$status"
}

# Invoked indirectly via signal traps (INT, TERM, HUP); https://www.shellcheck.net/wiki/SC2329
# shellcheck disable=SC2317,SC2329
handle_signal() {
  local sig_code=$1
  RUNNER_EXIT_CODE=$sig_code
  exit "$sig_code"
}

trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

# Throwaway credentials for ephemeral test DB
PG_USER="isolated_test"
PG_PASS="isolated_secret_pass"
PG_DB="isolated_delivery"
CONTAINER_NAME="isolated-pg-${RANDOM}-$$"

# 3. Spawn ephemeral PostgreSQL container (no volumes, loopback random port)
CONTAINER_ID=$(docker run -d --rm --pull=never \
  --label "delivery.issue6.owner=$OWNER_NONCE" \
  --name "$CONTAINER_NAME" \
  -p 127.0.0.1::5432 \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine)

# Extract published loopback port
PORT_MAPPING=$(docker port "$CONTAINER_ID" 5432/tcp | head -n 1)
PG_PORT=$(echo "$PORT_MAPPING" | awk -F: '{print $NF}' | tr -d '[:space:]')

if [[ -z "$PG_PORT" ]]; then
  echo "Error: Failed to obtain published port for PostgreSQL container." >&2
  RUNNER_EXIT_CODE=1
  exit 1
fi

ISOLATED_DB_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}?sslmode=disable"

# 4. Wait for PostgreSQL readiness (timeout 30s)
READY=0
for attempt in {1..30}; do
  if docker logs "$CONTAINER_ID" 2>&1 | grep -q "ready for start up"; then
    if docker exec "$CONTAINER_ID" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
      READY=1
      break
    fi
  fi
  sleep 1
done

if [[ $READY -eq 0 ]]; then
  echo "Error: PostgreSQL readiness timeout in ephemeral container after ${attempt} attempts." >&2
  RUNNER_EXIT_CODE=1
  exit 1
fi

# 5. Initialize schema and seed data ONLY in owned ephemeral database
DATABASE_URL="$ISOLATED_DB_URL" pnpm prisma db init --db "$ISOLATED_DB_URL" >/dev/null
DATABASE_URL="$ISOLATED_DB_URL" pnpm tsx src/prisma/seed.ts >/dev/null

# 6. Allocate free local port for dedicated backend
APP_PORT=$(node -e 'const net = require("net"); const s = net.createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')

# 7. Launch dedicated backend process with explicit isolated env
JWT_SECRET="isolated-runner-jwt-secret-do-not-use-in-production"
JWT_EXPIRES_IN="1d"
BACKEND_LOG=$(mktemp -t backend-isolated-XXXXXX.log)

# Ensure dist is up-to-date
pnpm build >/dev/null 2>&1

PORT="$APP_PORT" \
DATABASE_URL="$ISOLATED_DB_URL" \
JWT_SECRET="$JWT_SECRET" \
JWT_EXPIRES_IN="$JWT_EXPIRES_IN" \
node dist/main.js > "$BACKEND_LOG" 2>&1 &\
BACKEND_PID=$!

# Wait for backend readiness on /api/v1/zones (timeout 30s) with liveness & timeout guard
BACKEND_READY=0
for attempt in {1..30}; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Error: Dedicated backend process died unexpectedly (PID $BACKEND_PID) on attempt ${attempt}." >&2
    if [[ -f "$BACKEND_LOG" ]]; then
      cat "$BACKEND_LOG" >&2
    fi
    RUNNER_EXIT_CODE=1
    exit 1
  fi
  if curl -s -f --connect-timeout 2 --max-time 3 "http://127.0.0.1:${APP_PORT}/api/v1/zones" >/dev/null 2>&1; then
    BACKEND_READY=1
    break
  fi
  sleep 1
done

if [[ $BACKEND_READY -eq 0 ]]; then
  echo "Error: Dedicated backend failed to start on port ${APP_PORT} after ${attempt} attempts." >&2
  if [[ -f "$BACKEND_LOG" ]]; then
    cat "$BACKEND_LOG" >&2
  fi
  RUNNER_EXIT_CODE=1
  exit 1
fi

# 8. Execute Newman against isolated backend
BASE_URL="http://127.0.0.1:${APP_PORT}/api/v1"

set +e
pnpm exec newman run delivery-api.postman_collection.json \
  -e test/postman/logistica_env.json \
  --env-var "baseUrl=${BASE_URL}" \
  "${NEWMAN_ARGS[@]}"
RUNNER_EXIT_CODE=$?
set -e

if [[ -f "$BACKEND_LOG" ]]; then
  rm -f "$BACKEND_LOG"
fi

exit "$RUNNER_EXIT_CODE"
