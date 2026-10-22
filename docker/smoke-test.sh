#!/bin/bash
# Smoke test for the container install: starts it on a spare port, checks the dashboard, starts one agent, restarts the container
# and checks nothing was lost. Uses its own project name and volumes and removes them at the end. Needs only Docker and curl.
#   docker/smoke-test.sh            (from the repository root)
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${SMOKE_PORT:-3920}"
export OPENFLOW_PORT="$PORT"
COMPOSE=(docker compose -p openflow-smoke)
URL="http://127.0.0.1:$PORT"
fail=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fail=1; }
cleanup() { "${COMPOSE[@]}" down -v >/dev/null 2>&1; }
trap cleanup EXIT

wait_health() {
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/health")" = 200 ] && return 0
    sleep 3
  done
  return 1
}

"${COMPOSE[@]}" up -d --build >/dev/null 2>&1 || { bad "docker compose up"; exit 1; }
wait_health && ok "dashboard answers" || { bad "dashboard did not answer"; "${COMPOSE[@]}" logs --tail 30; exit 1; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/setup")" = 200 ] && ok "setup wizard page" || bad "setup wizard page"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/operations")" = 200 ] && ok "operations page (where the wizard ends)" || bad "operations page"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/account")" = 200 ] && ok "account settings load on a fresh install" || bad "account settings"
bind=$(docker inspect openflow --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostIp}}')
[ "$bind" = 127.0.0.1 ] && ok "published on 127.0.0.1 only" || bad "published on $bind"
curl -s "$URL/api/system/harness-auth" | grep -q '"claude@desktop"' && ok "sign-in list shows Claude Code" || bad "sign-in list"

started=$(curl -s -X POST "$URL/api/setup/first-team" -H 'Content-Type: application/json' -d '{"agents":["McKay"],"agentType":"claude"}')
echo "$started" | grep -q '"started":true' && ok "agent started" || bad "agent start: $started"
sleep 20
docker exec openflow tmux ls 2>/dev/null | grep -q collab-agent && ok "agent session is running" || bad "agent session"
verify=$(docker exec -e DEVFLOW_HOME=/opt/openflow openflow python3 data/scaffolding/sync.py --verify-only 2>&1)   # captured first: grep -q would end the pipe early
# .mcp.json differs from the master by design (the app writes this agent's own tool list), so only missing files and errors count
grep -q 'McKay:.*missing=0 .*errors=0' <<<"$verify" && ok "agent folder is complete" || bad "agent folder incomplete"

before=$(docker exec openflow sh -c 'cat /data/openflow.env /opt/openflow/.AppData/api-tokens.json | sha256sum')
docker restart openflow >/dev/null
wait_health && ok "restart: dashboard answers again" || bad "restart"
after=$(docker exec openflow sh -c 'cat /data/openflow.env /opt/openflow/.AppData/api-tokens.json | sha256sum')
[ "$before" = "$after" ] && ok "restart: settings and token kept" || bad "restart lost settings"

[ "$fail" = 0 ] && echo "SMOKE TEST PASSED" || echo "SMOKE TEST FAILED"
exit "$fail"
