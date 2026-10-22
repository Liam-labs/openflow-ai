#!/usr/bin/env python3
"""RETIRED 18 Oct 2026. This hook no longer samples anything.

It was the only thing that fed the roster CTX bars. The 31 Aug 2026 scaffolding audit retired per-message hooks on purpose
(see the context-health skill), and the hook was already failing before that: 193 of its 198 recorded runs between 21 and 31
Aug exited with "no session id". It also assumed a 200K window for Sonnet, which runs on 1M here. After 31 Aug nothing wrote
the bars, and they showed readings saved in July and August.

The bars are now fed by scripts/context_sampler.py, a desktop service (systemd user unit devflow-context-sampler) that reads each
agent's own transcript with the right window per model. Diagnose a missing or wrong bar there:
    systemctl --user status devflow-context-sampler
    python3 ~/DevFlow/scripts/context_sampler.py --once --dry-run

This stub stays only because the Codex, Gemini, Grok and Antigravity wrappers still call this path in their message lifecycle.
It reads nothing, writes nothing and exits 0, so that call is harmless. Do not put sampling back here: a second writer using
different windows would fight the sampler for the same bar.
"""
import sys

if __name__ == "__main__":
    sys.exit(0)
