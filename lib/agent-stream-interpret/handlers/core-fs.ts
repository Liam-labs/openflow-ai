/**
 * Sprint 5 — Core filesystem handlers: Read, Edit, Write, NotebookEdit.
 */

import type { FamilyHandler, Handler, InterpretedAction } from '../types';
import { basename, formatLineRange, stripUserPath } from '../utils';

function readish(input: Record<string, unknown>, toolName: string, item: { toolUseId?: string }): InterpretedAction {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const lineRange = formatLineRange(input);
  return {
    icon: 'file-text',
    verb: 'Read',
    subject: basename(filePath) || stripUserPath(filePath),
    detail: lineRange ?? '',
    outcome: null,
    tone: 'neutral',
    toolName,
    toolUseId: item.toolUseId ?? '',
  };
}

function writish(
  input: Record<string, unknown>,
  toolName: string,
  verb: 'Edit' | 'Write',
  item: { toolUseId?: string },
): InterpretedAction {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  return {
    icon: 'edit-3',
    verb,
    subject: basename(filePath) || stripUserPath(filePath),
    detail: input.replace_all === true ? 'replace-all' : '',
    outcome: null,
    tone: 'mutate',
    toolName,
    toolUseId: item.toolUseId ?? '',
  };
}

export const readHandler: Handler = (input, item) => readish(input, 'Read', item);

export const editHandler: Handler = (input, item) =>
  writish(input, 'Edit', 'Edit', item);

export const writeHandler: Handler = (input, item) =>
  writish(input, 'Write', 'Write', item);

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.Read = readHandler;
  exact.Edit = editHandler;
  exact.Write = writeHandler;
}
