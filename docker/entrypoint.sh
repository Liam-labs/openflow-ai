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
  python3 scripts/setup.py --no-install --no-build >/dev/null
  install -m 600 .env /data/openflow.env
fi

socat TCP-LISTEN:"${OPENFLOW_PUBLIC_PORT}",fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:"${PORT}" &
exec npm start
