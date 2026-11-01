# OpenFlow in one container: the dashboard, the agent runner (tmux + python) and the Claude Code and Codex programs.
# For Mac (Docker Desktop, OrbStack, Colima) and for anyone who prefers a container on Linux. Native install: see the README.
# The build needs no secrets. Your logins and data live in the /data volume, never in the image.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux python3 python3-pexpect git curl socat ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

# The agent programs. Signing in happens later, inside the dashboard.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# /data is the volume: made here so it starts owned by the unprivileged user
RUN mkdir -p /opt/openflow /data && chown node:node /opt/openflow /data
WORKDIR /opt/openflow
COPY --chown=node:node . .
USER node

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000 \
    DEVFLOW_BIND_HOST=127.0.0.1 \
    OPENFLOW_PUBLIC_PORT=8080

# Dependencies and the production build. The data folders are empty here; compose mounts a volume on each (a link would be refused by the app's own safety check).
RUN npm ci --include=dev && npm run build:local && npm cache clean --force \
    && rm -rf .AppData .UserData logs && mkdir .AppData .UserData logs

ENV HOME=/data/home
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python3 /opt/openflow/docker/healthcheck.py
ENTRYPOINT ["/opt/openflow/docker/entrypoint.sh"]
