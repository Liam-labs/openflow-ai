#!/usr/bin/env bash
# Called by the merge-event worker after building an immutable image on the VPS.
# This is runtime smoke coverage; browser wizard and real-provider results are separate.
set -euo pipefail
image=${1:?usage: docker/vps-verify.sh IMAGE REVISION REPORT}
revision=${2:?revision required}
report=${3:?JSON report path required}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA' >&2; exit 2; }
command -v docker >/dev/null
command -v curl >/dev/null
command -v python3 >/dev/null
docker image inspect "$image" >/dev/null
name="openflow-verify-${revision:0:12}-$$"
scratch=$(mktemp -d)
created=0
volumes=()
cleanup() {
  if (( created )); then docker rm -f "$name" >/dev/null 2>&1 || true; fi
  for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  rm -rf "$scratch"
}
trap cleanup EXIT
fail=0
record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$scratch/results.tsv"
  printf '%s: %s — %s\n' "$2" "$1" "$3"
  [[ "$2" != fail ]] || fail=1
}
mounts=()
for part in data appdata userdata logs; do
  volume="$name-$part"
  docker volume create --label openflow.verification=true "$volume" >/dev/null
  volumes+=("$volume")
  case "$part" in
    data) destination=/data ;;
    appdata) destination=/opt/openflow/.AppData ;;
    userdata) destination=/opt/openflow/.UserData ;;
    logs) destination=/opt/openflow/logs ;;
  esac
  mounts+=(--mount "type=volume,src=$volume,dst=$destination")
done
docker create --name "$name" --label openflow.verification=true --init \
  --publish 127.0.0.1::8080 \
  --env DEVFLOW_SERVER_MODE=1 --env DEVFLOW_REQUIRE_TOKEN=1 \
  --env DEVFLOW_ALLOWED_HOSTS=localhost,127.0.0.1 \
  "${mounts[@]}" "$image" >/dev/null
created=1
docker start "$name" >/dev/null
port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$name")
url="http://127.0.0.1:$port"
status() { curl --max-time 5 -s -o /dev/null -w '%{http_code}' "$@" || true; }
# Bounded process-start readiness, not a periodic trigger or repository polling.
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if [[ $(status "$url/setup") == 200 ]]; then ready=1; break; fi
  [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]] || break
  sleep 2
done
if (( ready )); then
  record setup_page pass 'Fresh server-mode page responds'
  bind=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostIp}}' "$name")
  [[ "$bind" == 127.0.0.1 ]] && record loopback pass 'Disposable port is loopback-only' || record loopback fail 'Unexpected bind address'
  setup=$(curl --max-time 10 -fsS "$url/api/setup/status")
  if python3 -c 'import json,sys; assert json.load(sys.stdin)["setupComplete"] is False' <<< "$setup"; then
    record fresh_state pass 'Setup is incomplete on new volumes'
  else
    record fresh_state fail 'New volumes did not produce an incomplete setup'
  fi
  code=$(status "$url/api/system/harness-auth")
  [[ "$code" == 401 || "$code" == 403 ]] && record anonymous_auth pass 'Protected API refuses anonymous caller' || record anonymous_auth fail "Protected API returned $code"
  code=$(status -X POST -H 'Content-Type: application/json' --data '{"step":-1,"data":{}}' "$url/api/setup/save-step")
  [[ "$code" == 401 || "$code" == 403 ]] && record anonymous_write pass 'Setup write refuses anonymous caller' || record anonymous_write fail "Setup write returned $code"
  code=$(status -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Real-IP: 127.0.0.1' "$url/api/system/harness-auth")
  [[ "$code" == 401 || "$code" == 403 ]] && record spoofed_local pass 'Forged local headers refused' || record spoofed_local fail "Forged headers returned $code"
  if docker exec "$name" sh -c 'command -v tmux >/dev/null && command -v python3 >/dev/null && command -v claude >/dev/null && command -v codex >/dev/null'; then
    record runtime_tools pass 'tmux, Python, Claude Code and Codex are present; sign-in and replies not tested'
  else
    record runtime_tools fail 'An agent runtime prerequisite is absent'
  fi
  # Execute the image's own probe now, rather than waiting for its timer.
  docker inspect --format '{{json .Config.Healthcheck.Test}}' "$name" > "$scratch/health.json"
  if python3 - "$name" "$scratch/health.json" <<'PY'
import json, subprocess, sys
probe = json.load(open(sys.argv[2]))
if not probe or probe[0] not in ('CMD', 'CMD-SHELL'):
    sys.exit(1)
command = ['sh','-c',probe[1]] if probe[0] == 'CMD-SHELL' else probe[1:]
try:
    result = subprocess.run(['docker','exec',sys.argv[1],*command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    sys.exit(1)
PY
  then
    record server_health_probe pass 'Current image health endpoint accepts its local probe'
  else
    record server_health_probe fail 'Current image local health probe fails in server mode'
  fi
else
  record setup_page fail 'Fresh server-mode container did not serve setup within the startup bound'
fi
mkdir -p "$(dirname "$report")"
python3 - "$scratch/results.tsv" "$report" "$revision" "$image" <<'PY'
import datetime, json, pathlib, sys
rows = [dict(zip(('check','result','detail'), line.rstrip('\n').split('\t',2))) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
pathlib.Path(sys.argv[2]).write_text(json.dumps({'revision':sys.argv[3], 'image':sys.argv[4], 'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks':rows, 'passed':all(r['result']=='pass' for r in rows), 'scope':'isolated VPS server-mode runtime smoke; browser wizards and provider/agent execution are separate'}, indent=2)+'\n')
PY
exit "$fail"
