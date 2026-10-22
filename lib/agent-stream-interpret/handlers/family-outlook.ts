/**
 * Sprint 5 — Outlook MCP family (catalogue §3d, 38 actions).
 * Prefix: mcp__outlook__
 */

import type { FamilyHandler, Handler, IconName, InterpretedAction } from '../types';
import { truncate } from '../utils';

interface ActionMeta {
  verb: string;
  icon?: IconName;
  subject?: (input: Record<string, unknown>) => string;
}

const CALENDAR_ACTIONS = new Set([
  'list_events', 'get_event', 'list_calendars', 'create_event',
  'update_event', 'respond_to_event', 'delete_event', 'cancel_event',
  'find_meeting_times',
]);
const FOLDER_ACTIONS = new Set([
  'list_folders', 'get_folder', 'create_folder', 'update_folder',
  'delete_folder', 'move_folder', 'copy_emails',
]);
const RULE_ACTIONS = new Set([
  'list_rules', 'get_rule', 'create_rule', 'update_rule', 'delete_rule',
]);

const ACTIONS: Readonly<Record<string, ActionMeta>> = {
  // Auth
  authenticate: { verb: 'authenticate' },
  check_auth_status: { verb: 'check auth' },
  revoke_authentication: { verb: 'revoke auth' },
  list_authenticated_users: { verb: 'list users' },
  // Email
  list_emails: { verb: 'list emails', subject: (i) => String(i.folderId ?? '') },
  search_emails: { verb: 'search', subject: (i) => `\`${truncate(String(i.query ?? ''), 40)}\`` },
  read_email: { verb: 'read email' },
  mark_email: { verb: 'mark email', subject: (i) => (i.isRead ? 'read' : 'unread') },
  send_email: {
    verb: 'send',
    subject: (i) => `→ ${truncate(String(i.to ?? ''), 30)}`,
  },
  create_draft: { verb: 'create draft', subject: (i) => truncate(String(i.subject ?? ''), 50) },
  reply_email: { verb: 'reply email' },
  forward_email: { verb: 'forward', subject: (i) => `→ ${String(i.to ?? '')}` },
  get_attachment: { verb: 'get attachment' },
  list_attachments: { verb: 'list attachments' },
  add_attachment: { verb: 'add attachment', subject: (i) => String(i.name ?? '') },
  delete_attachment: { verb: 'delete attachment' },
  move_emails: { verb: 'move emails', subject: (i) => `→ ${String(i.destinationFolderId ?? '')}` },
  // Calendar
  list_events: { verb: 'list events' },
  get_event: { verb: 'get event' },
  list_calendars: { verb: 'list calendars' },
  create_event: { verb: 'create event', subject: (i) => truncate(String(i.subject ?? ''), 50) },
  update_event: { verb: 'update event' },
  respond_to_event: { verb: 'respond to event', subject: (i) => String(i.response ?? '') },
  delete_event: { verb: 'delete event' },
  cancel_event: { verb: 'cancel event' },
  find_meeting_times: { verb: 'find meeting times' },
  // Folders
  list_folders: { verb: 'list folders' },
  get_folder: { verb: 'get folder' },
  create_folder: { verb: 'create folder', subject: (i) => String(i.name ?? '') },
  update_folder: { verb: 'rename folder', subject: (i) => `→ ${String(i.name ?? '')}` },
  delete_folder: { verb: 'delete folder' },
  move_folder: { verb: 'move folder' },
  copy_emails: { verb: 'copy emails' },
  // Rules
  list_rules: { verb: 'list mail rules' },
  get_rule: { verb: 'get rule' },
  create_rule: { verb: 'create rule', subject: (i) => String(i.displayName ?? '') },
  update_rule: { verb: 'update rule' },
  delete_rule: { verb: 'delete rule' },
};

function iconForAction(action: string, override?: IconName): IconName {
  if (override) return override;
  if (CALENDAR_ACTIONS.has(action)) return 'calendar';
  if (FOLDER_ACTIONS.has(action)) return 'folder-search';
  if (RULE_ACTIONS.has(action)) return 'settings';
  return 'mail';
}

export const outlookFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const meta = ACTIONS[action];
  return {
    icon: iconForAction(action, meta?.icon),
    verb: meta ? `Outlook ${meta.verb}` : `Outlook ${action}`,
    subject: meta?.subject ? meta.subject(input) : '',
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: `mcp__outlook__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  _exact: Record<string, Handler>,
  family: Record<string, FamilyHandler>,
): void {
  family.outlook = outlookFamily;
}
