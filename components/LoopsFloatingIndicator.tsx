'use client';

import { useEffect, useState, useCallback } from 'react';
import { RalphLoop, LoopsResponse } from '@/lib/types';
import { LoopsPanel } from './LoopsPanel';
import { useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import { Repeat, X, Minimize2, AlertTriangle, ChevronRight } from 'lucide-react';

interface LoopsFloatingIndicatorProps {
  refreshInterval?: number;
}

export function LoopsFloatingIndicator({ refreshInterval = 2000 }: LoopsFloatingIndicatorProps) {
  const [activeLoops, setActiveLoops] = useState<RalphLoop[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const eventStream = useEventStreamContext();

  const fetchLoopsData = useCallback(async () => {
    try {
      const response = await fetch('/api/claude/loops');
      const data: LoopsResponse = await response.json();

      if (!data.error) {
        setActiveLoops(data.active);
      }
    } catch (err) {
      console.error('Loops fetch error:', err);
    }
  }, []);

  // SSE subscription for loops status updates
  useEffect(() => {
    return eventStream.subscribe<{ active: RalphLoop[] }>('loops:status', (data) => {
      if (data?.active) {
        setActiveLoops(data.active);
      }
    });
  }, [eventStream]);

  // Initial fetch (always need data on mount)
  useEffect(() => {
    fetchLoopsData();
  }, [fetchLoopsData]);

  // Fallback polling: 30s when SSE disconnected (was 2s)
  useEffect(() => {
    if (eventStream.isSSE) return; // SSE active, no need to poll

    const interval = setInterval(fetchLoopsData, 30000);
    return () => clearInterval(interval);
  }, [eventStream.isSSE, fetchLoopsData]);

  // Don't render anything if no active loops
  if (activeLoops.length === 0) {
    return null;
  }

  const awaitingInputCount = activeLoops.filter(
    (loop) => loop.final_status === 'awaiting_input'
  ).length;

  const handleCardClick = () => {
    setIsModalOpen(true);
    setIsMinimized(false);
  };

  const handleMinimize = () => {
    setIsMinimized(true);
    setIsModalOpen(false);
  };

  const handleClose = () => {
    setIsModalOpen(false);
    setIsMinimized(false);
  };

  // Get the primary loop info (first active loop)
  const primaryLoop = activeLoops[0];
  const isRunning = primaryLoop.final_status === 'running';
  const needsInput = primaryLoop.final_status === 'awaiting_input';

  return (
    <>
      {/* Floating Card on Left Side */}
      {!isModalOpen && (
        <div
          className={`
            fixed left-4 top-1/2 -translate-y-1/2 z-40
            cursor-pointer transition-all duration-300
            ${needsInput ? 'animate-pulse-slow' : ''}
          `}
          onClick={handleCardClick}
        >
          <div
            className={`
              glass-card p-4 rounded-xl border-2 shadow-lg
              hover:scale-105 transition-transform
              ${needsInput
                ? 'border-amber-500/60 bg-amber-500/10'
                : 'border-accent/40 bg-accent/5'
              }
            `}
            style={{ minWidth: '200px' }}
          >
            {/* Header */}
            <div className="flex items-center gap-2 mb-2">
              <div className={`
                p-1.5 rounded-lg
                ${needsInput ? 'bg-amber-500/20' : 'bg-accent/20'}
              `}>
                <Repeat className={`w-4 h-4 ${needsInput ? 'text-amber-400' : 'text-accent'}`} />
              </div>
              <span className="font-semibold text-sm">
                {activeLoops.length === 1 ? 'Loop Active' : `${activeLoops.length} Loops Active`}
              </span>
              <ChevronRight className="w-4 h-4 text-muted ml-auto" />
            </div>

            {/* Status Badge */}
            {needsInput ? (
              <div className="flex items-center gap-2 text-amber-400 text-sm">
                <AlertTriangle className="w-4 h-4" />
                <span>Needs Input</span>
              </div>
            ) : isRunning ? (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <span className="status-dot online" style={{ width: 8, height: 8 }} />
                <span>Running</span>
              </div>
            ) : null}

            {/* Project Name */}
            <div className="mt-2 text-xs text-muted truncate">
              {primaryLoop.project_name}
            </div>

            {/* Iteration Count */}
            <div className="mt-1 text-xs text-muted">
              Iteration {primaryLoop.iterations.length} / {primaryLoop.max_iterations}
            </div>

            {/* Multiple loops indicator */}
            {activeLoops.length > 1 && (
              <div className="mt-2 pt-2 border-t border-white/10 text-xs text-muted">
                +{activeLoops.length - 1} more loop{activeLoops.length > 2 ? 's' : ''}
              </div>
            )}

            {/* Awaiting input count badge */}
            {awaitingInputCount > 0 && awaitingInputCount !== activeLoops.length && (
              <div className="mt-2 flex items-center gap-1 text-xs text-amber-400">
                <AlertTriangle className="w-3 h-3" />
                {awaitingInputCount} awaiting input
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Overlay */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={handleMinimize}
          />

          {/* Modal Content */}
          <div className="relative w-full max-w-4xl max-h-[85vh] mx-4 overflow-hidden rounded-2xl glass-card border border-white/10 shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/20">
                  <Repeat className="w-5 h-5 text-accent" />
                </div>
                <h2 className="text-lg font-semibold">Ralph Loops</h2>
                {awaitingInputCount > 0 && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/20 border border-amber-500/40 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <span className="text-sm font-medium text-amber-400">
                      {awaitingInputCount} needs input
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleMinimize}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                  title="Minimize to card"
                >
                  <Minimize2 className="w-5 h-5 text-muted" />
                </button>
                <button
                  onClick={handleClose}
                  className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                  title="Close"
                >
                  <X className="w-5 h-5 text-muted" />
                </button>
              </div>
            </div>

            {/* Modal Body - LoopsPanel */}
            <div className="overflow-y-auto max-h-[calc(85vh-80px)] p-4">
              <LoopsPanel refreshInterval={refreshInterval} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
