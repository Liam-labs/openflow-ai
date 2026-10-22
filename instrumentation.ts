
import { getDevflowHome } from '@/lib/home-dir';/**
 * Next.js Instrumentation
 * Sets up global error handlers and starts background monitoring subsystems.
 *
 * Each monitoring subsystem lives in lib/monitors/ for maintainability.
 * All setInterval timers are tracked in a global registry so they can be
 * cleared on hot-reload, preventing memory leaks in development.
 */

const LOG_DIR = `${getDevflowHome()}/logs`;

// Global registry for hot-reload cleanup
declare global {
  var __devflowCleanups: Array<() => void> | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Keys saved by the setup wizard live in a private file the app reads itself; values already in the environment win.
    try {
      const { loadSecretsIntoEnv } = await import('@/lib/secret-store');
      loadSecretsIntoEnv();
    } catch (error) {
      console.error('[secret-store] not loaded:', error instanceof Error ? error.message : error);
    }
    const fs = (await import('fs')).default;
    const path = (await import('path')).default;

    // Clear timers from any previous hot-reload cycle before re-registering
    if (global.__devflowCleanups) {
      for (const fn of global.__devflowCleanups) {
        try { fn(); } catch { /* ignore cleanup errors */ }
      }
    }
    // Cleanups are now module-scoped so startSubsystems() can access them
    if (!global.__devflowCleanups) {
      global.__devflowCleanups = [];
    }

    function logToFile(message: string) {
      try {
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        fs.appendFileSync(path.join(LOG_DIR, 'error.log'), `${timestamp}: ${message}\n`);
      } catch { /* Can't log, ignore */ }
    }

    // Global process error handlers
    process.on('uncaughtException', (error: Error) => {
      if (error.message?.includes('Controller is already closed')) return;
      console.error('Uncaught Exception:', error);
      logToFile(`uncaughtException: ${error.message}\n${error.stack}`);
    });

    process.on('unhandledRejection', (reason: unknown) => {
      if (reason instanceof Error && reason.message?.includes('Controller is already closed')) return;
      console.error('Unhandled Rejection:', reason);
      logToFile(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    });

    // Graceful shutdown — emit system:restarting, clear timers, exit cleanly
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        const { eventBus } = await import('./lib/event-bus');
        eventBus.emitEvent('system:restarting', { reason: signal, timestamp: new Date().toISOString() });
        // Brief pause so SSE clients receive the restarting event before the socket closes
        await new Promise(r => setTimeout(r, 200));
      } catch { /* best-effort */ }
      // Clear all registered subsystem timers
      if (global.__devflowCleanups) {
        for (const fn of global.__devflowCleanups) {
          try { fn(); } catch { /* ignore */ }
        }
        global.__devflowCleanups = [];
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(0)); });
    process.on('SIGINT',  () => { gracefulShutdown('SIGINT').catch(() => process.exit(0)); });

    // Defer all subsystem startup by 3 seconds to let the HTTP server become responsive first.
    // Without this, the monitors' internal HTTP requests deadlock the event loop during startup.
    setTimeout(async () => {
      try {
        const { startSubsystems } = await import('./instrumentation-node');
        await startSubsystems();
      } catch (err) {
        console.error('[DevFlow] Subsystem startup failed:', err instanceof Error ? err.message : String(err));
      }
    }, 3000);
  }
}
