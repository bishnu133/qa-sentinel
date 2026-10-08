#!/usr/bin/env bash
# Reproduces the delivery-slot demo: a service change with an acceptance-criteria mismatch,
# a gap report, then generated API tests. Needs: node 20+, git, Claude Code (`claude`) logged in or ANTHROPIC_API_KEY.
# Usage: ./run-demo.sh [workdir]   (cost: roughly $0.50–$1 in Claude usage)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="node $HERE/../../dist/cli.js"
W="${1:-$(mktemp -d)}"
echo "workspace: $W"

# 1. Service repo: original code, then the dev's change
mkdir -p "$W/orders-service/src" && cd "$W/orders-service"
cp "$HERE/orders-service/package.json" "$HERE/orders-service/openapi.yaml" .
cp "$HERE/orders-service/src/server.before.js" src/server.js
git init -q -b main && git add -A && git -c user.email=dev@x -c user.name=dev commit -qm "orders api"
cp "$HERE/orders-service/src/server.after.js" src/server.js
git -c user.email=dev@x -c user.name=dev commit -qam "SHOP-42: delivery slot on orders"
npm install --no-audit --no-fund --silent

# 2. Test repo from the scratch scaffold, with one existing orders spec
mkdir -p "$W/qa-tests" && cd "$W/qa-tests"
$CLI init --yes --mode scratch --ci gitlab --workspace .. --name shop-tests
mkdir -p tests/api/orders && cp "$HERE/create-order.spec.before.ts" tests/api/orders/create-order.spec.ts
cp "$HERE/story-SHOP-42.md" .
npm install --no-audit --no-fund --silent
git init -q -b main && git add -A && git -c user.email=qa@x -c user.name=qa commit -qm "test repo"
git config user.email qa@x && git config user.name qa

# 3. Phase 1: gap report
$CLI gap-report --service orders-service --base HEAD~1 --head HEAD --story-file story-SHOP-42.md
echo; cat qa-gap-report.md; echo

# 4. Phase 2: generate tests against the running service
(cd "$W/orders-service" && PORT=3123 node src/server.js) & SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
QA_BASE_URL=http://localhost:3123 $CLI generate --service orders-service --base HEAD~1 --head HEAD --story-file story-SHOP-42.md
git show --stat HEAD
QA_BASE_URL=http://localhost:3123 npx playwright test --project=api tests/api/orders
