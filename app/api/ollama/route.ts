import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

export const GET = tracked('/api/ollama', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'list';

  try {
    if (action === 'list') {
      const r = await fetch(`${OLLAMA_BASE}/api/tags`, { cache: 'no-store' });
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: `Ollama not reachable (${r.status})`, models: [] }, { status: 200 });
      }
      const data = await r.json();
      return NextResponse.json({ ok: true, models: data.models ?? [] });
    }

    if (action === 'version') {
      const r = await fetch(`${OLLAMA_BASE}/api/version`, { cache: 'no-store' });
      if (!r.ok) return NextResponse.json({ ok: false, version: null });
      const data = await r.json();
      return NextResponse.json({ ok: true, version: data.version });
    }

    if (action === 'running') {
      const r = await fetch(`${OLLAMA_BASE}/api/ps`, { cache: 'no-store' });
      if (!r.ok) return NextResponse.json({ ok: false, models: [] });
      const data = await r.json();
      return NextResponse.json({ ok: true, models: data.models ?? [] });
    }

    if (action === 'storage') {
      // Where Ollama stores models. Reads OLLAMA_MODELS env on the running daemon
      // via /api/show and falls back to the standard install location.
      try {
        const candidates = [
          process.env.OLLAMA_MODELS,
          '/usr/share/ollama/.ollama/models',
          `${process.env.HOME ?? '/root'}/.ollama/models`,
        ].filter((p): p is string => Boolean(p));
        let chosen: string | null = null;
        let totalBytes = 0;
        for (const path of candidates) {
          try {
            const { stdout } = await execAsync(`du -sb "${path}" 2>/dev/null | cut -f1`, { timeout: 3000 });
            const size = Number(stdout.trim());
            if (size > 0) {
              chosen = path;
              totalBytes = size;
              break;
            }
          } catch { /* try next */ }
        }
        // Disk free space at that mount
        let freeBytes = 0;
        if (chosen) {
          try {
            const { stdout } = await execAsync(`df -B1 "${chosen}" | tail -1 | awk '{print $4}'`, { timeout: 2000 });
            freeBytes = Number(stdout.trim());
          } catch { /* ignore */ }
        }
        return NextResponse.json({ ok: true, path: chosen, used_bytes: totalBytes, free_bytes: freeBytes });
      } catch (err) {
        return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown' });
      }
    }

    if (action === 'check-update') {
      // Compare local digest with registry's latest digest for the same tag.
      const name = url.searchParams.get('name');
      if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
      const [model, tag = 'latest'] = name.split(':');
      try {
        const localR = await fetch(`${OLLAMA_BASE}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const localJ = localR.ok ? await localR.json() : null;
        const localDigest = localJ?.details?.digest ?? null;

        // Registry manifest endpoint returns sha256 in headers + body
        const remoteR = await fetch(`https://registry.ollama.ai/v2/library/${model}/manifests/${tag}`, {
          headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
        });
        if (!remoteR.ok) {
          return NextResponse.json({ ok: false, error: `Registry returned ${remoteR.status}` });
        }
        const remoteDigest = remoteR.headers.get('docker-content-digest') ?? null;
        const remoteBody = await remoteR.json().catch(() => null);
        const localDigestNorm = localDigest?.startsWith('sha256:') ? localDigest : `sha256:${localDigest}`;
        const upToDate = remoteDigest && localDigestNorm && remoteDigest === localDigestNorm;
        return NextResponse.json({
          ok: true,
          local_digest: localDigest,
          remote_digest: remoteDigest,
          up_to_date: upToDate,
          remote_size_bytes: remoteBody?.layers?.reduce((s: number, l: { size?: number }) => s + (l.size ?? 0), 0) ?? null,
        });
      } catch (err) {
        return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown' });
      }
    }

    if (action === 'gpu') {
      // nvidia-smi works under WSL2 with the NVIDIA driver bridge.
      try {
        const { stdout } = await execAsync(
          'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits',
          { timeout: 3000 }
        );
        const lines = stdout.trim().split('\n').filter(Boolean);
        const gpus = lines.map((line, idx) => {
          const [name, total, used, free] = line.split(',').map(s => s.trim());
          return {
            index: idx,
            name,
            total_mb: Number(total),
            used_mb: Number(used),
            free_mb: Number(free),
          };
        });
        return NextResponse.json({ ok: true, gpus });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'nvidia-smi unavailable';
        return NextResponse.json({ ok: false, error: msg, gpus: [] });
      }
    }

    if (action === 'show') {
      const name = url.searchParams.get('name');
      if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
      const r = await fetch(`${OLLAMA_BASE}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) return NextResponse.json({ ok: false, error: `show failed (${r.status})` });
      const data = await r.json();
      // Pull the architecture-prefixed fields needed for KV-cache math.
      const mi = data.model_info ?? {};
      const arch = data.details?.family ?? Object.keys(mi).find(k => k.includes('.context_length'))?.split('.')[0];
      const get = (suffix: string) => {
        const k = Object.keys(mi).find(key => key.endsWith(suffix));
        return k ? mi[k] : null;
      };
      const arch_info = {
        architecture: arch,
        context_length: get('.context_length'),
        embedding_length: get('.embedding_length'),
        head_count: get('.attention.head_count'),
        head_count_kv: get('.attention.head_count_kv'),
        block_count: get('.block_count') ?? get('.layer_count'),
      };
      return NextResponse.json({
        ok: true,
        details: data.details,
        parameters: data.parameters,
        template: data.template?.slice(0, 2000),
        modelfile: data.modelfile?.slice(0, 4000),
        capabilities: data.capabilities,
        arch_info,
        // Send the raw model_info too so the UI can show extras.
        model_info: mi,
      });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: msg, models: [] }, { status: 200 });
  }
});

export const POST = tracked('/api/ollama', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  let body: { action?: string; model?: string; prompt?: string; messages?: Array<{ role: string; content: string }>; system?: string; stream?: boolean; num_ctx?: number } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, model } = body;
  // Ollama defaults to num_ctx 4096 — useless for harness work. Default to 32K
  // unless caller overrides. Big jumps in num_ctx cost VRAM via KV cache.
  const numCtx = typeof body.num_ctx === 'number' && body.num_ctx > 0 ? body.num_ctx : 32768;

  try {
    if (action === 'pull') {
      if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
      // Stream pull progress back to the client as NDJSON
      const upstream = await fetch(`${OLLAMA_BASE}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      });
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ ok: false, error: `Pull failed (${upstream.status})` }, { status: 502 });
      }
      return new Response(upstream.body, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    if (action === 'delete') {
      if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
      const r = await fetch(`${OLLAMA_BASE}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      return NextResponse.json({ ok: r.ok, status: r.status });
    }

    if (action === 'load') {
      if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
      // Empty prompt + keep_alive forces Ollama to load the model into memory.
      // Pass num_ctx so the KV cache is sized correctly at load (changing later
      // requires a reload).
      const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: '5m', options: { num_ctx: numCtx } }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return NextResponse.json({ ok: false, error: `Load failed (${r.status}): ${text}` }, { status: 502 });
      }
      const data = await r.json();
      return NextResponse.json({ ok: true, model: data.model, done_reason: data.done_reason });
    }

    if (action === 'unload') {
      if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
      // keep_alive: 0 tells Ollama to immediately unload the model from memory.
      const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return NextResponse.json({ ok: false, error: `Unload failed (${r.status}): ${text}` }, { status: 502 });
      }
      const data = await r.json();
      return NextResponse.json({ ok: true, model: data.model, done_reason: data.done_reason });
    }

    if (action === 'chat' || action === 'chat-stream') {
      if (!model) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
      const messages = body.messages
        ?? (body.prompt ? [{ role: 'user', content: body.prompt }] : []);
      if (messages.length === 0) {
        return NextResponse.json({ ok: false, error: 'prompt or messages required' }, { status: 400 });
      }
      const stream = action === 'chat-stream';
      const upstream = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream,
          options: { num_ctx: numCtx },
          ...(body.system ? { system: body.system } : {}),
        }),
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return NextResponse.json({ ok: false, error: `Chat failed (${upstream.status}): ${text}` }, { status: 502 });
      }
      if (stream) {
        if (!upstream.body) return NextResponse.json({ ok: false, error: 'no upstream body' }, { status: 502 });
        return new Response(upstream.body, {
          headers: {
            'Content-Type': 'application/x-ndjson',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      const data = await upstream.json();
      return NextResponse.json({
        ok: true,
        message: data.message?.content ?? '',
        model: data.model,
        total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1_000_000) : null,
        eval_count: data.eval_count ?? null,
      });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
