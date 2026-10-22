#!/bin/bash
# Run a DevFlow hook inside WSL on behalf of a Windows (PowerShell) agent.
# Windows Claude Code calls hooks through Git Bash, which cannot see /home/...,
# so the hook command hands them to `wsl.exe -e` with this script. A WSL-launched
# hook has no agent environment, so load the same secrets an agent session has.
set -a; [ -f "$HOME/.secrets" ] && . "$HOME/.secrets"; set +a
exec "$@"
