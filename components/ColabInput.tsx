'use client';
import React, { useEffect, useState } from 'react';
import { ImageMarkupModal } from '@/components/modals/ImageMarkupModal';
import { ArrowRightLeft, Code, Loader2, Mic, Paperclip, Send, Reply, Sparkles, X } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { CollabChannel, CollabMessage, CollabParticipant, CrossChannelTarget } from '@/lib/types';
import { FormattingToolbar } from './FormattingToolbar';
import { RichComposer } from './RichComposer';
import { shortReplyId, stripReplyTag } from '@/lib/reply-tag';

interface PendingFile {
  data: string;
  name: string;
  type: string;
  size?: number;
  clientId?: string;
}

interface EmojiSuggestion {
  code: string;
  emoji: string;
}

interface SlashSuggestion {
  name: string;
  description: string;
  type: string;
  argumentHint?: string;
}

interface ColabInputProps {
  activeChannel: CollabChannel;
  isMobile: boolean;
  isReconnecting: boolean;

  // Typing indicator
  typingUsers: CollabParticipant[];

  // Reply
  replyingTo: CollabMessage | null;
  setReplyingTo: (msg: CollabMessage | null) => void;
  /** Agent in another channel that the next message is also sent to. */
  crossChannelTarget?: CrossChannelTarget | null;
  setCrossChannelTarget?: (target: CrossChannelTarget | null) => void;

  // Pending files
  pendingImages: PendingFile[];
  removePendingImage: (index: number) => void;
  replacePendingImage?: (index: number, dataUrl: string) => void;
  formatFileSize: (bytes: number) => string;
  getFileIcon: (mimeType: string) => React.ElementType;

  // Autocomplete — @mention
  mentionSuggestions: CollabParticipant[];
  mentionSelectedIndex: number;
  insertMention: (name: string) => void;

  // Autocomplete — emoji
  emojiSuggestions: EmojiSuggestion[];
  emojiSelectedIndex: number;
  insertEmoji: (code: string, emoji: string) => void;

  // Autocomplete — slash commands
  slashSuggestions: SlashSuggestion[];
  slashSelectedIndex: number;
  insertSlashCommand: (name: string) => void;

  // File input
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Validation warnings
  invalidMentions: string[];
  skipMentionValidationRef: React.MutableRefObject<boolean>;
  setInvalidMentions: (v: string[]) => void;
  broadcastConfirmPending: boolean;

  // Composer (WYSIWYG / TipTap)
  inputValue: string;                       // canonical markdown mirror
  onChange: (markdown: string) => void;     // editor -> markdown
  handleKeyDown: (e: KeyboardEvent) => void;
  handlePaste: (e: ClipboardEvent) => void;
  handleSend: () => void;
  editor: Editor | null;                    // for the live-formatting toolbar
  onEditorReady: (editor: Editor) => void;

  // Draft indicator — shown when there is unsent text
  showDraftIndicator?: boolean;

  // Code-snippet suggestion (T2.2) — non-destructive "wrap as code block" offer
  codeSuggestion?: { language: string | null; snippet: string } | null;
  onAcceptCodeSuggestion?: () => void;
  onDismissCodeSuggestion?: () => void;

  // Voice mode — optional; when provided, a mic button appears in the send row
  onVoiceModeOpen?: () => void;

  // Mobile "Paste image": files read from the system clipboard (Edge on Android
  // refuses keyboard image paste, so the page reads the clipboard itself).
  onFilesAdded?: (files: File[]) => void;
}

export function ColabInput({
  activeChannel,
  isMobile,
  isReconnecting,
  typingUsers,
  replyingTo,
  setReplyingTo,
  crossChannelTarget,
  setCrossChannelTarget,
  pendingImages,
  removePendingImage,
  replacePendingImage,
  formatFileSize,
  getFileIcon,
  mentionSuggestions,
  mentionSelectedIndex,
  insertMention,
  emojiSuggestions,
  emojiSelectedIndex,
  insertEmoji,
  slashSuggestions,
  slashSelectedIndex,
  insertSlashCommand,
  fileInputRef,
  handleFileSelect,
  invalidMentions,
  skipMentionValidationRef,
  setInvalidMentions,
  broadcastConfirmPending,
  inputValue,
  onChange,
  handleKeyDown,
  handlePaste,
  handleSend,
  editor,
  onEditorReady,
  showDraftIndicator,
  codeSuggestion,
  onAcceptCodeSuggestion,
  onDismissCodeSuggestion,
  onVoiceModeOpen,
  onFilesAdded,
}: ColabInputProps) {
  // Mobile attach menu: Photos opens Android's photo picker (includes Google
  // Photos), Files the generic chooser, Paste image reads the clipboard.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [markupIndex, setMarkupIndex] = useState<number | null>(null);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const photoInputRef = React.useRef<HTMLInputElement>(null);

  const pasteClipboardImage = async () => {
    setAttachMenuOpen(false);
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `pasted-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }));
      }
      if (files.length === 0) {
        setAttachNotice('No image on the clipboard. Copy an image first, then tap Paste image.');
      } else {
        onFilesAdded?.(files);
        setAttachNotice(null);
      }
    } catch {
      setAttachNotice('This browser blocked clipboard access. Allow it when asked, or use Photos instead.');
    }
  };

  // "Structure" button — DeepSeek-V4-Flash enhancement pass over the pending
  // draft (owner directive, 11 Jun 2026). Replaces the draft in place so the
  // human reviews the enhanced prompt before pressing Send.
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  // Feature switch lives in settings cog → Structure. Refetch when the panel
  // saves (it dispatches 'devflow:enhance-config-changed').
  const [structureEnabled, setStructureEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/collab/enhance-prompt')
        .then(r => r.json())
        .then(d => {
          if (!cancelled && d?.success) setStructureEnabled(d.config?.enabled !== false);
        })
        .catch(() => { /* keep last known state */ });
    };
    load();
    window.addEventListener('devflow:enhance-config-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('devflow:enhance-config-changed', load);
    };
  }, []);

  const handleEnhance = async () => {
    const draft = inputValue.trim();
    if (!draft || isEnhancing) return;
    setIsEnhancing(true);
    setEnhanceError(null);
    try {
      const res = await fetch('/api/collab/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: inputValue,
          channelName: activeChannel.name,
          participants: (activeChannel.participants ?? []).map(p => p.name),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data?.enhanced?.trim()) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      // Push into the editor without emitting (matches RichComposer's
      // controlled pushback), then sync the canonical markdown mirror.
      editor?.commands.setContent(data.enhanced, { emitUpdate: false });
      editor?.commands.focus('end');
      onChange(data.enhanced);
    } catch (e) {
      setEnhanceError(e instanceof Error ? e.message : 'Enhancement failed');
    } finally {
      setIsEnhancing(false);
    }
  };

  // Mobile: hide the channel top bar while composing so more chat stays visible;
  // bring it back on send (editor empties) or when the box loses focus
  // (tapping the chat closes the keyboard). CSS: body.collab-composing.
  useEffect(() => {
    if (!isMobile || !editor) return;
    const on = () => document.body.classList.add('collab-composing');
    const off = () => document.body.classList.remove('collab-composing');
    const onUpdate = () => (editor.isEmpty ? off() : on());
    editor.on('focus', on);
    editor.on('update', onUpdate);
    editor.on('blur', off);
    return () => {
      editor.off('focus', on);
      editor.off('update', onUpdate);
      editor.off('blur', off);
      off();
    };
  }, [isMobile, editor]);

  return (
    <div
      className={`collab-input-container flex-shrink-0 ${isMobile ? 'px-2 pt-2 pb-3' : 'p-4'}`}
    >
      {/* Typing indicator — compact on mobile */}
      {typingUsers.length > 0 && (
        <div className={`flex items-center gap-2 px-3 text-blue-400 ${isMobile ? 'mb-1 py-0.5 text-xs' : 'mb-2 py-1.5 text-sm'}`}>
          <div className="flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="truncate">
            {typingUsers.length === 1
              ? `${typingUsers[0].name} is typing...`
              : typingUsers.length === 2
              ? `${typingUsers[0].name} and ${typingUsers[1].name} are typing...`
              : `${typingUsers[0].name} and ${typingUsers.length - 1} others are typing...`
            }
          </span>
        </div>
      )}

      {/* Reply indicator */}
      {replyingTo && (
        <div className="flex items-center justify-between mb-2 px-3 py-2 bg-blue-500/10 border-l-2 border-blue-500 rounded-r">
          <div className="flex items-center gap-2 text-sm overflow-hidden">
            <Reply className="w-4 h-4 text-blue-400 flex-shrink-0" />
            <span className="text-muted">Replying to</span>
            <span className="font-medium flex-shrink-0" style={{ color: replyingTo.from.color }}>
              {replyingTo.from.name}
            </span>
            <span className="flex-shrink-0 rounded bg-blue-500/15 px-1 font-mono text-[11px] text-blue-300" title={`Message ${replyingTo.id}`}>
              {shortReplyId(replyingTo.id)}
            </span>
            <span className="text-muted opacity-60 truncate">
              {replyingTo.content.substring(0, 60)}{replyingTo.content.length > 60 ? '...' : ''}
            </span>
          </div>
          <button
            onClick={() => { setReplyingTo(null); onChange(stripReplyTag(inputValue)); }}
            className="p-1 rounded hover:bg-white/10 text-muted hover:text-white transition-colors flex-shrink-0"
            title="Cancel reply"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Cross-channel "also send to" indicator */}
      {crossChannelTarget && (
        <div className="flex items-center justify-between mb-2 px-3 py-2 bg-violet-500/10 border-l-2 border-violet-500 rounded-r">
          <div className="flex items-center gap-2 text-sm overflow-hidden">
            <ArrowRightLeft className="w-4 h-4 text-violet-400 flex-shrink-0" />
            <span className="text-muted">Also sending to</span>
            <span className="font-medium flex-shrink-0">{crossChannelTarget.participantName}</span>
            <span className="text-muted opacity-60 truncate">in {crossChannelTarget.channelName}</span>
          </div>
          <button
            onClick={() => setCrossChannelTarget?.(null)}
            className="p-1 rounded hover:bg-white/10 text-muted hover:text-white transition-colors flex-shrink-0"
            title="Don't send to the other channel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {markupIndex !== null && pendingImages[markupIndex] && replacePendingImage && (
        <ImageMarkupModal
          src={pendingImages[markupIndex].data}
          name={pendingImages[markupIndex].name}
          onClose={() => setMarkupIndex(null)}
          onSave={(dataUrl) => { replacePendingImage(markupIndex, dataUrl); setMarkupIndex(null); }}
        />
      )}

            {/* Pending files preview */}
      {pendingImages.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {pendingImages.map((img, index) => (
            <div key={index} className="relative">
              {img.type.startsWith('image/') ? (
                <div className="collab-image-preview relative">
                  <img
                    src={img.data}
                    alt={img.name}
                    className={`max-h-24 rounded ${replacePendingImage ? 'cursor-pointer' : ''}`}
                    title={replacePendingImage ? 'Click to mark up' : undefined}
                    onClick={replacePendingImage ? () => setMarkupIndex(index) : undefined}
                  />
                  <button
                    onClick={() => removePendingImage(index)}
                    className="collab-image-remove"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08]">
                  {(() => { const Icon = getFileIcon(img.type); return <Icon className="w-4 h-4 text-blue-400 flex-shrink-0" />; })()}
                  <div className="min-w-0">
                    <p className="text-xs text-white/90 truncate max-w-[120px]">{img.name}</p>
                    {img.size && <p className="text-[10px] text-muted">{formatFileSize(img.size)}</p>}
                  </div>
                  <button
                    onClick={() => removePendingImage(index)}
                    className="p-0.5 rounded hover:bg-white/10 text-muted hover:text-white transition-colors flex-shrink-0"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* @mention autocomplete dropdown */}
      {mentionSuggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-[#1a1a2e] border border-white/10 rounded-lg shadow-lg overflow-hidden z-20">
          {mentionSuggestions.map((participant, index) => (
            <button
              key={participant.id}
              onClick={() => insertMention(participant.name)}
              className={`w-full px-3 text-left flex items-center gap-3 transition-colors ${
                isMobile ? 'py-3' : 'py-2'
              } ${
                index === mentionSelectedIndex
                  ? 'bg-blue-500/30 text-white'
                  : 'text-white/70 hover:bg-white/10'
              }`}
            >
              <div
                className={`rounded-full flex items-center justify-center text-xs font-bold ${isMobile ? 'w-8 h-8' : 'w-6 h-6'}`}
                style={{ backgroundColor: participant.color }}
              >
                {participant.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">@{participant.name}</div>
                <div className="text-xs text-muted opacity-60">{participant.source}</div>
              </div>
              {!isMobile && <kbd className="text-xs text-muted opacity-40">Tab</kbd>}
            </button>
          ))}
        </div>
      )}

      {/* Emoji autocomplete dropdown */}
      {emojiSuggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-[#1a1a2e] border border-white/10 rounded-lg shadow-lg overflow-hidden z-20">
          {emojiSuggestions.map((item, index) => (
            <button
              key={item.code}
              onClick={() => insertEmoji(item.code, item.emoji)}
              className={`w-full px-3 text-left flex items-center gap-3 transition-colors ${
                isMobile ? 'py-3' : 'py-2'
              } ${
                index === emojiSelectedIndex
                  ? 'bg-blue-500/30 text-white'
                  : 'text-white/70 hover:bg-white/10'
              }`}
            >
              <span className={isMobile ? 'text-2xl' : 'text-xl'}>{item.emoji}</span>
              <span className="text-sm">:{item.code}:</span>
            </button>
          ))}
        </div>
      )}

      {/* Slash command autocomplete dropdown */}
      {slashSuggestions.length > 0 && (
        <div className={`absolute bottom-full left-0 right-0 mb-1 mx-2 bg-[#1a1a2e] border border-white/10 rounded-lg shadow-lg overflow-hidden z-20 overflow-y-auto ${isMobile ? 'max-h-48' : 'max-h-80'}`}>
          <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider border-b border-white/[0.06]">
            Slash Commands
          </div>
          {slashSuggestions.map((item, index) => (
            <button
              key={item.name}
              onClick={() => insertSlashCommand(item.name)}
              className={`w-full px-3 text-left flex items-center gap-3 transition-colors ${
                isMobile ? 'py-3' : 'py-2'
              } ${
                index === slashSelectedIndex
                  ? 'bg-blue-500/30 text-white'
                  : 'text-white/70 hover:bg-white/10'
              }`}
            >
              <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                item.type === 'command' ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-300'
              }`}>
                /{item.name}
              </span>
              <span className="text-xs text-white/50 flex-1 truncate">{item.description}</span>
              {!isMobile && item.argumentHint && (
                <span className="text-[10px] text-white/25 font-mono">{item.argumentHint}</span>
              )}
              {!isMobile && <kbd className="text-xs text-muted opacity-40">Tab</kbd>}
            </button>
          ))}
        </div>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        multiple
        className="hidden"
      />
      {/* Media-only accept makes Android show its photo picker (with Google Photos). */}
      <input
        type="file"
        ref={photoInputRef}
        onChange={handleFileSelect}
        accept="image/*,video/*"
        multiple
        className="hidden"
      />

      {/* Invalid @mention warning — hidden on mobile to preserve input visibility */}
      {!isMobile && invalidMentions.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-xs">
          <span className="font-medium">Unknown mention{invalidMentions.length > 1 ? 's' : ''}:</span>
          <span>{invalidMentions.map(n => `@${n}`).join(', ')}</span>
          <span className="text-red-400/70 ml-1">— not in this channel</span>
          <button
            onClick={() => { skipMentionValidationRef.current = true; setInvalidMentions([]); handleSend(); }}
            className="ml-auto text-red-300/70 hover:text-red-200 underline underline-offset-2 cursor-pointer shrink-0"
          >
            Send anyway
          </button>
        </div>
      )}

      {/* Broadcast confirmation warning — hidden on mobile to preserve input visibility */}
      {!isMobile && broadcastConfirmPending && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">
          <span className="font-medium">Broadcast:</span>
          <span>No @mentions — this will notify all agents. Press Enter or Send again to confirm.</span>
        </div>
      )}

      {/* Code-snippet suggestion — non-destructive, dismissible */}
      {codeSuggestion && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-blue-500/10 border border-blue-500/25 text-blue-200 text-xs">
          <Code className="w-4 h-4 text-blue-400 flex-shrink-0" />
          <span className="min-w-0 truncate">
            Looks like{' '}
            <span className="font-medium text-blue-300">
              {codeSuggestion.language ?? 'code'}
            </span>
            {' '}— wrap it in a code block?
          </span>
          <button
            onClick={onAcceptCodeSuggestion}
            className="ml-auto flex-shrink-0 px-2 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 hover:text-white font-medium transition-colors"
          >
            Wrap
          </button>
          <button
            onClick={onDismissCodeSuggestion}
            className="flex-shrink-0 p-1 rounded hover:bg-white/10 text-blue-300/70 hover:text-white transition-colors"
            title="Dismiss"
            aria-label="Dismiss code suggestion"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Enhancement failure — draft left untouched, dismissible */}
      {enhanceError && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-xs">
          <span className="font-medium">Enhance failed:</span>
          <span className="min-w-0 truncate">{enhanceError}</span>
          <button
            onClick={() => setEnhanceError(null)}
            className="ml-auto flex-shrink-0 p-1 rounded hover:bg-white/10 text-red-300/70 hover:text-white transition-colors"
            title="Dismiss"
            aria-label="Dismiss enhancement error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Mobile: no toolbar row (owner, 25 Sep 2026: only attach + send, so the chat stays visible while typing) */}
      {!isMobile && (
      <div className="flex items-center justify-between mb-1.5">
        <FormattingToolbar
          editor={editor}
          isMobile={isMobile}
          extraChildren={isMobile ? (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md hover:bg-white/10 text-muted hover:text-blue-400 transition-colors w-9 h-9 flex items-center justify-center"
                title="Attach files"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              {onVoiceModeOpen && (
                <button
                  onClick={onVoiceModeOpen}
                  className="rounded-md hover:bg-white/10 text-muted hover:text-emerald-400 transition-colors w-9 h-9 flex items-center justify-center"
                  title="Voice mode"
                  aria-label="Open voice mode"
                >
                  <Mic className="w-4 h-4" />
                </button>
              )}
            </>
          ) : undefined}
        />
        {structureEnabled && (
        <button
          type="button"
          onClick={handleEnhance}
          disabled={!inputValue.trim() || isEnhancing}
          className={`collab-enhance-btn flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs font-medium flex-shrink-0 ${
            isEnhancing ? 'collab-enhance-btn--busy' : ''
          }`}
          title="Enhance prompt — AI enhancement pass: clarifies intent, fixes grammar, removes ambiguity. Updates the draft for your review before sending."
        >
          {isEnhancing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {!isMobile && <span>{isEnhancing ? 'Enhancing…' : 'Enhance'}</span>}
        </button>
        )}
      </div>
      )}

      {isMobile && attachNotice && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 mb-2 rounded-lg bg-white/5 border border-white/10 text-xs text-muted">
          <span>{attachNotice}</span>
          <button type="button" onClick={() => setAttachNotice(null)} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <div className={`relative flex ${isMobile ? 'gap-1 items-end' : 'gap-2'}`}>
        {isMobile && attachMenuOpen && (
          <div className="absolute bottom-full left-0 mb-1 z-20 flex flex-col min-w-[11rem] rounded-lg border border-white/10 bg-[#1a1a2e] shadow-lg overflow-hidden" role="menu">
            <button type="button" role="menuitem" className="px-4 py-3 text-left text-sm hover:bg-white/10"
              onClick={() => { setAttachMenuOpen(false); photoInputRef.current?.click(); }}>Photos</button>
            <button type="button" role="menuitem" className="px-4 py-3 text-left text-sm hover:bg-white/10"
              onClick={() => { setAttachMenuOpen(false); fileInputRef.current?.click(); }}>Files</button>
            {onFilesAdded && (
              <button type="button" role="menuitem" className="px-4 py-3 text-left text-sm hover:bg-white/10"
                onClick={pasteClipboardImage}>Paste image</button>
            )}
          </div>
        )}
        <button
          onClick={() => isMobile ? setAttachMenuOpen(open => !open) : fileInputRef.current?.click()}
          className={`rounded-xl hover:bg-white/10 text-muted hover:text-blue-400 transition-colors flex-shrink-0 self-end ${isMobile ? 'w-10 h-10 flex items-center justify-center' : 'p-3'}`}
          title="Attach files"
          aria-label="Attach files"
        >
          <Paperclip className="w-5 h-5" />
        </button>
        <RichComposer
          value={inputValue}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onEditorReady={onEditorReady}
          isMobile={isMobile}
          placeholder={pendingImages.length > 0 ? `Add a message or press Enter to send ${pendingImages.length} file${pendingImages.length > 1 ? 's' : ''}...` : `Message #${activeChannel.name}...`}
          className={`collab-rich-input flex-1${invalidMentions.length > 0 ? ' collab-rich-input--invalid' : ''}${broadcastConfirmPending ? ' collab-rich-input--broadcast' : ''}`}
        />
        {!isMobile && (
          <div className="flex items-center gap-1 self-end">
            {onVoiceModeOpen && (
              <button
                onClick={onVoiceModeOpen}
                className="rounded-xl text-emerald-500/50 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors p-3"
                title="Voice mode"
                aria-label="Open voice mode"
              >
                <Mic className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={handleSend}
              disabled={(!inputValue.trim() && pendingImages.length === 0) || isReconnecting}
              className={`collab-send-btn rounded-xl px-6 py-3 ${
                isReconnecting ? 'text-amber-400/70' : broadcastConfirmPending ? 'text-amber-400 animate-pulse' : 'text-blue-400'
              }`}
              title={isReconnecting ? 'Reconnecting...' : broadcastConfirmPending ? 'Click again to broadcast to all' : 'Send message'}
            >
              {isReconnecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </button>
          </div>
        )}
        {isMobile && (
          <button
            onClick={handleSend}
            onMouseDown={(e) => e.preventDefault() /* keep the keyboard open while sending */}
            disabled={(!inputValue.trim() && pendingImages.length === 0) || isReconnecting}
            className={`collab-send-btn rounded-xl w-10 h-10 flex-shrink-0 self-end flex items-center justify-center ${
              isReconnecting ? 'text-amber-400/70' : broadcastConfirmPending ? 'text-amber-400 animate-pulse' : 'text-blue-400'
            }`}
            title={isReconnecting ? 'Reconnecting...' : broadcastConfirmPending ? 'Tap again to broadcast to all' : 'Send message'}
            aria-label={broadcastConfirmPending ? 'Tap again to broadcast to all' : 'Send message'}
          >
            {isReconnecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        )}
      </div>


      {!isMobile && (
        <p className="text-xs text-muted mt-2 text-center opacity-60 flex items-center justify-center gap-2">
          Enter to send • Shift+Enter for new line • Enter in a list adds an item • Paste images or drag files
          {/* Draft indicator pill — subtle, only visible when there is unsent text */}
          {showDraftIndicator && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-400/10 text-amber-400/70 border border-amber-400/20 select-none">
              Draft
            </span>
          )}
        </p>
      )}
    </div>
  );
}
