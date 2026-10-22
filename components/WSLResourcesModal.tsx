'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, HardDrive, Cpu, MemoryStick, Save, AlertCircle, Check, RefreshCw, Info, Power, Loader2 } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

interface WSLResourcesModalProps {
  onClose: () => void;
}

interface SystemInfo {
  totalRamGB: number;
  totalProcessors: number;
}

interface ParsedConfig {
  memoryGB: number;
  processors: number;
  swapGB: number;
}

interface WslConfig {
  memory?: string;
  processors?: number;
  swap?: string;
  vmIdleTimeout?: number;
  gpuSupport?: boolean;
  nestedVirtualization?: boolean;
}

export function WSLResourcesModal({ onClose }: WSLResourcesModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // System detection
  const [system, setSystem] = useState<SystemInfo>({ totalRamGB: 64, totalProcessors: 24 });
  const [configPath, setConfigPath] = useState('');

  // Current values (from .wslconfig)
  const [originalConfig, setOriginalConfig] = useState<ParsedConfig>({ memoryGB: 0, processors: 0, swapGB: 0 });
  const [fullConfig, setFullConfig] = useState<WslConfig>({});

  // Editable values
  const [memoryGB, setMemoryGB] = useState(0);
  const [processors, setProcessors] = useState(0);
  const [swapGB, setSwapGB] = useState(0);
  const [gpuSupport, setGpuSupport] = useState(true);
  const [nestedVirt, setNestedVirt] = useState(true);

  const hasChanges = memoryGB !== originalConfig.memoryGB
    || processors !== originalConfig.processors
    || swapGB !== originalConfig.swapGB
    || gpuSupport !== (fullConfig.gpuSupport !== false)
    || nestedVirt !== (fullConfig.nestedVirtualization !== false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/wsl');
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to read WSL config');
      }
      const data = await res.json();

      setSystem(data.system);
      setConfigPath(data.configPath);
      setFullConfig(data.config);
      setOriginalConfig(data.parsed);

      setMemoryGB(data.parsed.memoryGB);
      setProcessors(data.parsed.processors);
      setSwapGB(data.parsed.swapGB);
      setGpuSupport(data.config.gpuSupport !== false);
      setNestedVirt(data.config.nestedVirtualization !== false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/settings/wsl', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory: `${memoryGB}GB`,
          processors,
          swap: `${swapGB}GB`,
          gpuSupport,
          nestedVirtualization: nestedVirt,
          vmIdleTimeout: fullConfig.vmIdleTimeout ?? -1,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to save WSL config');
      }

      setOriginalConfig(data.parsed);
      setFullConfig(data.config);
      setSuccess('Saved. Restart WSL to apply changes.');

      setTimeout(() => setSuccess(null), 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Restart WSL
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const handleRestartWSL = async () => {
    setRestarting(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/wsl/restart', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to restart WSL' }));
        throw new Error(data.error || 'Failed to restart WSL');
      }
      setSuccess('WSL shutdown initiated. Reconnect in a few seconds.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restart WSL');
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
    }
  };

  const memoryPct = system.totalRamGB > 0 ? Math.round((memoryGB / system.totalRamGB) * 100) : 0;
  const windowsRemainingGB = system.totalRamGB - memoryGB;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div className="w-full max-w-lg glass-card border border-white/10 rounded-2xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20">
              <HardDrive className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold">WSL Resources</h2>
              <p className="text-xs text-white/40 mt-0.5">Configure WSL2 memory, CPU, and features</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-white/40 hover:text-white rounded-lg hover:bg-white/10 transition-colors" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-6 h-6 text-white/40 animate-spin" />
          </div>
        ) : (
          <>
            {/* System Info */}
            <div className="flex items-center gap-2 mb-5 px-3 py-2 bg-white/5 rounded-lg border border-white/5">
              <Info className="w-4 h-4 text-white/30 flex-shrink-0" />
              <span className="text-xs text-white/50">
                System: {system.totalRamGB}GB RAM, {system.totalProcessors} logical processors
              </span>
            </div>

            {/* Memory Slider */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <MemoryStick className="w-4 h-4 text-cyan-400" />
                  Memory
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-cyan-400">{memoryGB}GB</span>
                  <span className="text-xs text-white/40">/ {system.totalRamGB}GB</span>
                </div>
              </div>

              <input
                type="range"
                min={4}
                max={system.totalRamGB - 4}
                step={1}
                value={memoryGB}
                onChange={(e) => setMemoryGB(parseInt(e.target.value, 10))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer accent-cyan-500 bg-white/10"
                style={{
                  background: `linear-gradient(to right, rgb(6 182 212 / 0.6) 0%, rgb(6 182 212 / 0.6) ${memoryPct}%, rgb(255 255 255 / 0.1) ${memoryPct}%, rgb(255 255 255 / 0.1) 100%)`,
                }}
              />

              <div className="flex justify-between mt-2 text-xs text-white/30">
                <span>4GB</span>
                <span className={`${windowsRemainingGB < 8 ? 'text-amber-400' : 'text-white/40'}`}>
                  Windows keeps {windowsRemainingGB}GB ({memoryPct}% to WSL)
                </span>
                <span>{system.totalRamGB - 4}GB</span>
              </div>
            </div>

            {/* Processors Slider */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Cpu className="w-4 h-4 text-blue-400" />
                  Processors
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-blue-400">{processors}</span>
                  <span className="text-xs text-white/40">/ {system.totalProcessors}</span>
                </div>
              </div>

              <input
                type="range"
                min={1}
                max={system.totalProcessors}
                step={1}
                value={processors}
                onChange={(e) => setProcessors(parseInt(e.target.value, 10))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer accent-blue-500 bg-white/10"
                style={{
                  background: `linear-gradient(to right, rgb(59 130 246 / 0.6) 0%, rgb(59 130 246 / 0.6) ${Math.round((processors / system.totalProcessors) * 100)}%, rgb(255 255 255 / 0.1) ${Math.round((processors / system.totalProcessors) * 100)}%, rgb(255 255 255 / 0.1) 100%)`,
                }}
              />

              <div className="flex justify-between mt-2 text-xs text-white/30">
                <span>1</span>
                <span>{system.totalProcessors}</span>
              </div>
            </div>

            {/* Swap Slider */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="w-4 h-4 text-purple-400" />
                  Swap
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-purple-400">{swapGB}GB</span>
                </div>
              </div>

              <input
                type="range"
                min={0}
                max={Math.min(64, memoryGB * 2)}
                step={1}
                value={swapGB}
                onChange={(e) => setSwapGB(parseInt(e.target.value, 10))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer accent-purple-500 bg-white/10"
                style={{
                  background: `linear-gradient(to right, rgb(168 85 247 / 0.6) 0%, rgb(168 85 247 / 0.6) ${Math.min(memoryGB * 2, 64) > 0 ? Math.round((swapGB / Math.min(64, memoryGB * 2)) * 100) : 0}%, rgb(255 255 255 / 0.1) ${Math.min(memoryGB * 2, 64) > 0 ? Math.round((swapGB / Math.min(64, memoryGB * 2)) * 100) : 0}%, rgb(255 255 255 / 0.1) 100%)`,
                }}
              />

              <div className="flex justify-between mt-2 text-xs text-white/30">
                <span>0GB</span>
                <span>{Math.min(64, memoryGB * 2)}GB</span>
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-3 mb-6">
              <div className="flex items-center justify-between px-3 py-2.5 bg-white/5 rounded-lg border border-white/5">
                <span className="text-sm text-white/80">GPU Support</span>
                <button
                  onClick={() => setGpuSupport(!gpuSupport)}
                  className={`relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none ${
                    gpuSupport ? 'bg-green-500' : 'bg-white/20'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
                    gpuSupport ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>

              <div className="flex items-center justify-between px-3 py-2.5 bg-white/5 rounded-lg border border-white/5">
                <span className="text-sm text-white/80">Nested Virtualization</span>
                <button
                  onClick={() => setNestedVirt(!nestedVirt)}
                  className={`relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none ${
                    nestedVirt ? 'bg-green-500' : 'bg-white/20'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
                    nestedVirt ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
            </div>

            {/* Config file path */}
            {configPath && (
              <div className="text-xs text-white/25 mb-4 truncate">
                Config: {configPath}
              </div>
            )}

            {/* Messages */}
            {error && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-200">{error}</p>
              </div>
            )}

            {success && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
                <p className="text-sm text-green-200">{success}</p>
              </div>
            )}

            {/* Save Button */}
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium text-sm transition-all ${
                hasChanges
                  ? 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/30 hover:border-cyan-500/50'
                  : 'bg-white/5 border border-white/10 text-white/30 cursor-not-allowed'
              } disabled:opacity-60`}
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : hasChanges ? 'Save & Apply' : 'No Changes'}
            </button>

            {hasChanges && (
              <p className="text-xs text-amber-400/60 text-center mt-2">
                Changes require a WSL restart to take effect
              </p>
            )}

            {/* Restart WSL */}
            <div className="border-t border-white/5 mt-5 pt-5">
              {!confirmRestart ? (
                <button
                  onClick={() => setConfirmRestart(true)}
                  disabled={restarting}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium text-sm transition-all bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 hover:border-red-500/30"
                >
                  <Power className="w-4 h-4" />
                  Restart WSL
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-red-200/80">
                      This will shut down WSL and terminate all running processes including {PRODUCT_NAME}. The page will disconnect briefly.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmRestart(false)}
                      disabled={restarting}
                      className="flex-1 py-2 rounded-xl text-sm text-white/50 hover:text-white/80 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleRestartWSL}
                      disabled={restarting}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-medium bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-60"
                    >
                      {restarting ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Restarting…
                        </>
                      ) : (
                        <>
                          <Power className="w-3.5 h-3.5" />
                          Confirm Restart
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
