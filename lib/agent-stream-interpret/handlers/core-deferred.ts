/**
 * Sprint 5 — Deferred built-ins (catalogue §2b–§2g, plus ScheduleWakeup).
 * Grouped: Plan/Worktree, Cron/RemoteTrigger, Web, Interaction,
 * MCP Resources, Notebook, ScheduleWakeup.
 */

import type { FamilyHandler, Handler, InterpretedAction } from '../types';
import { basename, shortUrl, stripUserPath, truncate } from '../utils';

function neutral(verb: string, toolName: string, toolUseId: string, subject = '', detail = ''): InterpretedAction {
  return {
    icon: 'map',
    verb,
    subject,
    detail,
    outcome: null,
    tone: 'neutral',
    toolName,
    toolUseId,
  };
}

// ── Plan / Worktree (§2b) ───────────────────────────────────────────────

export const enterPlanModeHandler: Handler = (_input, item) =>
  neutral('Enter plan mode', 'EnterPlanMode', item.toolUseId ?? '');

export const exitPlanModeHandler: Handler = (_input, item) =>
  neutral('Exit plan mode', 'ExitPlanMode', item.toolUseId ?? '');

export const enterWorktreeHandler: Handler = (input, item) => {
  const branch = typeof input.branch === 'string' ? input.branch : '';
  return {
    icon: 'git-branch',
    verb: 'Enter worktree',
    subject: branch,
    detail: '',
    outcome: null,
    tone: 'mutate',
    toolName: 'EnterWorktree',
    toolUseId: item.toolUseId ?? '',
  };
};

export const exitWorktreeHandler: Handler = (_input, item) => ({
  icon: 'git-branch',
  verb: 'Exit worktree',
  subject: '',
  detail: '',
  outcome: null,
  tone: 'mutate',
  toolName: 'ExitWorktree',
  toolUseId: item.toolUseId ?? '',
});

// ── Cron / RemoteTrigger (§2c) ──────────────────────────────────────────

export const cronCreateHandler: Handler = (input, item) => {
  const schedule = typeof input.schedule === 'string' ? input.schedule : '';
  return {
    icon: 'clock',
    verb: 'Cron create',
    subject: schedule,
    detail: '',
    outcome: null,
    tone: 'mutate',
    toolName: 'CronCreate',
    toolUseId: item.toolUseId ?? '',
  };
};

export const cronDeleteHandler: Handler = (input, item) => {
  const cronId = typeof input.cronId === 'string' ? input.cronId : '';
  return {
    icon: 'clock',
    verb: 'Cron delete',
    subject: cronId,
    detail: '',
    outcome: null,
    tone: 'danger',
    toolName: 'CronDelete',
    toolUseId: item.toolUseId ?? '',
  };
};

export const cronListHandler: Handler = (_input, item) => ({
  icon: 'clock',
  verb: 'Cron list',
  subject: '',
  detail: '',
  outcome: null,
  tone: 'neutral',
  toolName: 'CronList',
  toolUseId: item.toolUseId ?? '',
});

export const remoteTriggerHandler: Handler = (_input, item) => ({
  icon: 'rocket',
  verb: 'Remote trigger',
  subject: '',
  detail: '',
  outcome: null,
  tone: 'external',
  toolName: 'RemoteTrigger',
  toolUseId: item.toolUseId ?? '',
});

// ── Web (§2d) ───────────────────────────────────────────────────────────

export const webSearchHandler: Handler = (input, item) => {
  const query = typeof input.query === 'string' ? input.query : '';
  return {
    icon: 'globe',
    verb: 'Web search',
    subject: truncate(query, 60),
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: 'WebSearch',
    toolUseId: item.toolUseId ?? '',
  };
};

export const webFetchHandler: Handler = (input, item) => {
  const url = typeof input.url === 'string' ? input.url : '';
  return {
    icon: 'globe',
    verb: 'Web fetch',
    subject: shortUrl(url),
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: 'WebFetch',
    toolUseId: item.toolUseId ?? '',
  };
};

// ── Interaction (§2e) ───────────────────────────────────────────────────

export const askUserQuestionHandler: Handler = (input, item) => {
  const question = typeof input.question === 'string' ? input.question : '';
  return {
    icon: 'help-circle',
    verb: 'Ask user',
    subject: truncate(question, 80),
    detail: '',
    outcome: null,
    tone: 'neutral',
    toolName: 'AskUserQuestion',
    toolUseId: item.toolUseId ?? '',
  };
};

export const pushNotificationHandler: Handler = (input, item) => {
  const title = typeof input.title === 'string' ? input.title : '';
  return {
    icon: 'bell',
    verb: 'Notify',
    subject: truncate(title, 60),
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: 'PushNotification',
    toolUseId: item.toolUseId ?? '',
  };
};

export const monitorHandler: Handler = (_input, item) => ({
  icon: 'eye',
  verb: 'Monitor',
  subject: '',
  detail: '',
  outcome: null,
  tone: 'neutral',
  toolName: 'Monitor',
  toolUseId: item.toolUseId ?? '',
});

// ── MCP Resources (§2f) ─────────────────────────────────────────────────

export const listMcpResourcesHandler: Handler = (input, item) => {
  const server = typeof input.server === 'string' ? input.server : '';
  return {
    icon: 'plug',
    verb: 'List MCP resources',
    subject: server,
    detail: '',
    outcome: null,
    tone: 'neutral',
    toolName: 'ListMcpResourcesTool',
    toolUseId: item.toolUseId ?? '',
  };
};

export const readMcpResourceHandler: Handler = (input, item) => {
  const uri = typeof input.uri === 'string' ? input.uri : '';
  return {
    icon: 'plug',
    verb: 'Read MCP resource',
    subject: truncate(uri, 60),
    detail: '',
    outcome: null,
    tone: 'neutral',
    toolName: 'ReadMcpResourceTool',
    toolUseId: item.toolUseId ?? '',
  };
};

// ── Notebook (§2g) ──────────────────────────────────────────────────────

export const notebookEditHandler: Handler = (input, item) => {
  const path = typeof input.notebook_path === 'string' ? input.notebook_path : '';
  const cellType = typeof input.cell_type === 'string' ? input.cell_type : '';
  return {
    icon: 'edit-3',
    verb: 'Notebook edit',
    subject: basename(path) || stripUserPath(path),
    detail: cellType,
    outcome: null,
    tone: 'mutate',
    toolName: 'NotebookEdit',
    toolUseId: item.toolUseId ?? '',
  };
};

// ── Schedule wakeup (§1) ────────────────────────────────────────────────

export const scheduleWakeupHandler: Handler = (input, item) => {
  const delay = typeof input.delaySeconds === 'number' ? input.delaySeconds : 0;
  const reason = typeof input.reason === 'string' ? input.reason : '';
  return {
    icon: 'clock',
    verb: `Schedule wakeup +${delay}s`,
    subject: truncate(reason, 60),
    detail: '',
    outcome: null,
    tone: 'mutate',
    toolName: 'ScheduleWakeup',
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.EnterPlanMode = enterPlanModeHandler;
  exact.ExitPlanMode = exitPlanModeHandler;
  exact.EnterWorktree = enterWorktreeHandler;
  exact.ExitWorktree = exitWorktreeHandler;
  exact.CronCreate = cronCreateHandler;
  exact.CronDelete = cronDeleteHandler;
  exact.CronList = cronListHandler;
  exact.RemoteTrigger = remoteTriggerHandler;
  exact.WebSearch = webSearchHandler;
  exact.WebFetch = webFetchHandler;
  exact.AskUserQuestion = askUserQuestionHandler;
  exact.PushNotification = pushNotificationHandler;
  exact.Monitor = monitorHandler;
  exact.ListMcpResourcesTool = listMcpResourcesHandler;
  exact.ReadMcpResourceTool = readMcpResourceHandler;
  exact.NotebookEdit = notebookEditHandler;
  exact.ScheduleWakeup = scheduleWakeupHandler;
}
