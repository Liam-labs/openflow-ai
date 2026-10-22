/**
 * POST /api/setup/test-key
 *
 * Validates an API key by making a lightweight call to the provider.
 * Used by the wizard's "Test Connection" button on Step 2.
 *
 * Body: { provider: 'anthropic'|'openrouter'|'grok'|'ollama', key: string, url?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

interface TestKeyRequest {
  provider: 'anthropic' | 'openrouter' | 'grok' | 'ollama';
  key?: string;
  url?: string;
}

interface TestKeyResponse {
  success: boolean;
  provider: string;
  error?: string;
  details?: {
    models?: number;
    version?: string;
  };
}

async function testAnthropic(key: string): Promise<TestKeyResponse> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return { success: true, provider: 'anthropic' };
    }

    // 401 = bad key, 429 = rate limited (key is valid), 400 = bad request (key may be valid)
    if (res.status === 429) {
      return { success: true, provider: 'anthropic', details: { version: 'rate-limited but valid' } };
    }

    const body = await res.json().catch(() => ({}));
    const errObj = (body as Record<string, unknown>)?.error;
    const errorMsg = typeof errObj === 'object' && errObj !== null
      ? (errObj as Record<string, unknown>).message as string || `HTTP ${res.status}`
      : String(errObj || `HTTP ${res.status}`);
    return { success: false, provider: 'anthropic', error: errorMsg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    return { success: false, provider: 'anthropic', error: msg };
  }
}

async function testOpenRouter(key: string): Promise<TestKeyResponse> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data.length : 0;
      return { success: true, provider: 'openrouter', details: { models } };
    }

    return { success: false, provider: 'openrouter', error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    return { success: false, provider: 'openrouter', error: msg };
  }
}

async function testGrok(key: string): Promise<TestKeyResponse> {
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data.length : 0;
      return { success: true, provider: 'grok', details: { models } };
    }

    return { success: false, provider: 'grok', error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    return { success: false, provider: 'grok', error: msg };
  }
}

async function testOllama(url: string): Promise<TestKeyResponse> {
  try {
    const baseUrl = url.replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models.length : 0;
      return { success: true, provider: 'ollama', details: { models } };
    }

    return { success: false, provider: 'ollama', error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    return { success: false, provider: 'ollama', error: msg };
  }
}

export const POST = tracked('/api/setup/test-key', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: TestKeyRequest = await request.json();
    const { provider, key, url } = body;

    if (!provider) {
      return NextResponse.json(
        { success: false, error: 'Provider is required' },
        { status: 400 }
      );
    }

    let result: TestKeyResponse;

    switch (provider) {
      case 'anthropic':
        if (!key) {
          return NextResponse.json(
            { success: false, provider, error: 'API key required' },
            { status: 400 }
          );
        }
        result = await testAnthropic(key.trim());
        break;

      case 'openrouter':
        if (!key) {
          return NextResponse.json(
            { success: false, provider, error: 'API key required' },
            { status: 400 }
          );
        }
        result = await testOpenRouter(key.trim());
        break;

      case 'grok':
        if (!key) {
          return NextResponse.json(
            { success: false, provider, error: 'API key required' },
            { status: 400 }
          );
        }
        result = await testGrok(key.trim());
        break;

      case 'ollama': {
        if (!url) {
          return NextResponse.json(
            { success: false, provider, error: 'Ollama URL required' },
            { status: 400 }
          );
        }
        // Validate Ollama URL is localhost to prevent SSRF
        try {
          const parsed = new URL(url.trim());
          if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1') {
            return NextResponse.json(
              { success: false, provider, error: 'Ollama URL must be localhost' },
              { status: 400 }
            );
          }
        } catch {
          return NextResponse.json(
            { success: false, provider, error: 'Invalid URL format' },
            { status: 400 }
          );
        }
        result = await testOllama(url.trim());
        break;
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Setup test-key] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
});
