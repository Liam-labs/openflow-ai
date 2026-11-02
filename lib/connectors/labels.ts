/** Plain-English words for the Connectors page. Kept apart from the component so tests can pin them. */
import type { CostKind } from '@/lib/connectors/catalog';
import type { ConnectorState } from '@/lib/connectors/detect';

export const COST_LABEL: Record<CostKind, string> = {
  free: 'Free',
  included: 'Included with a plan',
  'free-tier': 'Free tier',
  'pay-per-use': 'Pay per use',
  'paid-plan': 'Paid plan needed',
};

export const STATE_LABEL: Record<ConnectorState, string> = {
  unknown: 'Status unavailable',
  'not-set-up': 'Not set up',
  installed: 'Installed',
  ready: 'Ready',
  running: 'Running',
};

export const STATE_TONE: Record<ConnectorState, string> = {
  unknown: 'border-white/15 text-white/50 bg-white/5',
  'not-set-up': 'border-white/15 text-white/50 bg-white/5',
  installed: 'border-yellow-400/30 text-yellow-300 bg-yellow-400/10',
  ready: 'border-green-400/30 text-green-300 bg-green-400/10',
  running: 'border-green-400/30 text-green-300 bg-green-400/10',
};

export interface StepOutcome { target: string; outcome: string; message: string }

/** One line from the per-program results of an add or remove. */
export function formatStepResults(results: StepOutcome[]): string {
  if (!results.length) return 'Nothing was changed.';
  return results.map((r) => r.message).join(' ');
}
