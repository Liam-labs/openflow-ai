/**
 * Outlook event schema + emitter — `outlook-event/v1`.
 *
 * Companion: data/central-knowledge-base/platform/outlook-email-suite.md
 * Owners: Bratac (graph-webhook), Hammond (poll-watcher).
 *
 * Both notification services (poll-based watcher + Graph push webhook) emit
 * via this module so consumers see one schema regardless of source. Schema
 * locked Sprint 1 / 2026-04-30 by Mitchell.
 *
 * Wire format (hybrid — works today AND tomorrow):
 *   1. The serialized payload is fenced inside `content` as ```outlook-event …
 *      so consumers can fence-grep without depending on handler plumbing.
 *   2. The same payload is also passed at the top level as
 *      `metadata: { client: { kind: 'outlook.notification', payload } }`.
 *      This is dropped by the current `app/api/agent/actions/collab.ts`
 *      message() handler — see T16 (Daniel) which patches the handler to
 *      passthrough `metadata.client.*` into CollabMessage.metadata. After T16
 *      ships, consumers can switch to the namespaced metadata path; until
 *      then they fence-parse. emit() costs one extra string-concat regardless.
 *
 * Dedupe contract: when both services fire for the same email, consumers
 * collapse on `dedupeKey = sha256(emailId + ':' + eventType)`. Emitters are
 * intentionally dumb — they always emit; coordination is the consumer's job.
 */

import { createHash } from 'crypto';
import { selfOrigin } from '@/lib/self-origin';

// ---------- Schema ----------

export type OutlookEventType = 'mail.received' | 'service.degraded';
export type OutlookEventSource = 'poll-watcher' | 'graph-webhook';
export type OutlookImportance = 'low' | 'normal' | 'high';

export interface OutlookEventSummary {
  subject?: string;
  from?: { address?: string; name?: string };
  bodyPreview?: string;          // ≤ 240 chars per shape lock
  hasAttachments?: boolean;
  importance?: OutlookImportance;
  parentFolderId?: string;
  parentFolderName?: string;     // resolved by graph-webhook (cached); poll-watcher omits
  webLink?: string;
}

export interface OutlookEventDelivery {
  subscriptionId?: string;       // graph-webhook only
  tenantId?: string;             // graph-webhook only
  lagMs?: number;                // graph-webhook: detectedAt − receivedAt
  pollIntervalMs?: number;       // poll-watcher only
}

export interface OutlookEvent {
  schema: 'outlook-event/v1';
  source: OutlookEventSource;
  eventType: OutlookEventType;
  watchId: string;               // poll-watcher: watch.id; graph-webhook: subscriptionId
  emailId: string;               // Graph message id; pass to readEmail()
  dedupeKey: string;             // sha256(emailId + ':' + eventType)
  receivedAt: string;            // ISO 8601 — email receivedDateTime
  detectedAt: string;            // ISO 8601 — when service decided to emit
  summary: OutlookEventSummary;
  delivery: OutlookEventDelivery;
}

// ---------- Render template (poll-watcher per-watch override hook) ----------

/**
 * Per-watch override for the human-readable Markdown that precedes the fenced
 * JSON. Provided as a string with `{placeholder}` tokens or as a function for
 * full programmatic control. Tokens supported in string templates:
 *
 *   {subject}      {from.address}     {from.name}     {bodyPreview}
 *   {webLink}      {emailId}          {watchId}       {receivedAt}
 *   {source}       {parentFolderName}
 *
 * Missing fields render as empty string. The fenced ```outlook-event JSON
 * payload is always appended after the rendered template — templates control
 * the human-visible prose only.
 */
export type NotifyTemplate =
  | string
  | ((event: OutlookEvent) => string);

// ---------- Helpers ----------

/**
 * Deterministic dedupe key. Consumers SHOULD treat repeated keys within
 * a 5-minute window as duplicates and act on only the first.
 */
export function dedupeKey(emailId: string, eventType: OutlookEventType): string {
  return createHash('sha256').update(`${emailId}:${eventType}`).digest('hex');
}

export interface BuildEventArgs {
  source: OutlookEventSource;
  watchId: string;
  emailId: string;
  receivedAt: string;
  summary?: OutlookEventSummary;
  delivery?: OutlookEventDelivery;
  eventType?: OutlookEventType;   // default 'mail.received'
  detectedAt?: string;            // default new Date().toISOString()
}

/**
 * Construct a well-formed OutlookEvent. Producers SHOULD use this rather than
 * building the object literal — it stamps `schema`, computes `dedupeKey`, and
 * fills `detectedAt` consistently.
 */
export function buildEvent(args: BuildEventArgs): OutlookEvent {
  const eventType = args.eventType ?? 'mail.received';
  return {
    schema: 'outlook-event/v1',
    source: args.source,
    eventType,
    watchId: args.watchId,
    emailId: args.emailId,
    dedupeKey: dedupeKey(args.emailId, eventType),
    receivedAt: args.receivedAt,
    detectedAt: args.detectedAt ?? new Date().toISOString(),
    summary: args.summary ?? {},
    delivery: args.delivery ?? {},
  };
}

// ---------- Render ----------

const TOKEN_PATTERN = /\{([a-z][a-zA-Z0-9.]*)\}/g;

function resolveToken(event: OutlookEvent, path: string): string {
  // Whitelisted token paths only — keeps templates from leaking arbitrary
  // internal fields.
  switch (path) {
    case 'subject':            return event.summary.subject ?? '';
    case 'from.address':       return event.summary.from?.address ?? '';
    case 'from.name':          return event.summary.from?.name ?? '';
    case 'bodyPreview':        return event.summary.bodyPreview ?? '';
    case 'webLink':            return event.summary.webLink ?? '';
    case 'emailId':            return event.emailId;
    case 'watchId':            return event.watchId;
    case 'receivedAt':         return event.receivedAt;
    case 'source':             return event.source;
    case 'parentFolderName':   return event.summary.parentFolderName ?? '';
    default:                   return '';
  }
}

function defaultTemplate(event: OutlookEvent): string {
  if (event.eventType === 'service.degraded') {
    const reason = event.summary.subject ?? 'unknown';
    return `⚠️ **outlook-${event.source}** degraded — ${reason}`;
  }
  const fromName = event.summary.from?.name?.trim();
  const fromAddr = event.summary.from?.address ?? 'unknown sender';
  const fromStr = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
  const subject = event.summary.subject?.trim() || '(no subject)';
  const lines: string[] = [`📧 **${subject}** — from ${fromStr}`];
  if (event.summary.bodyPreview) {
    lines.push('', `> ${event.summary.bodyPreview.replace(/\n+/g, ' ')}`);
  }
  if (event.summary.webLink) {
    lines.push('', `[Open in Outlook](${event.summary.webLink}) · \`${event.emailId}\``);
  } else {
    lines.push('', `\`${event.emailId}\``);
  }
  return lines.join('\n');
}

function applyStringTemplate(template: string, event: OutlookEvent): string {
  return template.replace(TOKEN_PATTERN, (_, path: string) => resolveToken(event, path));
}

/**
 * Build the full message body sent as `content` on collab.message:
 *   <rendered prose>\n\n```outlook-event\n<JSON payload>\n```
 *
 * The ```outlook-event fence is the source of truth for machine consumers
 * until T16 lands the metadata passthrough.
 */
export function renderContent(event: OutlookEvent, template?: NotifyTemplate): string {
  let prose: string;
  if (typeof template === 'function') {
    prose = template(event);
  } else if (typeof template === 'string' && template.length > 0) {
    prose = applyStringTemplate(template, event);
  } else {
    prose = defaultTemplate(event);
  }
  const fence = '```outlook-event\n' + JSON.stringify(event) + '\n```';
  return `${prose}\n\n${fence}`;
}

// ---------- Emit ----------

export interface EmitArgs {
  event: OutlookEvent;
  channelId: string;
  participantId: string;
  template?: NotifyTemplate;
  mentions?: string[];
  /** Participant IDs to address (targeted delivery) instead of broadcasting. */
  targetParticipantIds?: string[];
  /** Override DevFlow base URL. Default: env DEVFLOW_API_URL or http://localhost:3000 */
  apiBase?: string;
  /** Override bearer token. Default: env DEVFLOW_API_TOKEN. Required (env or arg). */
  apiToken?: string;
  /** Inject fetch implementation for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

export interface EmitResult {
  ok: boolean;
  status: number;
  messageId?: string;
  error?: string;
}

const DEFAULT_API_BASE = selfOrigin();
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Emit an OutlookEvent onto a DevFlow collab channel.
 *
 * Wire format (per T9 lock):
 *   - body.content includes the rendered prose AND a fenced ```outlook-event
 *     JSON payload (the only path consumers can rely on today).
 *   - body.metadata.client = { kind: 'outlook.notification', payload } —
 *     dropped by the current handler; survives once T16 lands. Including it
 *     pre-emptively means consumers don't need a flag day.
 *
 * Returns an EmitResult; never throws on transport failure (returns
 * `{ ok: false }`). Throws only on misconfiguration (missing token).
 */
export async function emit(args: EmitArgs): Promise<EmitResult> {
  const apiBase = args.apiBase ?? process.env.DEVFLOW_API_URL ?? DEFAULT_API_BASE;
  const apiToken = args.apiToken ?? process.env.DEVFLOW_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      'outlook-events.emit() requires DEVFLOW_API_TOKEN (env or apiToken arg)'
    );
  }
  const fetchImpl: typeof fetch = args.fetchImpl ?? globalThis.fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const content = renderContent(args.event, args.template);

  const body = {
    action: 'collab.message',
    channelId: args.channelId,
    participantId: args.participantId,
    content,
    mentions: args.mentions,
    ...(args.targetParticipantIds?.length ? { targetParticipantIds: args.targetParticipantIds } : {}),
    metadata: {
      client: {
        kind: 'outlook.notification',
        payload: args.event,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${apiBase}/api/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: text.slice(0, 500) || res.statusText,
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      messageId?: string;
      sent?: boolean;
    };
    return {
      ok: json.sent !== false,
      status: res.status,
      messageId: json.messageId,
    };
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
    return {
      ok: false,
      status: 0,
      error: isAbort
        ? `emit() timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Fence parser (consumer helper) ----------

const FENCE_RE = /```outlook-event\s*\n([\s\S]*?)\n```/;

/**
 * Extract the OutlookEvent payload from a CollabMessage's `content` string.
 * Returns null if no fence is present or the JSON is malformed.
 *
 * Consumers SHOULD prefer `message.metadata?.client?.payload` once T16 ships
 * — fall back to this helper for messages emitted before the patch landed.
 */
export function parseEventFromContent(content: string): OutlookEvent | null {
  const match = FENCE_RE.exec(content);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as OutlookEvent;
    if (parsed?.schema === 'outlook-event/v1') return parsed;
    return null;
  } catch {
    return null;
  }
}
