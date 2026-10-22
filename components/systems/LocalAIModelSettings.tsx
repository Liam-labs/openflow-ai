'use client';

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Cpu, Zap, AlertTriangle, RefreshCw, Info, ExternalLink, HardDrive, CheckCircle2, Download } from 'lucide-react';

interface ModelArchInfo {
  architecture?: string;
  context_length?: number;
  embedding_length?: number;
  head_count?: number;
  head_count_kv?: number;
  block_count?: number;
}

interface ShowResponse {
  ok: boolean;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
  arch_info?: ModelArchInfo;
  capabilities?: string[];
}

interface GpuInfo {
  index: number;
  name: string;
  total_mb: number;
  used_mb: number;
  free_mb: number;
}

interface StorageInfo {
  ok: boolean;
  path: string | null;
  used_bytes: number;
  free_bytes: number;
}

const QUANT_BITS: Record<string, number> = {
  Q2_K:    3.0,
  Q3_K_S:  3.5,
  Q3_K_M:  3.7,
  Q4_K_S:  4.3,
  Q4_K_M:  4.85,
  Q5_K_S:  5.2,
  Q5_K_M:  5.5,
  Q6_K:    6.6,
  Q8_0:    8.5,
  FP16:    16,
  BF16:    16,
};

const QUANT_LIST = ['Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'FP16'] as const;

interface Props {
  modelName: string;
  modelSize: number;
  isLoaded: boolean;
  onClose: () => void;
  onLoadWithCtx: (ctx: number) => void;
  onUnload: () => void;
  loadingState: { model: string; action: 'load' | 'unload' } | null;
}

const CTX_PRESETS = [
  { label: '4K',   value: 4096 },
  { label: '8K',   value: 8192 },
  { label: '16K',  value: 16384 },
  { label: '32K',  value: 32768 },
  { label: '64K',  value: 65536 },
  { label: '128K', value: 131072 },
];

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

export function LocalAIModelSettings({
  modelName,
  modelSize,
  isLoaded,
  onClose,
  onLoadWithCtx,
  onUnload,
  loadingState,
}: Props) {
  const [info, setInfo] = useState<ShowResponse | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState<number>(32768);
  const [selectedQuant, setSelectedQuant] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{ checking: boolean; up_to_date?: boolean; remote_size_bytes?: number; error?: string } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [showR, gpuR, storageR] = await Promise.all([
        fetch(`/api/ollama?action=show&name=${encodeURIComponent(modelName)}`, { cache: 'no-store' }),
        fetch('/api/ollama?action=gpu', { cache: 'no-store' }),
        fetch('/api/ollama?action=storage', { cache: 'no-store' }),
      ]);
      const showJ = await showR.json();
      const gpuJ = await gpuR.json();
      const storageJ = await storageR.json();
      setInfo(showJ);
      setGpu(gpuJ.ok && gpuJ.gpus.length ? gpuJ.gpus[0] : null);
      setStorage(storageJ.ok ? storageJ : null);

      const native = showJ?.arch_info?.context_length;
      if (typeof native === 'number') {
        setCtx(Math.min(32768, native));
      }
      setSelectedQuant(showJ?.details?.quantization_level ?? null);
    } finally {
      setLoading(false);
    }
  }, [modelName]);

  const checkForUpdate = async () => {
    setUpdateInfo({ checking: true });
    try {
      const r = await fetch(`/api/ollama?action=check-update&name=${encodeURIComponent(modelName)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) {
        setUpdateInfo({ checking: false, error: j.error });
      } else {
        setUpdateInfo({ checking: false, up_to_date: j.up_to_date, remote_size_bytes: j.remote_size_bytes });
      }
    } catch (err) {
      setUpdateInfo({ checking: false, error: err instanceof Error ? err.message : 'Unknown' });
    }
  };

  useEffect(() => { load(); }, [load]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const arch = info?.arch_info;
  const headDim = arch?.embedding_length && arch?.head_count
    ? Math.floor(arch.embedding_length / arch.head_count)
    : null;
  const kvCacheBytes = (
    arch?.block_count && arch?.head_count_kv && headDim
      ? 2 * arch.block_count * arch.head_count_kv * headDim * ctx * 2
      : null
  );

  const currentQuantBits = info?.details?.quantization_level && QUANT_BITS[info.details.quantization_level]
    ? QUANT_BITS[info.details.quantization_level]
    : QUANT_BITS.Q4_K_M;
  const targetBits = (selectedQuant && QUANT_BITS[selectedQuant]) || currentQuantBits;
  const scaledWeights = selectedQuant && selectedQuant !== info?.details?.quantization_level
    ? Math.round(modelSize * (targetBits / currentQuantBits))
    : modelSize;

  const overheadBytes = (scaledWeights + (kvCacheBytes ?? 0)) * 0.10;
  const totalBytes = scaledWeights + (kvCacheBytes ?? 0) + overheadBytes;

  const freeMb = gpu?.free_mb ?? 0;
  const totalMb = gpu?.total_mb ?? 0;
  const totalRequiredMb = totalBytes / (1024 * 1024);
  const overflowMb = Math.max(0, totalRequiredMb - freeMb);
  const willSpill = overflowMb > 0;

  const nativeCtx = arch?.context_length ?? 131072;
  const presets = CTX_PRESETS.filter(p => p.value <= nativeCtx);
  const isBusy = loadingState?.model === modelName;

  if (!mounted) return null;

  return createPortal(
    <div
      onClick={onClose}
      className="laims-backdrop"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="laims-shell"
        role="dialog"
        aria-modal="true"
        aria-label={`${modelName} settings`}
      >
        {/* Header (sticky) */}
        <header className="laims-header">
          <div className="laims-header-glow" />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--df-text-muted)', fontWeight: 600 }}>
                Model Settings
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: 'var(--df-text)', letterSpacing: -0.2, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {modelName}
              </div>
              <div style={{ fontSize: 11, marginTop: 2, color: 'var(--df-text-muted)' }}>
                Architecture, context window & VRAM planner
              </div>
            </div>
            <button onClick={onClose} className="laims-close" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Body (scrolls) */}
        <div className="laims-body">
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--df-text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <RefreshCw size={20} className="laims-spin" style={{ color: 'var(--df-accent)' }} />
              <div style={{ fontSize: 12, letterSpacing: 0.4 }}>Loading model info…</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {/* Architecture */}
              <section>
                <SectionTitle>Model</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
                  <Field label="Architecture" value={arch?.architecture ?? '—'} />
                  <Field label="Parameters" value={info?.details?.parameter_size ?? '—'} />
                  <Field label="Quantization" value={info?.details?.quantization_level ?? '—'} />
                  <Field label="Native ctx" value={nativeCtx ? `${(nativeCtx / 1024).toFixed(0)}K` : '—'} />
                  <Field label="Layers" value={arch?.block_count ?? '—'} />
                  <Field label="KV heads" value={arch?.head_count_kv ?? '—'} />
                  <Field label="Head dim" value={headDim ?? '—'} />
                  <Field label="Weights" value={formatGb(modelSize)} />
                </div>
                {info?.capabilities && info.capabilities.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {info.capabilities.map(cap => (
                      <span key={cap} className="laims-chip">{cap}</span>
                    ))}
                  </div>
                )}
              </section>

              {/* Context */}
              <section>
                <SectionTitle>Context Window</SectionTitle>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {presets.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setCtx(p.value)}
                      className={`laims-pill${ctx === p.value ? ' is-active' : ''}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  type="range"
                  min={2048}
                  max={nativeCtx}
                  step={1024}
                  value={ctx}
                  onChange={e => setCtx(Number(e.target.value))}
                  className="laims-slider"
                />
                <div style={{ fontSize: 11, color: 'var(--df-text-muted)', marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{ctx.toLocaleString()} tokens · <strong style={{ color: 'var(--df-text-secondary)' }}>{(ctx / 1024).toFixed(0)}K</strong></span>
                  <span>max {(nativeCtx / 1024).toFixed(0)}K</span>
                </div>
              </section>

              {/* VRAM */}
              <section>
                <SectionTitle>VRAM Budget</SectionTitle>
                {gpu ? (
                  <div style={{ fontSize: 12, color: 'var(--df-text-secondary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Cpu size={12} style={{ color: 'var(--df-accent)' }} />
                    <span style={{ color: 'var(--df-text)' }}>{gpu.name}</span>
                    <span style={{ color: 'var(--df-text-muted)' }}>·</span>
                    <span>{formatMb(gpu.total_mb)} total</span>
                    <span style={{ color: 'var(--df-text-muted)' }}>·</span>
                    <span style={{ color: 'var(--df-success)' }}>{formatMb(gpu.free_mb)} free</span>
                    <span style={{ color: 'var(--df-text-muted)' }}>·</span>
                    <span>{formatMb(gpu.used_mb)} in use</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--df-text-muted)', marginBottom: 10 }}>GPU info unavailable (nvidia-smi)</div>
                )}

                <VramBar
                  weightsMb={scaledWeights / (1024 * 1024)}
                  kvMb={(kvCacheBytes ?? 0) / (1024 * 1024)}
                  overheadMb={overheadBytes / (1024 * 1024)}
                  totalGpuMb={totalMb || totalRequiredMb}
                />

                <div style={{ marginTop: 12, fontSize: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  <Field label={`Weights (${selectedQuant ?? '—'})`} value={formatGb(scaledWeights)} dotColor="#3b82f6" />
                  <Field label={`KV cache @${(ctx/1024).toFixed(0)}K`} value={kvCacheBytes ? formatGb(kvCacheBytes) : '—'} dotColor="#22c55e" />
                  <Field label="Overhead (~10%)" value={formatGb(overheadBytes)} dotColor="#a48eff" />
                  <Field label="Total required" value={formatGb(totalBytes)} bold />
                </div>

                {willSpill && gpu && (
                  <div className="laims-callout laims-callout-warn">
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <strong>Spillover to system RAM: {formatMb(overflowMb)}</strong>
                      <div style={{ fontSize: 11, marginTop: 3, opacity: 0.85 }}>
                        Required ({formatMb(totalRequiredMb)}) exceeds free VRAM ({formatMb(freeMb)}). Ollama will offload some layers to CPU. Inference will be slower.
                      </div>
                    </div>
                  </div>
                )}
                {!willSpill && gpu && (
                  <div className="laims-callout laims-callout-ok">
                    <Zap size={14} style={{ flexShrink: 0 }} />
                    <span>Fits in VRAM — full GPU inference. <strong>{formatMb(freeMb - totalRequiredMb)}</strong> headroom.</span>
                  </div>
                )}
              </section>

              {/* Quantization */}
              <section>
                <SectionTitle>Quantization</SectionTitle>
                <div style={{ fontSize: 12, color: 'var(--df-text-secondary)', marginBottom: 10 }}>
                  Current: <strong style={{ color: 'var(--df-text)' }}>{info?.details?.quantization_level ?? 'unknown'}</strong>
                  {info?.details?.quantization_level && (
                    <span style={{ marginLeft: 6, color: 'var(--df-text-muted)' }}>(picker estimates other tags only)</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {QUANT_LIST.map(q => {
                    const isCurrent = q === info?.details?.quantization_level;
                    const isSelected = q === selectedQuant;
                    const disabled = !!info?.details?.quantization_level && !isCurrent;
                    return (
                      <button
                        key={q}
                        onClick={() => !disabled && setSelectedQuant(q)}
                        disabled={disabled}
                        title={disabled ? `Already at ${info?.details?.quantization_level}. Pull a different tag from the registry to switch.` : `Estimate VRAM at ${q}`}
                        className={`laims-pill${isSelected ? ' is-active' : ''}${isCurrent ? ' is-current' : ''}`}
                      >
                        {q}{isCurrent ? ' ✓' : ''}
                      </button>
                    );
                  })}
                </div>
                <div className="laims-info-box">
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                    <Info size={12} style={{ flexShrink: 0, color: 'var(--df-accent)' }} />
                    <strong style={{ color: 'var(--df-text)' }}>Why the picker is disabled on quantized models</strong>
                  </div>
                  <div>
                    Ollama can&apos;t recompress an already-quantized GGUF — it needs the original FP16/BF16 weights and a llama.cpp <code>--quantize</code> pass. To switch quant levels, pull a different tag from the registry instead.
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <a
                      href={`https://ollama.com/library/${modelName.split(':')[0]}/tags`}
                      target="_blank" rel="noreferrer"
                      className="laims-link"
                    >
                      Browse all tags for {modelName.split(':')[0]} <ExternalLink size={11} />
                    </a>
                  </div>
                </div>
              </section>

              {/* Storage */}
              <section>
                <SectionTitle>Storage &amp; Updates</SectionTitle>
                {storage?.path ? (
                  <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--df-text-secondary)', flexWrap: 'wrap' }}>
                    <HardDrive size={12} style={{ color: 'var(--df-accent)', flexShrink: 0 }} />
                    <code style={{ fontSize: 11, padding: '3px 7px', background: 'var(--df-accent-6)', border: '1px solid var(--df-border-subtle)', borderRadius: 4, color: 'var(--df-text)' }}>{storage.path}</code>
                    <span style={{ color: 'var(--df-text-muted)' }}>{formatGb(storage.used_bytes)} used · {formatGb(storage.free_bytes)} free</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--df-text-muted)', marginBottom: 10 }}>Storage path unavailable</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button onClick={checkForUpdate} disabled={updateInfo?.checking} className="laims-btn-ghost">
                    <Download size={12} className={updateInfo?.checking ? 'laims-spin' : ''} />
                    {updateInfo?.checking ? 'Checking…' : 'Check for updates'}
                  </button>
                  {updateInfo && !updateInfo.checking && (
                    <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {updateInfo.error && <span style={{ color: 'var(--df-error)' }}>Error: {updateInfo.error}</span>}
                      {updateInfo.up_to_date === true && (
                        <><CheckCircle2 size={13} style={{ color: 'var(--df-success)' }} /> <span style={{ color: 'var(--df-success)' }}>Up to date</span></>
                      )}
                      {updateInfo.up_to_date === false && (
                        <><AlertTriangle size={13} style={{ color: 'var(--df-warning)' }} /> <span style={{ color: 'var(--df-warning)' }}>Newer version available{updateInfo.remote_size_bytes ? ` (${formatGb(updateInfo.remote_size_bytes)})` : ''} — re-pull to update</span></>
                      )}
                    </span>
                  )}
                </div>
              </section>

              {/* TurboQuant */}
              <section>
                <SectionTitle>TurboQuant</SectionTitle>
                <div className="laims-info-box">
                  Google&apos;s official code is unreleased (expected Q2 2026). An unofficial PyPI package (<code>turboquant</code>) exists but is PyTorch-only — <strong style={{ color: 'var(--df-text)' }}>no GGUF or Ollama support today</strong>. The closest in-box equivalent is Ollama&apos;s KV cache quantization: set <code>OLLAMA_KV_CACHE_TYPE=q8_0</code> (or <code>q4_0</code>) in the Ollama service env to roughly halve KV-cache VRAM. That&apos;s a server-wide setting, not per-model.
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Footer (sticky) */}
        <footer className="laims-footer">
          <button onClick={load} disabled={loading} className="laims-btn-ghost">
            <RefreshCw size={12} className={loading ? 'laims-spin' : ''} /> Refresh
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {isLoaded && (
              <button
                onClick={() => { onUnload(); onClose(); }}
                disabled={isBusy}
                className="laims-btn-warn"
              >
                Unload
              </button>
            )}
            <button
              onClick={() => { onLoadWithCtx(ctx); onClose(); }}
              disabled={isBusy}
              className="laims-btn-primary"
            >
              {isLoaded ? `Reload @ ${(ctx/1024).toFixed(0)}K` : `Load @ ${(ctx/1024).toFixed(0)}K`}
            </button>
          </div>
        </footer>
      </div>

      <style jsx>{`
        .laims-backdrop {
          position: fixed; inset: 0;
          background: radial-gradient(ellipse at center, rgba(5, 10, 25, 0.55) 0%, rgba(0, 0, 0, 0.78) 100%);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          z-index: 9999;
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
          animation: laims-fade-in 180ms ease-out;
        }
        .laims-shell {
          background: linear-gradient(180deg, rgba(15, 25, 50, 0.92) 0%, rgba(8, 12, 28, 0.94) 100%);
          backdrop-filter: blur(20px) saturate(140%);
          -webkit-backdrop-filter: blur(20px) saturate(140%);
          border: 1px solid var(--df-border, rgba(59, 130, 246, 0.2));
          border-radius: 16px;
          width: min(760px, 100%);
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          box-shadow:
            0 24px 64px rgba(0, 0, 0, 0.55),
            0 0 0 1px rgba(255, 255, 255, 0.03) inset,
            0 1px 0 rgba(255, 255, 255, 0.06) inset;
          color: var(--df-text, #e4e4e7);
          font-family: var(--font-sans, system-ui), sans-serif;
          animation: laims-pop-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
          overflow: hidden;
        }
        .laims-header {
          position: relative;
          padding: 18px 22px 16px;
          border-bottom: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          flex-shrink: 0;
          background: linear-gradient(180deg, var(--df-accent-8, rgba(59, 130, 246, 0.08)) 0%, transparent 100%);
        }
        .laims-header-glow {
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent 0%, var(--df-accent, #3b82f6) 50%, transparent 100%);
          opacity: 0.55;
        }
        .laims-close {
          background: transparent;
          border: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          border-radius: 8px;
          width: 30px; height: 30px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          color: var(--df-text-secondary, #a1a1aa);
          transition: all 140ms ease;
          flex-shrink: 0;
        }
        .laims-close:hover {
          background: var(--df-accent-10, rgba(59, 130, 246, 0.1));
          border-color: var(--df-border-hover, rgba(59, 130, 246, 0.4));
          color: var(--df-text, #e4e4e7);
        }
        .laims-body {
          flex: 1 1 auto;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 22px;
          scrollbar-width: thin;
          scrollbar-color: var(--df-accent-30, rgba(59, 130, 246, 0.3)) transparent;
        }
        .laims-body::-webkit-scrollbar { width: 8px; }
        .laims-body::-webkit-scrollbar-track { background: transparent; }
        .laims-body::-webkit-scrollbar-thumb {
          background: var(--df-accent-20, rgba(59, 130, 246, 0.2));
          border-radius: 4px;
        }
        .laims-body::-webkit-scrollbar-thumb:hover {
          background: var(--df-accent-40, rgba(59, 130, 246, 0.4));
        }
        .laims-footer {
          padding: 14px 22px;
          border-top: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          background: linear-gradient(0deg, var(--df-accent-4, rgba(59, 130, 246, 0.04)) 0%, transparent 100%);
          display: flex;
          gap: 8px;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .laims-pill {
          padding: 6px 12px;
          font-size: 12px;
          border-radius: 6px;
          cursor: pointer;
          background: var(--df-surface-input, rgba(10, 20, 40, 0.4));
          border: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          color: var(--df-text-secondary, #a1a1aa);
          transition: all 140ms ease;
          font-family: inherit;
          letter-spacing: 0.2px;
        }
        .laims-pill:hover:not(:disabled) {
          border-color: var(--df-border-hover, rgba(59, 130, 246, 0.4));
          color: var(--df-text, #e4e4e7);
          transform: translateY(-1px);
        }
        .laims-pill:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .laims-pill.is-active {
          background: linear-gradient(180deg, var(--df-accent, #3b82f6) 0%, var(--df-accent-dark, #2563eb) 100%);
          border-color: var(--df-accent, #3b82f6);
          color: white;
          font-weight: 600;
          box-shadow: 0 2px 8px var(--df-accent-30, rgba(59, 130, 246, 0.3));
        }
        .laims-pill.is-current {
          font-weight: 600;
        }
        .laims-chip {
          font-size: 10px;
          padding: 3px 8px;
          border-radius: 999px;
          background: var(--df-accent-8, rgba(59, 130, 246, 0.08));
          border: 1px solid var(--df-accent-20, rgba(59, 130, 246, 0.2));
          color: var(--df-accent, #3b82f6);
          letter-spacing: 0.4px;
          text-transform: uppercase;
          font-weight: 600;
        }
        .laims-callout {
          margin-top: 12px;
          padding: 11px 12px;
          border-radius: 8px;
          font-size: 12px;
          display: flex;
          gap: 10px;
          align-items: flex-start;
          line-height: 1.5;
        }
        .laims-callout-warn {
          background: rgba(234, 179, 8, 0.08);
          border: 1px solid rgba(234, 179, 8, 0.28);
          color: var(--df-warning, #eab308);
        }
        .laims-callout-ok {
          background: rgba(34, 197, 94, 0.08);
          border: 1px solid rgba(34, 197, 94, 0.28);
          color: var(--df-success, #22c55e);
          align-items: center;
        }
        .laims-info-box {
          padding: 12px;
          background: var(--df-accent-4, rgba(59, 130, 246, 0.04));
          border: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          border-radius: 8px;
          font-size: 11.5px;
          line-height: 1.6;
          color: var(--df-text-secondary, #a1a1aa);
        }
        .laims-info-box code {
          padding: 1px 5px;
          background: var(--df-accent-10, rgba(59, 130, 246, 0.1));
          border-radius: 3px;
          font-size: 11px;
          color: var(--df-text, #e4e4e7);
          font-family: var(--font-mono, monospace);
        }
        .laims-link {
          color: var(--df-accent, #3b82f6);
          display: inline-flex;
          align-items: center;
          gap: 4px;
          text-decoration: none;
          font-weight: 500;
          font-size: 12px;
          transition: color 140ms ease;
        }
        .laims-link:hover {
          color: var(--df-accent-hover, #60a5fa);
          text-decoration: underline;
        }
        .laims-btn-ghost {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 12px;
          background: transparent;
          border: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
          border-radius: 6px;
          cursor: pointer;
          color: var(--df-text-secondary, #a1a1aa);
          font-size: 12px;
          font-family: inherit;
          transition: all 140ms ease;
        }
        .laims-btn-ghost:hover:not(:disabled) {
          background: var(--df-accent-8, rgba(59, 130, 246, 0.08));
          border-color: var(--df-border-hover, rgba(59, 130, 246, 0.4));
          color: var(--df-text, #e4e4e7);
        }
        .laims-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
        .laims-btn-primary {
          padding: 8px 18px;
          background: linear-gradient(180deg, var(--df-accent, #3b82f6) 0%, var(--df-accent-dark, #2563eb) 100%);
          border: 1px solid var(--df-accent, #3b82f6);
          border-radius: 6px;
          cursor: pointer;
          color: white;
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          transition: all 140ms ease;
          box-shadow: 0 2px 8px var(--df-accent-25, rgba(59, 130, 246, 0.25));
          letter-spacing: 0.2px;
        }
        .laims-btn-primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 14px var(--df-accent-40, rgba(59, 130, 246, 0.4));
        }
        .laims-btn-primary:active:not(:disabled) { transform: translateY(0); }
        .laims-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .laims-btn-warn {
          padding: 8px 16px;
          background: rgba(234, 179, 8, 0.1);
          border: 1px solid rgba(234, 179, 8, 0.35);
          border-radius: 6px;
          cursor: pointer;
          color: var(--df-warning, #eab308);
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          transition: all 140ms ease;
        }
        .laims-btn-warn:hover:not(:disabled) {
          background: rgba(234, 179, 8, 0.18);
          border-color: rgba(234, 179, 8, 0.55);
        }
        .laims-btn-warn:disabled { opacity: 0.5; cursor: not-allowed; }
        .laims-slider {
          width: 100%;
          height: 6px;
          -webkit-appearance: none;
          appearance: none;
          background: var(--df-surface-input, rgba(10, 20, 40, 0.4));
          border-radius: 3px;
          outline: none;
          border: 1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1));
        }
        .laims-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px; height: 16px;
          background: linear-gradient(180deg, var(--df-accent-hover, #60a5fa) 0%, var(--df-accent, #3b82f6) 100%);
          border: 2px solid white;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 6px var(--df-accent-40, rgba(59, 130, 246, 0.4));
          transition: transform 140ms ease;
        }
        .laims-slider::-webkit-slider-thumb:hover { transform: scale(1.15); }
        .laims-slider::-moz-range-thumb {
          width: 16px; height: 16px;
          background: var(--df-accent, #3b82f6);
          border: 2px solid white;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 6px var(--df-accent-40, rgba(59, 130, 246, 0.4));
        }
        .laims-spin { animation: laims-spin 1s linear infinite; }
        @keyframes laims-spin { to { transform: rotate(360deg); } }
        @keyframes laims-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes laims-pop-in {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>,
    document.body
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      color: 'var(--df-text-muted, #71717a)',
      marginBottom: 10,
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{
        width: 3, height: 12, borderRadius: 2,
        background: 'linear-gradient(180deg, var(--df-accent, #3b82f6) 0%, var(--df-accent-dark, #2563eb) 100%)',
      }} />
      {children}
    </div>
  );
}

function Field({ label, value, bold, dotColor }: { label: string; value: React.ReactNode; bold?: boolean; dotColor?: string }) {
  return (
    <div>
      <div style={{
        fontSize: 10,
        color: 'var(--df-text-muted, #71717a)',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontWeight: 500,
      }}>
        {dotColor && <span style={{ width: 7, height: 7, borderRadius: 4, background: dotColor, display: 'inline-block', boxShadow: `0 0 6px ${dotColor}` }} />}
        {label}
      </div>
      <div style={{
        fontSize: 13,
        fontWeight: bold ? 700 : 500,
        marginTop: 4,
        color: bold ? 'var(--df-accent-hover, #60a5fa)' : 'var(--df-text, #e4e4e7)',
        fontFamily: bold ? 'var(--font-mono, monospace)' : 'inherit',
      }}>{value}</div>
    </div>
  );
}

function VramBar({ weightsMb, kvMb, overheadMb, totalGpuMb }: { weightsMb: number; kvMb: number; overheadMb: number; totalGpuMb: number }) {
  const total = weightsMb + kvMb + overheadMb;
  const widthBasis = Math.max(total, totalGpuMb);
  const w = (mb: number) => `${(mb / widthBasis) * 100}%`;
  const gpuLineLeft = totalGpuMb < total ? (totalGpuMb / widthBasis) * 100 : null;
  return (
    <div style={{
      position: 'relative',
      height: 26,
      borderRadius: 6,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--df-border-subtle, rgba(59, 130, 246, 0.1))',
      overflow: 'hidden',
      display: 'flex',
      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)',
    }}>
      <div style={{
        width: w(weightsMb),
        background: 'linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)',
        boxShadow: '0 0 10px rgba(59, 130, 246, 0.4)',
      }} title={`Weights ${formatMb(weightsMb)}`} />
      <div style={{
        width: w(kvMb),
        background: 'linear-gradient(180deg, #4ade80 0%, #22c55e 100%)',
        boxShadow: '0 0 10px rgba(34, 197, 94, 0.4)',
      }} title={`KV cache ${formatMb(kvMb)}`} />
      <div style={{
        width: w(overheadMb),
        background: 'linear-gradient(180deg, #c4b5fd 0%, #a48eff 100%)',
      }} title={`Overhead ${formatMb(overheadMb)}`} />
      {gpuLineLeft !== null && (
        <div
          title={`GPU VRAM limit: ${formatMb(totalGpuMb)}`}
          style={{
            position: 'absolute',
            top: -3, bottom: -3,
            left: `${gpuLineLeft}%`,
            width: 2,
            background: '#ef4444',
            boxShadow: '0 0 8px rgba(239, 68, 68, 0.9), 0 0 2px rgba(255, 255, 255, 0.4)',
          }}
        />
      )}
    </div>
  );
}
