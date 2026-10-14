#!/usr/bin/env bash
# Stop the local ShopLite QA environment (services on 3001-3003, gateway on 8080).
# Patterns are anchored so they only match the processes start.sh launched.
pkill -f '^node src/server.js$' 2>/dev/null
pkill -f '^node .*/qa-env/gateway.js$' 2>/dev/null
echo "stopped"
