/**
 * PowerShell Sessions Agent API Actions
 *
 * Exposes persistent PowerShell session operations through the unified Agent API.
 * WSL Claude agents can create, use, and manage Windows PowerShell sessions.
 */

import type { AgentApiRequest } from '@/lib/types';
import { selfOrigin } from '@/lib/self-origin';

const API_BASE = `${selfOrigin()}/api/powershell-sessions`;

/**
 * List PowerShell sessions (optionally filter by status)
 */
export async function list(body: AgentApiRequest): Promise<unknown> {
  const status = body.status as string | undefined;
  const url = status ? `${API_BASE}?status=${status}` : API_BASE;
  const res = await fetch(url);
  return res.json();
}

/**
 * Create a new PowerShell session
 */
export async function create(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      timeout: body.timeout,
    }),
  });
  return res.json();
}

/**
 * Get a specific PowerShell session (with live output)
 */
export async function get(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'get',
      sessionId: body.sessionId,
    }),
  });
  return res.json();
}

/**
 * Send a command to a PowerShell session
 */
export async function send(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'send',
      sessionId: body.sessionId,
      command: body.command,
    }),
  });
  return res.json();
}

/**
 * Get current output from a PowerShell session
 */
export async function output(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'output',
      sessionId: body.sessionId,
      since: body.since,
    }),
  });
  return res.json();
}

/**
 * Close a PowerShell session
 */
export async function close(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'close',
      sessionId: body.sessionId,
    }),
  });
  return res.json();
}
