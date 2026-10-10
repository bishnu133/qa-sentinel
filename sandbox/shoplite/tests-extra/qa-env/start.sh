#!/usr/bin/env bash
# Start an ephemeral ShopLite QA environment: three services + a gateway on :8080.
# Use with `source qa-env/start.sh` so QA_BASE_URL is exported to the calling shell.
#
# Where each service's code comes from (first match wins):
#   1. /tmp/services/<name>        the service under test, pinned to the merged SHA by `qa-generate`
#   2. $QA_ENV_LOCAL_SERVICES/<name> local checkouts (sandbox local mode)
#   3. a fresh clone of $QA_ENV_GROUP/<name> on the default branch (CI, using the job token)
QA_ENV_DIR="${QA_ENV_DIR:-/tmp/qa-env}"
mkdir -p "$QA_ENV_DIR/logs"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# detach <cmd...> <logfile>: run in the background in its own session, all std streams redirected.
detach() {
  local log="${@: -1}"; local n=$(($# - 1))
  if command -v setsid >/dev/null 2>&1; then setsid "${@:1:$n}" </dev/null >"$log" 2>&1 &
  else nohup "${@:1:$n}" </dev/null >"$log" 2>&1 &
  fi
}
port_of() { case "$1" in orders-service) echo 3001;; payments-service) echo 3002;; notifications-service) echo 3003;; esac; }

for svc in payments-service notifications-service orders-service; do
  if [ -d "/tmp/services/$svc" ]; then dir="/tmp/services/$svc"
  elif [ -n "$QA_ENV_LOCAL_SERVICES" ]; then dir="$QA_ENV_LOCAL_SERVICES/$svc"
  else
    dir="$QA_ENV_DIR/$svc"
    if [ ! -d "$dir" ]; then
      git clone -q --depth 1 "https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${QA_ENV_GROUP}/$svc.git" "$dir"
      git -C "$dir" remote remove origin   # no token left on disk
    fi
  fi
  if [ ! -d "$dir/node_modules" ]; then (cd "$dir" && (npm ci --omit=dev --silent || npm install --omit=dev --silent)); fi
  # Fully detached (own session, no inherited stdin/stdout), so callers reading our output never hang.
  (cd "$dir" && PORT="$(port_of "$svc")" PAYMENTS_URL=http://127.0.0.1:3002 NOTIFICATIONS_URL=http://127.0.0.1:3003 \
    detach node src/server.js "$QA_ENV_DIR/logs/$svc.log")
done
detach node "$HERE/gateway.js" "$QA_ENV_DIR/logs/gateway.log"

for i in $(seq 1 30); do
  if node -e 'Promise.all(["orders","payments","notifications"].map(s=>fetch(`http://127.0.0.1:8080/${s}/health`).then(r=>{if(!r.ok)throw 0}))).then(()=>process.exit(0),()=>process.exit(1))'; then
    export QA_BASE_URL="http://127.0.0.1:8080"
    echo "ShopLite QA environment ready at $QA_BASE_URL"
    return 0 2>/dev/null || exit 0
  fi
  sleep 1
done
echo "ShopLite QA environment failed to start; logs:" >&2
tail -n 20 "$QA_ENV_DIR"/logs/*.log >&2
return 1 2>/dev/null || exit 1
