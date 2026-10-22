/**
 * Teams Integration - Sync Orchestrator
 *
 * Background service that maintains the bidirectional sync between
 * DevFlow Collab and Microsoft Teams.
 *
 * Responsibilities:
 * - Renew Graph API subscriptions before expiry (max 3-day lifetime)
 * - Catch up on missed messages via delta queries
 * - Monitor bridge health and log errors
 *
 * Usage:
 *   import { startSyncOrchestrator, stopSyncOrchestrator } from './teams-sync-orchestrator';
 *   startSyncOrchestrator(); // Call on app startup
 */

import { renewSubscription, GraphApiError } from './teams-graph-client';
import { getMappings, logSyncError, updateMapping } from './teams-bridge-data';
import { isTeamsConfigured } from './teams-auth';

// Orchestrator state
let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

// Check interval: every 30 minutes
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Renew subscriptions when they have less than 12 hours left
const RENEWAL_BUFFER_MS = 12 * 60 * 60 * 1000;

/**
 * Start the sync orchestrator.
 * Runs subscription health checks on a recurring interval.
 */
export function startSyncOrchestrator(): void {
  if (isRunning) {
    console.log('[Teams Sync] Orchestrator already running');
    return;
  }

  if (!isTeamsConfigured()) {
    console.log('[Teams Sync] Teams not configured, orchestrator not started');
    return;
  }

  console.log('[Teams Sync] Starting orchestrator');
  isRunning = true;

  // Run immediately, then on interval
  runHealthCheck().catch(err =>
    console.error('[Teams Sync] Initial health check failed:', err)
  );

  intervalId = setInterval(() => {
    runHealthCheck().catch(err =>
      console.error('[Teams Sync] Health check failed:', err)
    );
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the sync orchestrator.
 */
export function stopSyncOrchestrator(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  isRunning = false;
  console.log('[Teams Sync] Orchestrator stopped');
}

/**
 * Check whether the orchestrator is currently running.
 */
export function isOrchestratorRunning(): boolean {
  return isRunning;
}

/**
 * Run a single health check cycle:
 * 1. Check all active subscriptions
 * 2. Renew any that are close to expiring
 * 3. Log errors for any that failed
 */
async function runHealthCheck(): Promise<void> {
  try {
    const mappings = await getMappings({ syncEnabled: true });

    if (mappings.length === 0) {
      return; // No active mappings
    }

    console.log(`[Teams Sync] Health check: ${mappings.length} active mapping(s)`);

    for (const mapping of mappings) {
      // Check subscription health
      if (mapping.subscriptionId && mapping.subscriptionExpiresAt) {
        const expiresAt = new Date(mapping.subscriptionExpiresAt).getTime();
        const now = Date.now();
        const timeRemaining = expiresAt - now;

        if (timeRemaining <= 0) {
          // Subscription expired - need to recreate
          console.warn(
            `[Teams Sync] Subscription expired for mapping ${mapping.id}. ` +
            'Will need manual re-creation via msteams.subscribe action.'
          );
          await logSyncError(
            'Subscription expired — needs re-creation',
            'healthCheck',
            mapping.id
          );
        } else if (timeRemaining < RENEWAL_BUFFER_MS) {
          // Renew subscription
          console.log(
            `[Teams Sync] Renewing subscription for mapping ${mapping.id} ` +
            `(expires in ${Math.round(timeRemaining / 3600000)}h)`
          );
          try {
            const renewed = await renewSubscription(mapping.subscriptionId);
            await updateMapping(mapping.id, {
              subscriptionExpiresAt: renewed.expirationDateTime,
            });
            console.log(
              `[Teams Sync] Subscription renewed, new expiry: ${renewed.expirationDateTime}`
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            // If subscription was deleted on the server side, clear it from our mapping
            if (err instanceof GraphApiError && (err.statusCode === 404 || err.code === 'ItemNotFound')) {
              console.warn(
                `[Teams Sync] Subscription ${mapping.subscriptionId} no longer exists. Clearing from mapping.`
              );
              await updateMapping(mapping.id, {
                subscriptionId: null,
                subscriptionExpiresAt: null,
              });
              await logSyncError(
                'Subscription not found (404) — cleared. Re-subscribe via msteams.subscribe.',
                'renewSubscription',
                mapping.id
              );
            } else {
              console.error(`[Teams Sync] Failed to renew subscription: ${errMsg}`);
              await logSyncError(errMsg, 'renewSubscription', mapping.id);
            }
          }
        }
      }

      // Update lastSyncAt
      await updateMapping(mapping.id, {
        lastSyncAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Teams Sync] Health check error: ${errMsg}`);
    await logSyncError(errMsg, 'healthCheck');
  }
}
