'use client';

import { useState } from 'react';
import { RalphLoop } from '@/lib/types';
import { StopCircle, Clock, Cpu, Image, ChevronDown, ChevronUp, ExternalLink, AlertTriangle, Send, CheckCircle2, Circle } from 'lucide-react';

interface LoopCardProps {
  loop: RalphLoop;
  onCancel: () => void;
  onSubmitInput?: (projectPath: string, response: string, selectedOption?: number) => Promise<void>;
}

export function LoopCard({ loop, onCancel, onSubmitInput }: LoopCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [screenshotError, setScreenshotError] = useState(false);
  const [inputText, setInputText] = useState('');
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isAwaitingInput = loop.final_status === 'awaiting_input';
  const latestIteration = loop.iterations[loop.iterations.length - 1];

  // Calculate elapsed time
  const startTime = new Date(loop.started_at);
  const now = new Date();
  const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);

  const formatElapsed = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  const getProgressColor = (progress: string) => {
    switch (progress) {
      case 'good': return 'text-green-400';
      case 'slow': return 'text-yellow-400';
      case 'none': return 'text-orange-400';
      case 'regressing': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  // Get consolidated status (check both field names for compatibility)
  const status = loop.current_status || loop.consolidated;

  // Only show progress if consolidator provides it
  const progressPercent = status?.progress_percent ?? null;

  const handleSubmitInput = async () => {
    if (!onSubmitInput || (!inputText.trim() && selectedOption === null)) return;

    setIsSubmitting(true);
    try {
      await onSubmitInput(
        loop.project_path,
        inputText.trim(),
        selectedOption !== null ? selectedOption : undefined
      );
      setInputText('');
      setSelectedOption(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Get latest screenshot URL
  const latestScreenshot = latestIteration?.screenshot_path
    ? `/api/claude/loops/screenshot?project=${encodeURIComponent(loop.project_path)}&path=${encodeURIComponent(latestIteration.screenshot_path)}`
    : null;

  return (
    <div className={`loop-card rounded-lg overflow-hidden ${
      isAwaitingInput
        ? 'bg-gradient-to-r from-amber-500/20 to-transparent border-2 border-amber-500/50 animate-pulse-subtle'
        : 'bg-gradient-to-r from-green-500/10 to-transparent border border-green-500/30'
    }`}>
      {/* Main Content */}
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {isAwaitingInput ? (
              <AlertTriangle className="w-5 h-5 text-amber-400 animate-bounce" />
            ) : (
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            )}
            <h4 className="font-semibold text-lg">{loop.project_name}</h4>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
              isAwaitingInput
                ? 'bg-amber-500/20 text-amber-400'
                : 'bg-green-500/20 text-green-400'
            }`}>
              {isAwaitingInput ? 'Needs Input' : 'Running'}
            </span>
          </div>
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition-colors"
          >
            <StopCircle className="w-4 h-4" />
            Cancel
          </button>
        </div>

        {/* Stats Row */}
        <div className="flex items-center gap-6 text-sm mb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted" />
            <span className="font-mono">{formatElapsed(elapsedSeconds)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-muted" />
            <span>{loop.evaluator_model}</span>
          </div>
        </div>

        {/* Progress Bar with Consolidated Status */}
        {(progressPercent !== null || status) && (
          <div className="mb-3">
            {status?.status_line && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-white/80">{status.status_line}</span>
                {progressPercent !== null && (
                  <span className="text-xs text-muted">{Math.round(progressPercent)}%</span>
                )}
              </div>
            )}
            {progressPercent !== null && (
              <div className="h-2 bg-black/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Consolidated Summary */}
        {status?.iteration_summary && (
          <div className="text-sm p-3 bg-black/20 rounded-lg mb-3 border border-white/5">
            <p className="text-white/80">{status.iteration_summary}</p>

            {/* Completed & Remaining Items */}
            {((status.completed_items?.length ?? 0) > 0 || (status.remaining_items?.length ?? 0) > 0) && (
              <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
                {(status.completed_items?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-green-400 font-medium mb-1">Completed:</p>
                    <ul className="space-y-0.5">
                      {status.completed_items!.slice(0, 4).map((item, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-muted">
                          <CheckCircle2 className="w-3 h-3 text-green-400 flex-shrink-0" />
                          <span className="truncate">{item}</span>
                        </li>
                      ))}
                      {status.completed_items!.length > 4 && (
                        <li className="text-muted">+{status.completed_items!.length - 4} more</li>
                      )}
                    </ul>
                  </div>
                )}
                {(status.remaining_items?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-blue-400 font-medium mb-1">Remaining:</p>
                    <ul className="space-y-0.5">
                      {status.remaining_items!.slice(0, 4).map((item, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-muted">
                          <Circle className="w-3 h-3 text-blue-400 flex-shrink-0" />
                          <span className="truncate">{item}</span>
                        </li>
                      ))}
                      {status.remaining_items!.length > 4 && (
                        <li className="text-muted">+{status.remaining_items!.length - 4} more</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Prompt Preview */}
        <div className="text-sm text-muted mb-2">
          <span className="font-medium text-white/70">Task: </span>
          {loop.original_prompt.slice(0, 100)}
          {loop.original_prompt.length > 100 && '...'}
        </div>

        {/* Latest Summary */}
        {latestIteration?.summary && !isAwaitingInput && (
          <div className="text-sm p-2 bg-black/20 rounded">
            <span className="text-muted">Latest: </span>
            {latestIteration.summary}
          </div>
        )}

        {/* Human Input Required Section */}
        {isAwaitingInput && loop.awaiting_input && (
          <div className="mt-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-200 mb-1">Human Input Required</p>
                <p className="text-sm text-white/80">{loop.awaiting_input.reason}</p>
                {loop.awaiting_input.context && (
                  <p className="text-xs text-muted mt-1">
                    Context: {loop.awaiting_input.context}
                  </p>
                )}
              </div>
            </div>

            {/* Option buttons if provided */}
            {loop.awaiting_input.options && loop.awaiting_input.options.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-muted mb-2">Select an option:</p>
                <div className="flex flex-wrap gap-2">
                  {loop.awaiting_input.options.map((option, index) => (
                    <button
                      key={index}
                      onClick={() => setSelectedOption(selectedOption === index ? null : index)}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                        selectedOption === index
                          ? 'bg-amber-500 text-black font-medium'
                          : 'bg-white/10 hover:bg-white/20 text-white'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Free text input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={loop.awaiting_input.options?.length ? "Or type a custom response..." : "Type your response..."}
                className="flex-1 px-3 py-2 bg-black/30 border border-white/20 rounded-lg text-sm placeholder:text-muted focus:outline-none focus:border-amber-500/50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitInput();
                  }
                }}
                disabled={isSubmitting}
              />
              <button
                onClick={handleSubmitInput}
                disabled={isSubmitting || (!inputText.trim() && selectedOption === null)}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 disabled:cursor-not-allowed text-black font-medium rounded-lg text-sm transition-colors"
              >
                <Send className="w-4 h-4" />
                {isSubmitting ? 'Sending...' : 'Submit'}
              </button>
            </div>

            <p className="text-xs text-muted mt-2">
              Waiting since {new Date(loop.awaiting_input.requested_at).toLocaleTimeString()}
            </p>
          </div>
        )}

        {/* Toggle Details Button */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-1 mt-3 text-sm text-muted hover:text-white transition-colors"
        >
          {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          {showDetails ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {/* Expanded Details */}
      {showDetails && (
        <div className="border-t border-white/10 p-4 bg-black/20">
          <div className="grid grid-cols-2 gap-4">
            {/* Screenshot */}
            {latestScreenshot && !screenshotError && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Image className="w-4 h-4" />
                  Latest Screenshot
                </p>
                <a
                  href={latestScreenshot}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block relative group"
                >
                  <img
                    src={latestScreenshot}
                    alt="Latest screenshot"
                    className="w-full rounded border border-white/10 hover:border-accent/50 transition-colors"
                    onError={() => setScreenshotError(true)}
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                    <ExternalLink className="w-6 h-6" />
                  </div>
                </a>
              </div>
            )}

          </div>

          {/* Additional Info */}
          <div className="mt-4 pt-3 border-t border-white/5 text-xs text-muted">
            <p><strong>Path:</strong> {loop.project_path}</p>
            <p><strong>Screenshot URL:</strong> {loop.screenshot_url}</p>
            <p><strong>Session ID:</strong> {loop.session_id}</p>
          </div>
        </div>
      )}
    </div>
  );
}
