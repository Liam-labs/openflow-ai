'use client';

import { useState, useEffect } from 'react';
import {
  Image,
  X,
  Search,
  Loader2,
  AlertCircle,
  Check,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Crosshair,
  Zap,
  FolderOpen,
} from 'lucide-react';
import { Project, ImageInfo, OptimizeSettings, OptimizeResult } from '@/lib/types';

interface ImageOptimizerModalProps {
  project: Project;
  onClose: () => void;
}

type CropDirection = 'left' | 'right' | 'top' | 'bottom' | 'center' | null;

interface ScanResult {
  images: ImageInfo[];
  totalCount: number;
  totalSize: number;
  totalSizeFormatted: string;
}

interface OptimizeResponse {
  success: boolean;
  results: OptimizeResult[];
  summary: {
    processed: number;
    succeeded: number;
    failed: number;
    totalOriginalSize: number;
    totalNewSize: number;
    totalSavings: number;
    totalSavingsPercent: number;
    totalOriginalSizeFormatted: string;
    totalNewSizeFormatted: string;
    totalSavingsFormatted: string;
  };
}

export function ImageOptimizerModal({ project, onClose }: ImageOptimizerModalProps) {
  // Scan state
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [subPath, setSubPath] = useState('');

  // Settings state
  const [quality, setQuality] = useState(80);
  const [resizeWidth, setResizeWidth] = useState('');
  const [resizeHeight, setResizeHeight] = useState('');
  const [maintainAspect, setMaintainAspect] = useState(true);
  const [cropDirection, setCropDirection] = useState<CropDirection>(null);
  const [cropAmount, setCropAmount] = useState('');
  const [cropUnit, setCropUnit] = useState<'px' | '%'>('px');
  const [outputFormat, setOutputFormat] = useState<'original' | 'webp' | 'jpeg' | 'png'>('original');
  const [overwrite, setOverwrite] = useState(false);

  // Processing state
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setIsScanning(true);
    setError(null);
    setScanResult(null);
    setSelectedImages(new Set());

    try {
      const response = await fetch('/api/images/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, subPath: subPath.trim() || undefined }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to scan');
      }

      setScanResult(data);
      // Select all images by default
      setSelectedImages(new Set(data.images.map((img: ImageInfo) => img.path)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan for images');
    } finally {
      setIsScanning(false);
    }
  };

  const handleOptimize = async () => {
    if (selectedImages.size === 0) {
      setError('No images selected');
      return;
    }

    setIsOptimizing(true);
    setError(null);
    setOptimizeResult(null);

    const settings: OptimizeSettings = {
      quality,
      format: outputFormat,
      overwrite,
    };

    if (resizeWidth || resizeHeight) {
      settings.resize = {
        width: resizeWidth ? parseInt(resizeWidth, 10) : undefined,
        height: resizeHeight ? parseInt(resizeHeight, 10) : undefined,
        maintainAspect,
      };
    }

    if (cropDirection && cropAmount) {
      settings.crop = {
        direction: cropDirection,
        amount: parseInt(cropAmount, 10),
        unit: cropUnit,
      };
    }

    try {
      const response = await fetch('/api/images/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: Array.from(selectedImages),
          settings,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to optimize');
      }

      setOptimizeResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to optimize images');
    } finally {
      setIsOptimizing(false);
    }
  };

  const toggleImage = (path: string) => {
    const newSelected = new Set(selectedImages);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    setSelectedImages(newSelected);
  };

  const toggleAll = () => {
    if (!scanResult) return;
    if (selectedImages.size === scanResult.images.length) {
      setSelectedImages(new Set());
    } else {
      setSelectedImages(new Set(scanResult.images.map(img => img.path)));
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Auto-scan on mount
  useEffect(() => {
    handleScan();
  }, []);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-card p-6 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Image className="w-6 h-6 text-accent" />
            <div>
              <h2 className="text-xl font-bold">Image Optimizer</h2>
              <p className="text-sm text-muted">{project.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-lg hover:bg-card-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Results View */}
        {optimizeResult && (
          <div className="flex-1 overflow-y-auto">
            <div className="glass-card p-4 mb-4 bg-success/10 border-success/30">
              <h3 className="text-lg font-semibold text-success mb-2 flex items-center gap-2">
                <Check className="w-5 h-5" />
                Optimization Complete
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-muted">Processed</p>
                  <p className="text-lg font-bold">{optimizeResult.summary.succeeded}/{optimizeResult.summary.processed}</p>
                </div>
                <div>
                  <p className="text-muted">Original Size</p>
                  <p className="text-lg font-bold">{optimizeResult.summary.totalOriginalSizeFormatted}</p>
                </div>
                <div>
                  <p className="text-muted">New Size</p>
                  <p className="text-lg font-bold">{optimizeResult.summary.totalNewSizeFormatted}</p>
                </div>
                <div>
                  <p className="text-muted">Saved</p>
                  <p className="text-lg font-bold text-success">
                    {optimizeResult.summary.totalSavingsFormatted} ({optimizeResult.summary.totalSavingsPercent}%)
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {optimizeResult.results.map((result, idx) => (
                <div
                  key={idx}
                  className={`flex items-center justify-between p-2 rounded-lg text-sm ${
                    result.success ? 'bg-success/10' : 'bg-error/10'
                  }`}
                >
                  <span className="truncate flex-1">{result.path.split('/').pop()}</span>
                  {result.success ? (
                    <span className="text-success ml-2">
                      -{result.savingsPercent}% ({formatBytes(result.savings)})
                    </span>
                  ) : (
                    <span className="text-error ml-2">{result.error}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setOptimizeResult(null)}
                className="glass-button secondary flex-1"
              >
                Optimize More
              </button>
              <button onClick={onClose} className="glass-button primary flex-1">
                Done
              </button>
            </div>
          </div>
        )}

        {/* Main Content */}
        {!optimizeResult && (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-4">
            {/* Left Panel - Images */}
            <div className="md:w-1/2 flex flex-col min-h-0">
              <div className="flex items-center gap-2 mb-2">
                <div className="relative flex-1">
                  <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    value={subPath}
                    onChange={(e) => setSubPath(e.target.value)}
                    placeholder="Subdirectory (optional)"
                    className="glass-input pl-10 text-sm"
                  />
                </div>
                <button
                  onClick={handleScan}
                  disabled={isScanning}
                  className="glass-button primary px-3 py-2 flex items-center gap-2"
                >
                  {isScanning ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  Scan
                </button>
              </div>

              {scanResult && (
                <div className="flex items-center justify-between text-xs text-muted mb-2">
                  <button
                    onClick={toggleAll}
                    className="hover:text-accent transition-colors"
                  >
                    {selectedImages.size === scanResult.images.length ? 'Deselect All' : 'Select All'}
                  </button>
                  <span>
                    {selectedImages.size}/{scanResult.totalCount} selected ({scanResult.totalSizeFormatted})
                  </span>
                </div>
              )}

              <div className="flex-1 overflow-y-auto border border-white/10 rounded-lg">
                {isScanning && (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="w-6 h-6 animate-spin text-accent" />
                  </div>
                )}

                {!isScanning && scanResult?.images.length === 0 && (
                  <div className="flex items-center justify-center h-32 text-muted">
                    No images found
                  </div>
                )}

                {!isScanning && scanResult && scanResult.images.length > 0 && (
                  <div className="divide-y divide-white/5">
                    {scanResult.images.map((img) => (
                      <label
                        key={img.path}
                        className="flex items-center gap-3 p-2 hover:bg-white/5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedImages.has(img.path)}
                          onChange={() => toggleImage(img.path)}
                          className="rounded border-white/20"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{img.filename}</p>
                          <p className="text-xs text-muted">
                            {img.width}x{img.height} • {formatBytes(img.size)} • {img.format}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right Panel - Settings */}
            <div className="md:w-1/2 space-y-4 overflow-y-auto">
              {/* Quality */}
              <div className="glass-card p-3">
                <label className="block text-sm font-medium mb-2">
                  Quality: {quality}%
                </label>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                  className="w-full accent-accent"
                />
                <div className="flex justify-between text-xs text-muted mt-1">
                  <span>Smaller file</span>
                  <span>Higher quality</span>
                </div>
              </div>

              {/* Resize */}
              <div className="glass-card p-3">
                <label className="block text-sm font-medium mb-2">Resize</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <input
                    type="number"
                    value={resizeWidth}
                    onChange={(e) => setResizeWidth(e.target.value)}
                    placeholder="Width"
                    className="glass-input text-sm"
                  />
                  <input
                    type="number"
                    value={resizeHeight}
                    onChange={(e) => setResizeHeight(e.target.value)}
                    placeholder="Height"
                    className="glass-input text-sm"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={maintainAspect}
                    onChange={(e) => setMaintainAspect(e.target.checked)}
                    className="rounded border-white/20"
                  />
                  Maintain aspect ratio
                </label>
              </div>

              {/* Crop Direction */}
              <div className="glass-card p-3">
                <label className="block text-sm font-medium mb-2">Crop Direction</label>
                <div className="flex items-center justify-center gap-1 mb-2">
                  <button
                    onClick={() => setCropDirection(cropDirection === 'left' ? null : 'left')}
                    className={`p-2 rounded-lg transition-colors ${
                      cropDirection === 'left'
                        ? 'bg-accent text-white'
                        : 'bg-white/10 hover:bg-white/20'
                    }`}
                    title="Crop from left"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => setCropDirection(cropDirection === 'top' ? null : 'top')}
                      className={`p-2 rounded-lg transition-colors ${
                        cropDirection === 'top'
                          ? 'bg-accent text-white'
                          : 'bg-white/10 hover:bg-white/20'
                      }`}
                      title="Crop from top"
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCropDirection(cropDirection === 'center' ? null : 'center')}
                      className={`p-2 rounded-lg transition-colors ${
                        cropDirection === 'center'
                          ? 'bg-accent text-white'
                          : 'bg-white/10 hover:bg-white/20'
                      }`}
                      title="Crop from center (all sides)"
                    >
                      <Crosshair className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCropDirection(cropDirection === 'bottom' ? null : 'bottom')}
                      className={`p-2 rounded-lg transition-colors ${
                        cropDirection === 'bottom'
                          ? 'bg-accent text-white'
                          : 'bg-white/10 hover:bg-white/20'
                      }`}
                      title="Crop from bottom"
                    >
                      <ArrowDown className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={() => setCropDirection(cropDirection === 'right' ? null : 'right')}
                    className={`p-2 rounded-lg transition-colors ${
                      cropDirection === 'right'
                        ? 'bg-accent text-white'
                        : 'bg-white/10 hover:bg-white/20'
                    }`}
                    title="Crop from right"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
                {cropDirection && (
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={cropAmount}
                      onChange={(e) => setCropAmount(e.target.value)}
                      placeholder="Amount"
                      className="glass-input text-sm flex-1"
                    />
                    <select
                      value={cropUnit}
                      onChange={(e) => setCropUnit(e.target.value as 'px' | '%')}
                      className="glass-input text-sm w-20"
                    >
                      <option value="px">px</option>
                      <option value="%">%</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Output Format */}
              <div className="glass-card p-3">
                <label className="block text-sm font-medium mb-2">Output Format</label>
                <select
                  value={outputFormat}
                  onChange={(e) => setOutputFormat(e.target.value as typeof outputFormat)}
                  className="glass-input text-sm w-full"
                >
                  <option value="original">Keep Original</option>
                  <option value="webp">WebP (Recommended)</option>
                  <option value="jpeg">JPEG</option>
                  <option value="png">PNG</option>
                </select>
              </div>

              {/* Overwrite */}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  className="rounded border-white/20"
                />
                Overwrite original files
              </label>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg mt-4">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* Footer */}
        {!optimizeResult && (
          <div className="flex gap-3 mt-4 pt-4 border-t border-white/10">
            <button onClick={onClose} className="glass-button secondary flex-1">
              Cancel
            </button>
            <button
              onClick={handleOptimize}
              disabled={isOptimizing || selectedImages.size === 0}
              className="glass-button primary flex-1 flex items-center justify-center gap-2"
            >
              {isOptimizing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {isOptimizing ? 'Optimizing...' : `Optimize ${selectedImages.size} Images`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
