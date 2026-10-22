'use client';

/**
 * Mark up a pending chat image before sending (owner, 29 Sep 2026): freehand
 * brush, drag-out rectangle, arrow (head where the drag ends) and text on a
 * readable background. Colour and width
 * apply to brush and rectangle (width also sizes text). Save returns a PNG data
 * URL that replaces the pending attachment.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, PenLine, RectangleHorizontal, Type, Undo2, X } from 'lucide-react';

type Tool = 'pen' | 'rect' | 'arrow' | 'text';
type Point = { x: number; y: number };
type Mark =
  | { kind: 'pen'; points: Point[]; color: string; width: number }
  | { kind: 'rect'; from: Point; to: Point; color: string; width: number }
  | { kind: 'arrow'; from: Point; to: Point; color: string; width: number }
  | { kind: 'text'; at: Point; text: string; color: string; size: number };

const COLOURS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827'];

/** Dark text colours get a light label so they stay readable, and vice versa. */
function labelBackground(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.45 ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.78)';
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (mark.kind === 'pen') {
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = mark.width;
    ctx.beginPath();
    mark.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + 0.01, mark.points[0].y);
    ctx.stroke();
  } else if (mark.kind === 'rect') {
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = mark.width;
    ctx.strokeRect(
      Math.min(mark.from.x, mark.to.x), Math.min(mark.from.y, mark.to.y),
      Math.abs(mark.to.x - mark.from.x), Math.abs(mark.to.y - mark.from.y),
    );
  } else if (mark.kind === 'arrow') {
    // Head sits at `to` (where the pointer was released); size scales with width.
    const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
    const head = Math.max(12, mark.width * 4);
    const base = { x: mark.to.x - head * 0.8 * Math.cos(angle), y: mark.to.y - head * 0.8 * Math.sin(angle) };
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = mark.width;
    ctx.beginPath();
    ctx.moveTo(mark.from.x, mark.from.y);
    ctx.lineTo(base.x, base.y);
    ctx.stroke();
    ctx.fillStyle = mark.color;
    ctx.beginPath();
    ctx.moveTo(mark.to.x, mark.to.y);
    ctx.lineTo(mark.to.x - head * Math.cos(angle - Math.PI / 7), mark.to.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(mark.to.x - head * Math.cos(angle + Math.PI / 7), mark.to.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.font = `600 ${mark.size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const lines = mark.text.split('\n');
    const pad = mark.size * 0.35;
    const lineH = mark.size * 1.25;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;
    const h = lines.length * lineH + pad * 2 - (lineH - mark.size);
    ctx.fillStyle = labelBackground(mark.color);
    ctx.beginPath();
    ctx.roundRect(mark.at.x, mark.at.y, w, h, pad);
    ctx.fill();
    ctx.fillStyle = mark.color;
    lines.forEach((l, i) => ctx.fillText(l, mark.at.x + pad, mark.at.y + pad + i * lineH));
  }
}

interface ImageMarkupModalProps {
  src: string;
  name: string;
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}

export function ImageMarkupModal({ src, name, onSave, onClose }: ImageMarkupModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const draftRef = useRef<Mark | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [colour, setColour] = useState(COLOURS[0]);
  const [width, setWidth] = useState(6);
  const [textDraft, setTextDraft] = useState<{ at: Point; screen: Point; value: string } | null>(null);
  const [ready, setReady] = useState(false);

  // Widths are chosen in screen pixels; convert so marks look the same size
  // whatever the image resolution.
  const scale = () => {
    const canvas = canvasRef.current;
    return canvas ? canvas.width / canvas.getBoundingClientRect().width : 1;
  };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    marks.forEach(m => drawMark(ctx, m));
    if (draftRef.current) drawMark(ctx, draftRef.current);
  }, [marks]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setReady(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => { if (ready) redraw(); }, [ready, redraw]);

  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  // Latest marks for save(): a blur-commit right before the Save click must not be lost.
  const marksRef = useRef(marks);
  marksRef.current = marks;

  const commitText = useCallback(() => {
    const current = textDraftRef.current;
    textDraftRef.current = null;  // blur + Enter can both fire; commit once
    if (current && current.value.trim()) {
      const size = Math.round((12 + width * 1.5) * scale());
      const mark: Mark = { kind: 'text', at: current.at, text: current.value.trim(), color: colour, size };
      marksRef.current = [...marksRef.current, mark];
      setMarks(m => [...m, mark]);
    }
    setTextDraft(null);
  }, [colour, width]);

  // Capture-phase keys so the chat panel's own Escape/arrow shortcuts never fire underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (textDraft) setTextDraft(null);
        else onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !textDraft) {
        e.stopPropagation();
        e.preventDefault();
        setMarks(m => m.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, textDraft]);

  const toImage = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const s = scale();
    return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    if (textDraft) commitText();
    const p = toImage(e);
    if (tool === 'text') {
      // Keep the canvas click from pulling focus off the text box it opens
      // (the blur would commit it empty before anything is typed).
      e.preventDefault();
      const rect = canvasRef.current!.getBoundingClientRect();
      setTextDraft({ at: p, screen: { x: e.clientX - rect.left, y: e.clientY - rect.top }, value: '' });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const w = width * scale();
    draftRef.current = tool === 'pen'
      ? { kind: 'pen', points: [p], color: colour, width: w }
      : { kind: tool, from: p, to: p, color: colour, width: w };
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    const p = toImage(e);
    if (draft.kind === 'pen') draft.points.push(p);
    else if (draft.kind === 'rect' || draft.kind === 'arrow') draft.to = p;
    redraw();
  };

  const onPointerUp = () => {
    const draft = draftRef.current;
    draftRef.current = null;
    if (!draft) return;
    const empty = (draft.kind === 'rect' || draft.kind === 'arrow') && Math.abs(draft.to.x - draft.from.x) < 2 && Math.abs(draft.to.y - draft.from.y) < 2;
    if (!empty) setMarks(m => [...m, draft]);
    else redraw();
  };

  const save = () => {
    const img = imageRef.current;
    if (!img) return;
    const all = [...marksRef.current];
    const pending = textDraftRef.current;
    if (pending && pending.value.trim()) {
      all.push({ kind: 'text', at: pending.at, text: pending.value.trim(), color: colour, size: Math.round((12 + width * 1.5) * scale()) });
    }
    // Render the export from the mark list, independent of on-screen redraw timing.
    const out = document.createElement('canvas');
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    all.forEach(m => drawMark(ctx, m));
    onSave(out.toDataURL('image/png'));
  };

  const toolButton = (id: Tool, label: string, Icon: typeof PenLine) => (
    <button
      type="button"
      onClick={() => { if (textDraft) commitText(); setTool(id); }}
      aria-pressed={tool === id}
      title={label}
      className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ${tool === id ? 'bg-blue-500 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[130] flex flex-col bg-[#030812]/95" role="dialog" aria-modal="true" aria-label={`Mark up ${name}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#081321] px-3 py-2">
        <div className="flex items-center gap-1">
          {toolButton('pen', 'Brush', PenLine)}
          {toolButton('rect', 'Rectangle', RectangleHorizontal)}
          {toolButton('arrow', 'Arrow', ArrowUpRight)}
          {toolButton('text', 'Text', Type)}
        </div>
        <div className="mx-1 h-6 w-px bg-white/10" />
        <div className="flex items-center gap-1.5" aria-label="Colour">
          {COLOURS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColour(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={colour === c}
              className={`h-6 w-6 rounded-full border ${colour === c ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-[#081321]' : 'border-white/25'}`}
              style={{ background: c }}
            />
          ))}
          <input
            type="color"
            value={colour}
            onChange={e => setColour(e.target.value)}
            aria-label="Custom colour"
            className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <span className="hidden sm:inline">Width</span>
          <input type="range" min={2} max={24} value={width} onChange={e => setWidth(Number(e.target.value))} className="w-24 accent-blue-500" aria-label="Width" />
          <span className="w-5 tabular-nums text-white/80">{width}</span>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setMarks(m => m.slice(0, -1))} disabled={marks.length === 0} title="Undo (Ctrl+Z)"
            className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-35">
            <Undo2 className="h-4 w-4" /><span className="hidden sm:inline">Undo</span>
          </button>
          <button type="button" onClick={onClose} title="Cancel (Esc)"
            className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" /><span className="hidden sm:inline">Cancel</span>
          </button>
          <button type="button" onClick={save} disabled={!ready}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-500 px-3 text-xs font-semibold text-white hover:bg-blue-400 disabled:opacity-50">
            <Check className="h-4 w-4" />Save
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        <div className="relative">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`block max-h-[calc(100vh-88px)] max-w-[calc(100vw-24px)] touch-none rounded shadow-2xl ${tool === 'text' ? 'cursor-text' : 'cursor-crosshair'}`}
          />
          {textDraft && (
            <textarea
              autoFocus
              value={textDraft.value}
              onChange={e => setTextDraft(d => (d ? { ...d, value: e.target.value } : d))}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
              }}
              onBlur={commitText}
              placeholder="Type, Enter to place"
              rows={1}
              className="absolute min-w-[160px] resize rounded px-2 py-1 text-sm font-semibold outline outline-2 outline-blue-400"
              style={{ left: textDraft.screen.x, top: textDraft.screen.y, color: colour, background: labelBackground(colour) }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
