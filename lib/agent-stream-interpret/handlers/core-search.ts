/**
 * Sprint 5 — Core search handlers: Glob, Grep, ToolSearch.
 */

import type { FamilyHandler, Handler, InterpretedAction } from '../types';
import { stripUserPath, truncate } from '../utils';

export const globHandler: Handler = (input, item) => {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const path = typeof input.path === 'string' ? input.path : '';
  return {
    icon: 'folder-search',
    verb: 'Glob',
    subject: pattern,
    detail: path ? `in ${stripUserPath(path)}` : '',
    outcome: null,
    tone: 'neutral',
    toolName: 'Glob',
    toolUseId: item.toolUseId ?? '',
  };
};

export const grepHandler: Handler = (input, item) => {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const path = typeof input.path === 'string' ? input.path : '';
  const glob = typeof input.glob === 'string' ? input.glob : '';
  const type = typeof input.type === 'string' ? input.type : '';
  const scope = glob || (path ? stripUserPath(path) : '') || (type ? `.${type}` : '');
  return {
    icon: 'search',
    verb: 'Grep',
    subject: `'${pattern}'`,
    detail: scope ? `in ${scope}` : '',
    outcome: null,
    tone: 'neutral',
    toolName: 'Grep',
    toolUseId: item.toolUseId ?? '',
  };
};

export const toolSearchHandler: Handler = (input, item): InterpretedAction => {
  const query = typeof input.query === 'string' ? input.query : '';
  return {
    icon: 'search',
    verb: 'ToolSearch',
    subject: truncate(query, 60),
    detail: '',
    outcome: null,
    tone: 'neutral',
    toolName: 'ToolSearch',
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.Glob = globHandler;
  exact.Grep = grepHandler;
  exact.ToolSearch = toolSearchHandler;
}
