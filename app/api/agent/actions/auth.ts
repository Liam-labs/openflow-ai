/**
 * Authentication Actions
 *
 * Actions for validating tokens and getting identity information.
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';

/**
 * auth.validate - Validate the current token
 */
export async function validate(
  _body: AgentApiRequest,
  auth: AgentAuthContext
): Promise<{ valid: boolean; tokenId: string; scope: string }> {
  return {
    valid: true,
    tokenId: auth.tokenId,
    scope: auth.scope,
  };
}

/**
 * auth.whoami - Get current token metadata and permissions
 */
export async function whoami(
  _body: AgentApiRequest,
  auth: AgentAuthContext
): Promise<{
  tokenId: string;
  tokenName: string;
  scope: string;
  createdBy: string;
  permissions: string[];
}> {
  // Build permissions list based on scope
  const allPermissions = {
    read: [
      'projects.list', 'projects.get', 'projects.health',
      'pm2.list', 'pm2.status', 'pm2.logs',
      'sessions.list', 'sessions.get',
      'collab.channels.list', 'collab.channels.get', 'collab.poll', 'collab.presence',
      'tasks.list',
      'loops.list', 'loops.get',
      'docs.list', 'docs.get', 'docs.search',
      'browser.status', 'browser.result',
    ],
    write: [
      'projects.create', 'projects.update',
      'pm2.start', 'pm2.stop', 'pm2.restart',
      'sessions.register', 'sessions.heartbeat', 'sessions.end', 'sessions.spawn', 'sessions.spawn_pty',
      'collab.channels.create', 'collab.join', 'collab.leave', 'collab.message', 'collab.cross_channel_message', 'collab.heartbeat', 'collab.react',
      'tasks.create', 'tasks.update', 'tasks.claim', 'tasks.unclaim', 'tasks.complete', 'tasks.delete',
      'loops.submit_input', 'loops.cancel', 'loops.register',
      'docs.create', 'docs.delete',
      'browser.submit', 'browser.cancel',
    ],
    admin: [
      'projects.delete',
      'collab.channels.delete',
    ],
  };

  let permissions: string[] = [];

  if (auth.scope === 'read') {
    permissions = allPermissions.read;
  } else if (auth.scope === 'write') {
    permissions = [...allPermissions.read, ...allPermissions.write];
  } else if (auth.scope === 'admin') {
    permissions = [...allPermissions.read, ...allPermissions.write, ...allPermissions.admin];
  }

  return {
    tokenId: auth.tokenId,
    tokenName: auth.tokenName,
    scope: auth.scope,
    createdBy: auth.createdBy,
    permissions: permissions.sort(),
  };
}
