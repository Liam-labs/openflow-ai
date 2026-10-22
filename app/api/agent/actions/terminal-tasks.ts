/**
 * Terminal Tasks Agent API Actions
 *
 * Exposes terminal task operations through the unified Agent API.
 * Supports multiple engines: Claude, Gemini, Ollama.
 */

import type { AgentApiRequest } from '@/lib/types';
import { selfOrigin } from '@/lib/self-origin';

const API_BASE = `${selfOrigin()}/api/terminal-tasks`;

/**
 * List terminal tasks (optionally filter by status or engine)
 */
export async function list(body: AgentApiRequest): Promise<unknown> {
  const params = new URLSearchParams();
  if (body.status) params.set('status', body.status as string);
  if (body.engine) params.set('engine', body.engine as string);
  const url = params.toString() ? `${API_BASE}?${params}` : API_BASE;
  const res = await fetch(url);
  return res.json();
}

/**
 * Submit a new terminal task (supports claude, gemini, ollama engines)
 */
export async function submit(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'submit',
      prompt: body.prompt,
      model: body.model,
      engine: body.engine || 'claude',
      ollamaModel: body.ollamaModel,
      systemPrompt: body.systemPrompt,
      timeout: body.timeout,
      workingDirectory: body.workingDirectory,
    }),
  });
  return res.json();
}

/**
 * Get a specific terminal task
 */
export async function get(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'get',
      taskId: body.taskId,
    }),
  });
  return res.json();
}

/**
 * Cancel a running terminal task
 */
export async function cancel(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'cancel',
      taskId: body.taskId,
    }),
  });
  return res.json();
}

/**
 * List available models across all engines
 */
export async function models(_body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'models' }),
  });
  return res.json();
}

/**
 * Launch a terminal session for subscription-based provider auth.
 * Opens the provider's CLI (e.g. claude, gemini) in a named tmux session
 * and attaches a Windows Terminal tab so the user can complete sign-in.
 *
 * Params: provider (required) — e.g. "anthropic", "google"
 */
export async function launch(body: AgentApiRequest): Promise<unknown> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'launch',
      provider: body.provider,
    }),
  });
  return res.json();
}
