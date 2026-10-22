/**
 * /api/collab/enhance-prompt
 *
 * "Structure" button backend (the owner directive, 11 Jun 2026): runs an
 * enhancement pass over a pending draft message via DeepSeek (always-on
 * cloud API). Clarifies intent,
 * fixes grammar/spelling, removes ambiguity. The enhanced text is returned
 * for the UI to place back in the draft input so the human reviews it
 * before sending — this route never sends.
 *
 * GET  — current config + defaults + allowed models (settings panel).
 * PUT  — update config: { enabled?, model?, systemPrompt? }.
 * POST — run the enhancement pass: { draft, channelName?, participants? }.
 *        Honors the config: disabled → 403; uses configured model + guide.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  DEFAULT_ENHANCE_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  ENHANCE_ALLOWED_MODELS,
  readEnhanceConfig,
  sanitizeMentions,
  writeEnhanceConfig,
} from '@/lib/enhance-prompt-config';
import { requireAuthOrLocal } from '@/lib/api-auth';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MAX_DRAFT_CHARS = 12000;
const MAX_GUIDE_CHARS = 8000;
const TIMEOUT_MS = 30000;


export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const config = await readEnhanceConfig();
  return NextResponse.json({
    success: true,
    config,
    defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT, model: DEFAULT_ENHANCE_CONFIG.model },
    models: ENHANCE_ALLOWED_MODELS,
  });
}

export async function PUT(req: NextRequest) {
  const denied = await requireAuthOrLocal(req, 'write');
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const current = await readEnhanceConfig();
    const next = { ...current };

    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.model === 'string') {
      if (!ENHANCE_ALLOWED_MODELS.some(m => m.id === body.model)) {
        return NextResponse.json(
          { success: false, error: `Unknown model '${body.model}'` },
          { status: 400 },
        );
      }
      next.model = body.model;
    }
    if (typeof body.systemPrompt === 'string') {
      const guide = body.systemPrompt.trim();
      if (!guide) {
        return NextResponse.json(
          { success: false, error: 'systemPrompt cannot be empty — use the default instead' },
          { status: 400 },
        );
      }
      if (guide.length > MAX_GUIDE_CHARS) {
        return NextResponse.json(
          { success: false, error: `systemPrompt too long (max ${MAX_GUIDE_CHARS} chars)` },
          { status: 400 },
        );
      }
      next.systemPrompt = guide;
    }

    await writeEnhanceConfig(next);
    return NextResponse.json({ success: true, config: next });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAuthOrLocal(req, 'write');
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => null);
    const draft = typeof body?.draft === 'string' ? body.draft.trim() : '';
    if (!draft) {
      return NextResponse.json({ success: false, error: 'draft is required' }, { status: 400 });
    }
    if (draft.length > MAX_DRAFT_CHARS) {
      return NextResponse.json(
        { success: false, error: `draft too long (max ${MAX_DRAFT_CHARS} chars)` },
        { status: 400 },
      );
    }

    const config = await readEnhanceConfig();
    if (!config.enabled) {
      return NextResponse.json(
        { success: false, error: 'Enhance feature is disabled in settings' },
        { status: 403 },
      );
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'DEEPSEEK_API_KEY not configured on server' },
        { status: 500 },
      );
    }

    // Optional channel context — helps the model keep @mentions valid.
    const context: string[] = [];
    if (typeof body?.channelName === 'string' && body.channelName) {
      context.push(`Channel: ${body.channelName}`);
    }
    let participantNames: string[] = [];
    if (Array.isArray(body?.participants)) {
      participantNames = body.participants.filter((p: unknown): p is string => typeof p === 'string');
      if (participantNames.length) {
        context.push(`Channel participants (the only valid @mention targets): ${participantNames.join(', ')}`);
      }
    }
    const userContent =
      (context.length ? context.join('\n') + '\n\n' : '') + `Draft message:\n${draft}`;

    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return NextResponse.json(
        { success: false, error: `DeepSeek API ${resp.status}: ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const enhanced = data.choices?.[0]?.message?.content?.trim();
    if (!enhanced) {
      return NextResponse.json(
        { success: false, error: 'Model returned an empty enhancement' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      enhanced: sanitizeMentions(enhanced, participantNames),
      model: config.model,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = msg.includes('timeout') || msg.includes('aborted');
    return NextResponse.json(
      { success: false, error: timedOut ? `Enhancement timed out after ${TIMEOUT_MS / 1000}s` : msg },
      { status: timedOut ? 504 : 500 },
    );
  }
}
