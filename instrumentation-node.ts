/**
 * Node.js-only subsystem startup, loaded by instrumentation.ts register() when
 * NEXT_RUNTIME is 'nodejs'. It lives in its own module so the Edge compile of
 * instrumentation.ts never sees these imports (Turbopack follows every import
 * reachable from a module-level function, guarded or not).
 */

export async function startSubsystems() {
    const cleanups = global.__devflowCleanups!;

    // First run: the starting model list (see lib/seed-data.ts). Never replaces an existing file.
    try {
      const { seedFileIfMissing } = await import('./lib/seed-data');
      const { getDataDir } = await import('./lib/data-paths');
      const { appPath } = await import('./lib/app-paths');
      const pathMod = await import('path');
      if (await seedFileIfMissing(appPath('data', 'models.json'), pathMod.join(getDataDir(), 'models.json'))) {
        console.log('[DevFlow] First run: created .AppData/models.json from data/models.json');
      }
    } catch (err) {
      console.log('[DevFlow] Model list seeding skipped:', err instanceof Error ? err.message : String(err));
    }

    // Stale lock/tmp file cleanup — remove leftover .lock/.tmp files from crashed runs
    try {
      const { getDataDir } = await import('./lib/data-paths');
      const { promises: fsp } = await import('fs');
      const pathMod = await import('path');
      const appDataDir = getDataDir();
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const nowMs = Date.now();
      const entries = await fsp.readdir(appDataDir, { withFileTypes: true });
      let staleCleaned = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const { name } = entry;
        if (!name.endsWith('.lock') && !name.includes('.tmp.')) continue;
        const fullPath = pathMod.join(appDataDir, name);
        try {
          const stat = await fsp.stat(fullPath);
          if (nowMs - stat.mtimeMs > ONE_HOUR_MS) {
            await fsp.unlink(fullPath);
            staleCleaned++;
          }
        } catch { /* file may have been removed already */ }
      }
      if (staleCleaned > 0) {
        console.log(`[DevFlow] Startup cleanup: removed ${staleCleaned} stale lock/tmp file(s) from .AppData/`);
      }
    } catch (err) {
      console.log('[DevFlow] Stale lock cleanup skipped:', err instanceof Error ? err.message : String(err));
    }

    // Reset agents stuck in 'starting' status with no live tmux session
    try {
      const { recoverStartingAgents, startCrashDetection } = await import('./lib/collab-pty');
      const { reset } = await recoverStartingAgents();
      // Crash detection used to start only on the first agent spawn, so after any
      // DevFlow restart crashes, auto-respawn, resume notices and stuck-shutdown
      // recovery stayed off until someone spawned an agent (found 1 Oct 2026).
      startCrashDetection();
      if (reset > 0) {
        console.log(`[DevFlow] Startup recovery: reset ${reset} agent(s) from 'starting' to 'stopped'`);
      }
    } catch (err) {
      console.log('[DevFlow] Agent startup recovery skipped:', err instanceof Error ? err.message : String(err));
    }

    // Auto-respawn Windows per-message agents (spawnMode: powershell) with autoResume: true.
    // These don't have persistent tmux sessions — activeSessions is lost on every restart.
    // Delay 45s: HTTP server needs to be ready AND crash detection needs one tick (30s)
    // to reset stale 'running' powershell agents to 'stopped' before we try to respawn them.
    setTimeout(async () => {
      try {
        const { DataPaths } = await import('./lib/data-paths');
        const { readJsonFile } = await import('./lib/data-io');
        const { getDevFlowApiToken } = await import('./lib/api-auth');
        const { selfOrigin } = await import('./lib/self-origin');
        const { isWindowsPerMessageAgent } = await import('./lib/roster-spawn-mode');
        type ChannelsShape = { channels: Array<{ id: string; roster?: { agents: Array<{ id: string; name: string; spawnMode?: 'wsl' | 'powershell'; agentType?: string; status: string; autoResume?: boolean }> } }>; lastUpdated: string };
        const channelsData = await readJsonFile<ChannelsShape>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
        const token = getDevFlowApiToken();
        if (!token) return;
        let respawned = 0;
        for (const channel of channelsData.channels) {
          for (const agent of (channel.roster?.agents ?? [])) {
            if (!isWindowsPerMessageAgent(agent)) continue;
            if (!agent.autoResume) continue;
            if (agent.status === 'error') continue; // don't auto-respawn errored agents
            try {
              await fetch(`${selfOrigin()}/api/collab/pty`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ action: 'roster_respawn', channelId: channel.id, agentId: agent.id }),
              });
              respawned++;
              console.log(`[DevFlow] Startup: auto-respawned Windows agent "${agent.name}" in channel ${channel.id}`);
              // Stagger to avoid saturating the Windows chrome.exe init
              if (respawned < 10) await new Promise(r => setTimeout(r, 5000));
            } catch (spawnErr) {
              console.error(`[DevFlow] Startup: failed to respawn "${agent.name}":`, spawnErr instanceof Error ? spawnErr.message : String(spawnErr));
            }
          }
        }
      } catch (err) {
        console.error('[DevFlow] Windows agent startup respawn error:', err instanceof Error ? err.message : String(err));
      }
    }, 45_000);

    // Teams sync orchestrator
    try {
      const { startSyncOrchestrator } = await import('./teams-integration/lib/teams-sync-orchestrator');
      startSyncOrchestrator();
    } catch (err) {
      console.log('[DevFlow] Teams sync orchestrator not started:', err instanceof Error ? err.message : String(err));
    }

    // Slack: inbound poller, outbound retry queue, notifications, App Home refresh
    try {
      const { isSlackConfigured } = await import('./slack-integration/lib/slack-auth');
      if (isSlackConfigured()) {
        try {
          const { startPoller } = await import('./slack-integration/lib/slack-socket');
          await startPoller();
          console.log('[DevFlow] Slack message poller started');
        } catch (err) {
          console.log('[DevFlow] Slack poller not started:', err instanceof Error ? err.message : String(err));
        }

        try {
          const { startRetryTimer } = await import('./slack-integration/lib/slack-outbound-queue');
          startRetryTimer();
          console.log('[DevFlow] Slack outbound queue started');
        } catch (err) {
          console.log('[DevFlow] Slack outbound queue not started:', err instanceof Error ? err.message : String(err));
        }

        try {
          const { startSlackNotifications } = await import('./slack-integration/lib/slack-notifications');
          startSlackNotifications();
          console.log('[DevFlow] Slack notifications listener started');
        } catch (err) {
          console.log('[DevFlow] Slack notifications not started:', err instanceof Error ? err.message : String(err));
        }

        try {
          const { publishAppHome, getActiveUsers } = await import('./slack-integration/lib/slack-app-home');
          const appHomeTimer = setInterval(async () => {
            try {
              const users = getActiveUsers();
              if (users.length > 0) await publishAppHome();
            } catch { /* ignore */ }
          }, 60_000);
          cleanups.push(() => clearInterval(appHomeTimer));
          console.log('[DevFlow] Slack App Home refresh loop started (60s interval)');
        } catch (err) {
          console.log('[DevFlow] Slack App Home refresh not started:', err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      console.log('[DevFlow] Slack not started:', err instanceof Error ? err.message : String(err));
    }

    // Qdrant collection init (async, non-blocking)
    try {
      const { ensureQdrantCollection } = await import('./lib/qdrant-init');
      ensureQdrantCollection().catch((err: unknown) => {
        console.log('[DevFlow] Qdrant init failed:', err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      console.log('[DevFlow] Qdrant init not started:', err instanceof Error ? err.message : String(err));
    }

    // Sprint M P1 T3 (Reynolds, 2026-05-27) — refresh model integration
    // blocks in .AppData/models.json on every server boot. Idempotent: a
    // no-infra-change run produces zero writes. Fire-and-forget alongside
    // qdrant init (non-blocking, runs on the deferred-3s tier).
    try {
      const { startupRunIntegrationDetection } = await import('./lib/model-integration-persist');
      startupRunIntegrationDetection().catch((err: unknown) => {
        console.log('[DevFlow] Model integration detection failed:', err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      console.log('[DevFlow] Model integration detection not started:', err instanceof Error ? err.message : String(err));
    }

    // Cron scheduler
    try {
      const { cronScheduler } = await import('./lib/cron-scheduler');
      await cronScheduler.start();
      console.log('[DevFlow] Cron scheduler started');
    } catch (err) {
      console.log('[DevFlow] Cron scheduler not started:', err instanceof Error ? err.message : String(err));
    }

    // Logging config
    try {
      const { getLoggingConfig } = await import('./lib/log-config');
      const config = await getLoggingConfig();
      console.log(
        `[DevFlow] Logging config loaded — level: ${config.logLevel}, verbose modules: ${
          Object.keys(config.verboseModules)
            .filter((k) => config.verboseModules[k])
            .join(', ') || 'none'
        }`
      );
    } catch (err) {
      console.log('[DevFlow] Logging config load failed (using defaults):', err instanceof Error ? err.message : String(err));
    }

    // Error tracker SSE wiring (must be after eventBus is initialized by earlier imports)
    try {
      const { wireErrorTrackerToEventBus } = await import('./lib/error-tracker');
      wireErrorTrackerToEventBus();
      console.log('[DevFlow] Error tracker wired to event bus');
    } catch (err) {
      console.log('[DevFlow] Error tracker not started:', err instanceof Error ? err.message : String(err));
    }

    // Computer-use task listener — reconciles CU tasks on terminal:done
    try {
      const { registerCuTaskListener } = await import('./lib/cu-task-listener');
      registerCuTaskListener();
    } catch (err) {
      console.log('[DevFlow] CU task listener not registered:', err instanceof Error ? err.message : String(err));
    }

    // Timer-based monitor subsystems — each returns a cleanup function
    type MonitorEntry = [name: string, starter: () => Promise<() => void>];
    const monitors: MonitorEntry[] = [
      ['Health check + watchdog', async () => {
        const { startHealthMonitor } = await import('./lib/monitors/health-monitor');
        return startHealthMonitor();
      }],
      ['Apps Always On', async () => {
        const { startAppAlwaysOnMonitor } = await import('./lib/app-always-on-monitor');
        return startAppAlwaysOnMonitor();
      }],
      ['PM2 status', async () => {
        const { startPm2Monitor } = await import('./lib/monitors/pm2-monitor');
        return startPm2Monitor();
      }],
      ['Port change', async () => {
        const { startPortMonitor } = await import('./lib/monitors/port-monitor');
        return startPortMonitor();
      }],
      ['Ralph loops', async () => {
        const { startLoopsMonitor } = await import('./lib/monitors/loops-monitor');
        return startLoopsMonitor();
      }],
      ['Sessions', async () => {
        const { startSessionsMonitor } = await import('./lib/monitors/sessions-monitor');
        return startSessionsMonitor();
      }],
      ['Terminal tasks', async () => {
        const { startTerminalTasksMonitor } = await import('./lib/monitors/terminal-tasks-monitor');
        return startTerminalTasksMonitor();
      }],
      ['Cron jobs', async () => {
        const { startCronMonitor } = await import('./lib/monitors/cron-monitor');
        return startCronMonitor();
      }],
      ['WSL2 bridge', async () => {
        const { startWslBridgeMonitor } = await import('./lib/monitors/wsl-bridge-monitor');
        return startWslBridgeMonitor();
      }],
      ['Scaffolding sync', async () => {
        const { startScaffoldingSync } = await import('./lib/monitors/scaffolding-sync');
        return startScaffoldingSync();
      }],
      ['Event loop lag', async () => {
        const { startEventLoopLagMonitor } = await import('./lib/monitors/event-loop-monitor');
        return startEventLoopLagMonitor();
      }],
      ['Process health', async () => {
        const { startProcessHealthMonitor } = await import('./lib/monitors/process-health-monitor');
        return startProcessHealthMonitor();
      }],
      ['Crash recovery', async () => {
        const { startCrashRecovery } = await import('./lib/monitors/crash-recovery');
        return startCrashRecovery();
      }],
      ['Archive rotation + token pruning', async () => {
        const { startArchiveRotation } = await import('./lib/monitors/archive-rotation');
        return startArchiveRotation();
      }],
      ['Delivery failure monitor', async () => {
        const { startDeliveryMonitor } = await import('./lib/monitors/delivery-monitor');
        return startDeliveryMonitor();
      }],
      ['Codex Native automatic delivery', async () => {
        const { startCodexNativeDeliveryMonitor } = await import('./lib/monitors/codex-native-delivery-monitor');
        return startCodexNativeDeliveryMonitor();
      }],
      ['Codex live config', async () => {
        const { startCodexRuntimeConfigMonitor } = await import('./lib/monitors/codex-runtime-config-monitor');
        return startCodexRuntimeConfigMonitor();
      }],
    ];

    for (const [name, start] of monitors) {
      try {
        const cleanup = await start();
        cleanups.push(cleanup);
      } catch (err) {
        console.log(
          `[DevFlow] ${name} monitor not started:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Keep-alive recovery — recreate missing cron jobs after WSL/PM2 restart
    try {
      const { recoverKeepAlives, startKeepAliveIdleMonitor } = await import('./app/api/agent/actions/keep-alive');
      cleanups.push(startKeepAliveIdleMonitor());
      const recovery = await recoverKeepAlives();
      if (recovery.expired > 0 || recovery.recovered > 0) {
        console.log(`[DevFlow] Keep-alive recovery: ${recovery.expired} expired, ${recovery.recovered} recovered`);
      }
    } catch (err) {
      console.log('[DevFlow] Keep-alive recovery skipped:', err instanceof Error ? err.message : String(err));
    }

    console.log('[DevFlow] Subsystems started');
}
