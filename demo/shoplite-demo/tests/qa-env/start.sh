#!/usr/bin/env bash
# Start the demo QA environment: the orders service (and the payments service when it is there) behind a small
# gateway on :8080. Use with `source qa-env/start.sh` so QA_BASE_URL is exported to the calling shell.
#
# Where each service's code comes from (first match wins):
#   1. /tmp/services/<name>          the service under test, pinned to the merged commit by `qa-generate`
#   2. $QA_ENV_LOCAL_SERVICES/<name> local checkouts (local run)
#   3. a fresh clone of the project listed in $QA_ENV_SERVICES, using the job token (CI)
#      QA_ENV_SERVICES="orders-service=<group>/shoplite-orders payments-service=<group>/shoplite-payments"
QA_ENV_DIR="${QA_ENV_DIR:-/tmp/qa-env}"
mkdir -p "$QA_ENV_DIR/logs"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
detach() {
  local log="${@: -1}"; local n=$(($# - 1))
  if command -v setsid >/dev/null 2>&1; then setsid "${@:1:$n}" </dev/null >"$log" 2>&1 &
  else nohup "${@:1:$n}" </dev/null >"$log" 2>&1 &
  fi
}
port_of() { case "$1" in orders-service) echo 3001;; payments-service) echo 3002;; esac; }
project_of() { for kv in $QA_ENV_SERVICES; do [ "${kv%%=*}" = "$1" ] && echo "${kv#*=}"; done; }

PAYMENTS_URL_VALUE=""
for svc in payments-service orders-service; do
  dir=""
  if [ -d "/tmp/services/$svc" ]; then dir="/tmp/services/$svc"
  elif [ -n "$QA_ENV_LOCAL_SERVICES" ] && [ -d "$QA_ENV_LOCAL_SERVICES/$svc" ]; then dir="$QA_ENV_LOCAL_SERVICES/$svc"
  elif [ -n "$(project_of "$svc")" ]; then
    dir="$QA_ENV_DIR/$svc"
    if [ ! -d "$dir" ]; then
      git clone -q --depth 1 "https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/$(project_of "$svc").git" "$dir" || dir=""
      [ -n "$dir" ] && git -C "$dir" remote remove origin   # no token left on disk
    fi
  fi
  # The payments service is optional: without it, the orders service answers for payments itself.
  if [ -z "$dir" ]; then [ "$svc" = payments-service ] && continue; echo "No code for $svc" >&2; return 1 2>/dev/null || exit 1; fi
  if [ ! -d "$dir/node_modules" ]; then (cd "$dir" && (npm ci --omit=dev --silent || npm install --omit=dev --silent)); fi
  [ "$svc" = payments-service ] && PAYMENTS_URL_VALUE="http://127.0.0.1:3002"
  (cd "$dir" && GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" PORT="$(port_of "$svc")" PAYMENTS_URL="$PAYMENTS_URL_VALUE" \
    detach node src/server.js "$QA_ENV_DIR/logs/$svc.log")
done
detach node "$HERE/gateway.js" "$QA_ENV_DIR/logs/gateway.log"

for i in $(seq 1 30); do
  if node -e 'fetch("http://127.0.0.1:8080/orders/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; then
    export QA_BASE_URL="http://127.0.0.1:8080"
    echo "Demo QA environment ready at $QA_BASE_URL"
    return 0 2>/dev/null || exit 0
  fi
  sleep 1
done
echo "Demo QA environment failed to start; logs:" >&2
tail -n 20 "$QA_ENV_DIR"/logs/*.log >&2
return 1 2>/dev/null || exit 1
