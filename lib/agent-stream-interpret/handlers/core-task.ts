/**
 * Sprint 5 — Task management handlers (catalogue §2a).
 * TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop.
 */

import type { FamilyHandler, Handler, InterpretedAction } from '../types';
import { truncate } from '../utils';

function makeTaskAction(
  verb: string,
  toolName: string,
  subject: string,
  detail: string,
  toolUseId: string,
  isMutate: boolean,
): InterpretedAction {
  return {
    icon: 'clipboard-list',
    verb,
    subject,
    detail,
    outcome: null,
    tone: isMutate ? 'mutate' : 'neutral',
    toolName,
    toolUseId,
  };
}

export const taskCreateHandler: Handler = (input, item) => {
  const title = typeof input.title === 'string' ? input.title : '';
  const priority = typeof input.priority === 'string' ? input.priority : '';
  return makeTaskAction(
    'Create task',
    'TaskCreate',
    truncate(title, 60),
    priority,
    item.toolUseId ?? '',
    true,
  );
};

export const taskUpdateHandler: Handler = (input, item) => {
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  const status = typeof input.status === 'string' ? input.status : '';
  return makeTaskAction(
    'Update task',
    'TaskUpdate',
    taskId,
    status,
    item.toolUseId ?? '',
    true,
  );
};

export const taskGetHandler: Handler = (input, item) => {
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  return makeTaskAction('Get task', 'TaskGet', taskId, '', item.toolUseId ?? '', false);
};

export const taskListHandler: Handler = (_input, item) =>
  makeTaskAction('List tasks', 'TaskList', '', '', item.toolUseId ?? '', false);

export const taskOutputHandler: Handler = (input, item) => {
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  return makeTaskAction('Task output', 'TaskOutput', taskId, '', item.toolUseId ?? '', false);
};

export const taskStopHandler: Handler = (input, item) => {
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  return makeTaskAction('Stop task', 'TaskStop', taskId, '', item.toolUseId ?? '', true);
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.TaskCreate = taskCreateHandler;
  exact.TaskUpdate = taskUpdateHandler;
  exact.TaskGet = taskGetHandler;
  exact.TaskList = taskListHandler;
  exact.TaskOutput = taskOutputHandler;
  exact.TaskStop = taskStopHandler;
}
