import { eventBus } from '@/lib/event-bus';

export type WizardName = 'tailscale' | 'cloudflare';

/**
 * Tell open wizard screens that what they show may have changed, so they read the current state again instead of polling.
 * The payload names the wizard only: no device, user, token or tunnel data is ever broadcast. Call it after a wizard changes state
 * (switch on, switch off, test) and when something outside the screen changes it (a second device opens the page).
 */
export function emitWizardChanged(wizard: WizardName): void {
  eventBus.emitEvent('wizard:changed', { wizard });
}
