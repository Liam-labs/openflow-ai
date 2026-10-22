/**
 * Sprint 5 — Agent (sub-agent dispatch). Catalogue §1, tone: external (§10a).
 */

import type { FamilyHandler, Handler } from '../types';
import { truncate } from '../utils';

export const agentHandler: Handler = (input, item) => {
  const description = typeof input.description === 'string' ? input.description : '';
  const subagent = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  return {
    icon: 'brain',
    verb: 'Agent',
    subject: truncate(description, 60),
    detail: subagent,
    outcome: null,
    tone: 'external',
    toolName: 'Agent',
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.Agent = agentHandler;
}
