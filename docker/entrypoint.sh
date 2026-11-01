#!/bin/bash
# First start: create the settings file and access token (kept in the /data volume). Every start: run the app on the container's
# own loopback and offer it on port 8080 for Docker to publish. Only your own computer reaches it (see docker-compose.yml).
set -euo pipefail
cd /opt/openflow
mkdir -p /data/home
chmod 700 /data/home .AppData

if [ -f /data/openflow.env ]; then
  install -m 600 /data/openflow.env .env
else
  # Naming and Caddy belong to the host installer, never the container namespace.
  args=(--no-install --no-build --container-init)
  if [ "${DEVFLOW_SERVER_MODE:-0}" = 1 ]; then
    args+=(--server)
    if [ -n "${OPENFLOW_HOST:-}" ]; then args+=(--host "$OPENFLOW_HOST"); fi
  fi
  python3 scripts/setup.py "${args[@]}" >/dev/null
  install -m 600 .env /data/openflow.env
fi

if [ "${DEVFLOW_SERVER_MODE:-0}" = 1 ]; then
  echo "First login: open /setup and enter the code below (valid 60 minutes)."
  python3 scripts/setup-code.py
fi

socat TCP-LISTEN:"${OPENFLOW_PUBLIC_PORT}",fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:"${PORT}" &
exec npm start
