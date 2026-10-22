'use client';

import { isHumanParticipant, mentionsHuman } from '@/lib/human-identity';
import type { LightboxImage } from './modals/ImageLightboxModal';
import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Upload,
  Terminal,
  Bot,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Pin,
  CornerDownRight,
  Reply,
  Copy,
  Smile,
  AtSign,
  Plug,
  Loader2,
  Download,
  Film,
  FileText,
  FileSpreadsheet,
  FileArchive,
  FileCode,
  Music,
  File,
  EyeOff,
  AudioLines,
} from 'lucide-react';
import { filterHiddenMessages, countHiddenMessages, crossChannelReplyTarget, splitCrossChannelHeader } from '@/lib/hidden-messages';
import type { CrossChannelTarget } from '@/lib/types';
import type { CollabChannel, CollabMessage, CollabParticipant, AgentRole } from './colab-types';
import type { TypingState } from './colab-types';
import { renderMessageContent } from '@/lib/message-renderer';
import { getPlatformLogo, getPlatformColor } from '@/lib/platform-logos';
import { withReplyTag } from '@/lib/reply-tag';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { AskOwnerCard } from './AskOwnerCard';
import { DesignReferenceBoardCard } from './DesignReferenceBoardCard';
import {
  isAskOwnerQuestion,
  type StructuredAnswer,
} from '@/lib/ask-owner/types';
import {
  isDesignReferenceBoardEnvelope,
  type DesignReferenceSelection,
} from '@/lib/design-references/types';
import {
  collectDesignReferenceSelections,
  designReferenceSelectionKey,
} from '@/lib/design-references/selections';
import {
  collectAnswers,
  isDismissedAnsweredQuestion,
  selectPendingQuestions,
} from '@/lib/ask-owner/pending';
import {
  addDismissedQuestionId,
  ASK_OWNER_DISMISSED_STORAGE_KEY,
  notifyDismissedQuestionIdsChanged,
  parseDismissedQuestionIds,
  readDismissedQuestionIdsSnapshot,
  serializeDismissedQuestionIds,
  subscribeToDismissedQuestionIds,
} from '@/lib/ask-owner/dismissed';
import { formatAbsoluteTime } from '@/lib/chat-timestamp';
import { MessageContextMenu } from './MessageContextMenu';
import { buildRichClipboardHtml, buildSelectionClipboardPayload } from '@/lib/chat-rich-clipboard';

export interface ColabChatViewProps {
  accountDisplayName?: string;
  // Refs
  setMessagesContainerRef: (el: HTMLDivElement | null) => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLElement | null>;

  // Channel / participant state
  activeChannel: CollabChannel | null;
  participantId: string | null;
  messages: CollabMessage[];
  filteredMessages: CollabMessage[];
  roles: AgentRole[];
  isMobile: boolean;

  // Search state
  searchQuery: string;
  activeSearchMessageId: string | null;

  // Scroll / load
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  showScrollToBottom: boolean;
  loadOlderMessages: () => void;
  scrollToBottom: () => void;

  // Message data
  pinnedMessages: CollabMessage[];
  firstUnreadMessageId: string | null;
  typingParticipants: TypingState[];
  streamingMessageId: string | null;

  // Edit state
  editingMessageId: string | null;
  editContent: string;
  setEditContent: (v: string) => void;
  saveEdit: (messageId: string) => void;
  cancelEditing: () => void;

  // Copied state
  copiedMessageId: string | null;

  // Drag state
  isDragging: boolean;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;

  // Handlers
  toggleReaction: (messageId: string, emoji: string) => void;
  togglePin: (messageId: string) => void;
  copyMessage: (messageId: string, content: string, html?: string) => void;
  setLightboxImage: (img: LightboxImage | null) => void;
  setReplyingTo: (msg: CollabMessage | null) => void;
  setInputValue: (updater: string | ((prev: string) => string)) => void;
  /** Address the agent that sent an incoming cross-channel message (its header was clicked). */
  onCrossChannelReply?: (target: CrossChannelTarget) => void;
  /** Post an Ask-Owner answer (rides on metadata.client; server hides + routes it). */
  postStructuredAnswer: (answer: StructuredAnswer) => void | Promise<void>;
  /** Post a visual-reference decision to the agent that created the board. */
  postDesignReferenceSelection: (selection: DesignReferenceSelection) => void | Promise<void>;

  // Helpers
  getRelativeTime: (timestamp: string) => string;
  getReadBy: (msgTimestamp: string, participants: CollabParticipant[], excludeId?: string, recipients?: string[]) => CollabParticipant[];
  highlightMatch: (text: string, query: string, isActiveResult?: boolean) => React.ReactNode;
  applySearchHighlight: (nodes: React.ReactNode, query: string, isActiveResult?: boolean) => React.ReactNode;
  getFileIcon: (mimeType: string) => React.ComponentType<{ className?: string }>;
  formatFileSize: (bytes: number) => string;
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👀'];

export function ColabChatView({
  accountDisplayName,
  setMessagesContainerRef,
  messagesEndRef,
  inputRef,
  activeChannel,
  participantId,
  messages,
  filteredMessages,
  roles,
  isMobile,
  searchQuery,
  activeSearchMessageId,
  hasMoreMessages,
  loadingOlderMessages,
  showScrollToBottom,
  loadOlderMessages,
  scrollToBottom,
  pinnedMessages,
  firstUnreadMessageId,
  typingParticipants,
  streamingMessageId,
  editingMessageId,
  editContent,
  setEditContent,
  saveEdit,
  cancelEditing,
  copiedMessageId,
  isDragging,
  handleDragEnter,
  handleDragLeave,
  handleDragOver,
  handleDrop,
  toggleReaction,
  togglePin,
  copyMessage,
  setLightboxImage,
  setReplyingTo,
  setInputValue,
  onCrossChannelReply,
  postStructuredAnswer,
  postDesignReferenceSelection,
  getRelativeTime,
  getReadBy,
  highlightMatch,
  applySearchHighlight,
  getFileIcon,
  formatFileSize,
}: ColabChatViewProps) {
  const displayName = (p: CollabParticipant) => isHumanParticipant(p) ? accountDisplayName || p.displayName || p.name : p.displayName || p.name;
  const [showHiddenMessages, setShowHiddenMessages] = useState(false);
  const [msgContextMenu, setMsgContextMenu] = useState<{ x: number; y: number; msg: CollabMessage } | null>(null);
  // Reaction picker state — msgId of the message whose picker is open (null = closed)
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const hiddenCount = countHiddenMessages(filteredMessages);
  const displayMessages = filterHiddenMessages(filteredMessages, showHiddenMessages);

  const reduceMotion = useReducedMotion();

  // Correlate Ask-Owner answers (by questionId) so a re-rendered/known-answered
  // card collapses. The primary collapse is the card's own optimistic state on
  // click; this catches answers visible to this client (e.g. across a refresh).
  const askOwnerAnswers = React.useMemo(() => collectAnswers(messages), [messages]);
  const designReferenceSelections = React.useMemo(
    () => collectDesignReferenceSelections(messages),
    [messages],
  );

  // Pending (unanswered) ask-owner questions float in the bottom-right overlay;
  // answered ones drop from the corner and stay inline as the record (rendered
  // by the isAskOwnerQuestion branch in the message map). pendingQuestionMessageIds
  // suppresses the pending question's inline bubble so it lives ONLY in the corner.
  const pendingQuestions = React.useMemo(
    () => selectPendingQuestions(messages, askOwnerAnswers),
    [messages, askOwnerAnswers],
  );
  const pendingQuestionMessageIds = React.useMemo(
    () => new Set(pendingQuestions.map((p) => p.messageId)),
    [pendingQuestions],
  );

  const dismissedQuestionIdsSnapshot = React.useSyncExternalStore(
    subscribeToDismissedQuestionIds,
    readDismissedQuestionIdsSnapshot,
    () => '[]',
  );
  const dismissedQuestionIds = React.useMemo(
    () => parseDismissedQuestionIds(dismissedQuestionIdsSnapshot),
    [dismissedQuestionIdsSnapshot],
  );

  const dismissAnsweredQuestion = useCallback((questionId: string) => {
    const next = addDismissedQuestionId(
      parseDismissedQuestionIds(readDismissedQuestionIdsSnapshot()),
      questionId,
    );
    try {
      localStorage.setItem(
        ASK_OWNER_DISMISSED_STORAGE_KEY,
        serializeDismissedQuestionIds(next),
      );
      notifyDismissedQuestionIdsChanged();
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  }, []);

  return (
  <>
  {/* Non-scrolling positioned ancestor so the Ask-Owner overlay pins to the
      chat-column gutter (bottom-right) instead of scrolling with messages or
      escaping to the viewport corner (which would land over the roster). */}
  <div className="relative flex-1 flex flex-col min-h-0 min-w-0">
  <div
    ref={setMessagesContainerRef}
    className={`collab-messages-scroll flex-1 overflow-y-auto overflow-x-hidden relative min-h-0 min-w-0 ${isMobile ? 'p-2 space-y-3' : 'p-4 space-y-4'}`}
    style={{ WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'contain' }}
    onDragEnter={handleDragEnter}
    onDragLeave={handleDragLeave}
    onDragOver={handleDragOver}
    onDrop={handleDrop}
  >
  {/* Search lives in the navbar (components/ChatNavbar.tsx) */}
  {/* Hidden messages toggle — only visible when there are hidden messages */}
  {hiddenCount > 0 && (
    <div className="flex justify-center py-1">
      <button
        onClick={() => setShowHiddenMessages(v => !v)}
        className="text-xs text-white/30 hover:text-white/50 transition-colors flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/[0.04]"
        title={showHiddenMessages ? 'Hide system messages' : `Show ${hiddenCount} system message${hiddenCount !== 1 ? 's' : ''}`}
      >
        <EyeOff className="w-3 h-3" />
        {showHiddenMessages ? 'Hide system messages' : `Show system messages (${hiddenCount})`}
      </button>
    </div>
  )}
  {/* Load older messages indicator */}
  {hasMoreMessages && !searchQuery && (
    <div className="flex justify-center py-3">
      {loadingOlderMessages ? (
        <div className="flex items-center gap-2 text-sm text-blue-300/70">
          <div className="w-4 h-4 border-2 border-blue-400/20 border-t-blue-400/60 rounded-full animate-spin" />
          Loading older messages...
        </div>
      ) : (
        <button
          onClick={loadOlderMessages}
          className="flex items-center gap-2 text-sm text-blue-300/60 hover:text-blue-300 transition-colors px-4 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-blue-500/20"
        >
          <ChevronUp className="w-4 h-4" />
          Load older messages
        </button>
      )}
    </div>
  )}
  {/* Drop zone overlay */}
  {isDragging && (
    <div className="collab-drop-overlay">
      <div className="collab-drop-border" />
      <div className="collab-drop-content">
        <div className="collab-drop-icon-ring">
          <div className="collab-drop-icon-ring-pulse" />
          <Upload className="w-8 h-8 text-blue-300" />
        </div>
        <p className="text-lg font-semibold text-blue-200 mt-5 tracking-wide">Drop files here</p>
        <p className="text-sm text-blue-400/80 mt-1">Images, PDFs, documents, and more</p>
      </div>
    </div>
  )}
  {!activeChannel ? (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500/15 to-blue-500/10 flex items-center justify-center mb-5 border border-blue-500/10">
        <Users className="w-10 h-10 text-blue-400/50" />
      </div>
      <h3 className="text-lg font-semibold text-white/80 mb-2">Welcome to Projects</h3>
      <p className="text-sm text-white/40 max-w-sm leading-relaxed">
        Select a channel from the sidebar or create a new one to start
        collaborating with AI agents across terminals and browsers.
      </p>
    </div>
  ) : messages.length === 0 ? (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-4 border border-blue-500/10">
        <MessageSquare className="w-8 h-8 text-blue-400/40" />
      </div>
      <h3 className="text-sm font-medium text-white/70 mb-1">No messages yet</h3>
      <p className="text-xs text-white/35 max-w-xs leading-relaxed">
        Start the conversation or invite agents to join the channel.
      </p>
    </div>
  ) : (
    displayMessages.map((msg) => {
      const question = isAskOwnerQuestion(msg.metadata?.client)
        ? msg.metadata.client.payload
        : null;
      const designReferenceBoard = isDesignReferenceBoardEnvelope(msg.metadata?.client)
        ? msg.metadata.client.payload
        : null;
      if (question && isDismissedAnsweredQuestion(question, askOwnerAnswers, dismissedQuestionIds)) {
        return null;
      }

      // Pending ask-owner questions render ONLY in the floating corner overlay,
      // not inline. Once answered they drop from pendingQuestionMessageIds and
      // fall through to the inline collapsed-card record below.
      if (pendingQuestionMessageIds.has(msg.id)) return null;
      const isOwnMessage = msg.from.id === participantId;
      const isSystem = msg.from.id === 'system';
      const isHiddenMsg = msg.metadata?.isHidden === true;
      const isMentioningOwner = !isOwnMessage && mentionsHuman(msg.content);
      const voiceMetadata = msg.metadata?.voice;
      const showUnreadDivider = msg.id === firstUnreadMessageId && !searchQuery;

      if (isSystem) {
        return (
          <React.Fragment key={msg.id}>
            {showUnreadDivider && (
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-red-500/50" />
                <span className="text-xs font-medium text-red-400 px-2">New messages</span>
                <div className="flex-1 h-px bg-red-500/50" />
              </div>
            )}
            <div className="flex justify-center py-2 w-full min-w-0">
              <span className="collab-system-message">
                {searchQuery ? highlightMatch(msg.content, searchQuery, msg.id === activeSearchMessageId) : msg.content}
              </span>
            </div>
          </React.Fragment>
        );
      }

      // Reply context is now enriched directly in msg.replyTo
      const parentMessage = msg.replyTo;

      const msgRosterAgent = activeChannel?.roster?.agents?.find(a => a.participantId === msg.from.id);
      const msgModelId = msgRosterAgent?.model || msgRosterAgent?.agentType;
      const msgPlatformRing = msgModelId ? `ring-1 ${getPlatformColor(msgModelId)}` : '';

      // Compute read receipts - who has seen this message (for own messages)
      // For targeted messages, only show recipients who have read past this message
      const readBy = isOwnMessage && activeChannel ? activeChannel.participants.filter(p =>
        p.id !== msg.from.id && // Not the sender
        p.lastRead && // Has a lastRead timestamp
        new Date(p.lastRead) >= new Date(msg.timestamp) && // Has read past this message
        (!msg.recipients || msg.recipients.includes(p.id)) // Only actual recipients for targeted messages
      ).slice(0, 5) : []; // Limit to 5 avatars

      return (
        <React.Fragment key={msg.id}>
          {showUnreadDivider && (
            <div className="flex items-center gap-3 my-3">
              <div className="flex-1 h-px bg-red-500/50" />
              <span className="text-xs font-medium text-red-400 px-2">New messages</span>
              <div className="flex-1 h-px bg-red-500/50" />
            </div>
          )}
          <div
            id={`msg-${msg.id}`}
            className={`collab-message group flex gap-3 w-full min-w-0 ${isOwnMessage ? 'flex-row-reverse' : ''} ${msg.id === activeSearchMessageId ? 'ring-1 ring-yellow-400/60 rounded-lg bg-yellow-500/[0.06]' : ''} ${msg.silent ? 'opacity-50' : ''} ${isHiddenMsg ? 'opacity-40 italic' : ''}`}
          >
          <button
            className={`collab-avatar w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer transition-all bg-gradient-to-br from-slate-900/85 to-blue-950/80 backdrop-blur-md border border-blue-400/25 shadow-[inset_0_1px_0_rgba(147,197,253,0.15)] ${msgPlatformRing}`}
            title={`Reply to ${displayName(msg.from)} • right-click for message actions`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMsgContextMenu({ x: e.clientX, y: e.clientY, msg });
            }}
            onClick={() => {
              if (isOwnMessage) return;
              const mention = `@${displayName(msg.from)} `;
              setInputValue(prev => {
                if (prev.startsWith(mention)) return prev;
                return mention + prev;
              });
              setTimeout(() => {
                if (inputRef.current) {
                  inputRef.current.focus();
                }
              }, 0);
            }}
          >
            {msgModelId
              ? getPlatformLogo(msgModelId)
              : msg.from.type === 'claude-terminal'
                ? <Terminal className="w-4 h-4" />
                : msg.from.type === 'claude-browser'
                  ? <Bot className="w-4 h-4" />
                  : displayName(msg.from).charAt(0).toUpperCase()
            }
          </button>
          <div className={`overflow-hidden min-w-0 w-full flex flex-col ${designReferenceBoard ? 'max-w-[calc(100%-44px)]' : isMobile ? 'max-w-[calc(100%-44px)]' : 'max-w-[70%] xl:max-w-[60%]'} ${isOwnMessage ? 'items-end' : 'items-start'}`}>
            {/* Reply indicator */}
            {parentMessage && (
              <div className="flex items-center gap-1.5 mb-1 text-xs text-muted opacity-70">
                <CornerDownRight className="w-3 h-3" />
                <span>Replying to</span>
                <span className="font-medium" style={{ color: parentMessage.from?.color || '#888' }}>
                  {parentMessage.from?.name || 'Unknown'}
                </span>
                <span className="truncate max-w-[150px] opacity-60">
                  {(parentMessage.content || '').substring(0, 50)}{(parentMessage.content || '').length > 50 ? '...' : ''}
                </span>
              </div>
            )}
            {!isOwnMessage && (
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="text-sm font-medium cursor-pointer hover:underline"
                  style={{ color: msg.from.color }}
                  onClick={() => {
                    const mention = `@${displayName(msg.from)} `;
                    setInputValue(prev => {
                      if (prev.startsWith(mention)) return prev;
                      return mention + prev;
                    });
                    setTimeout(() => {
                      if (inputRef.current) {
                        inputRef.current.focus();
                      }
                    }, 0);
                  }}
                  title={`Reply to ${displayName(msg.from)}`}
                >
                  {displayName(msg.from)}
                </span>
                {(() => {
                  const ra = activeChannel?.roster?.agents?.find(a => a.participantId === msg.from.id);
                  const role = ra?.roleId ? roles.find(r => r.id === ra.roleId) : null;
                  return role ? (
                    <span className="px-1.5 py-0 rounded text-[8px] font-medium bg-indigo-500/10 text-indigo-400/70 border border-indigo-500/15">{role.name}</span>
                  ) : null;
                })()}
                {isHiddenMsg && (
                  <span className="px-1.5 py-0 rounded text-[8px] font-medium bg-white/[0.04] text-white/30 border border-white/[0.08] not-italic">system</span>
                )}
                <span
                  className="text-xs text-white/70 cursor-help"
                  title={new Date(msg.timestamp).toLocaleString()}
                >
                  {getRelativeTime(msg.timestamp)} · {formatAbsoluteTime(msg.timestamp)}
                </span>
                {msg.metadata?.deliveryMode === 'targeted' && msg.recipients && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-blue-400/70 cursor-help"
                    title={`Targeted to: ${msg.recipients.map(rid => {
                      const p = activeChannel?.participants?.find(p => p.id === rid);
                      return p?.name || rid.slice(0, 8);
                    }).join(', ')}`}
                  >
                    <AtSign className="w-3 h-3" />
                    <span>{msg.recipients.length}</span>
                  </span>
                )}
                {/* Teams bridge indicator */}
                {msg.metadata?._teamsBridge && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[10px] text-blue-400/70 cursor-help"
                    title={`Bridged from Teams${msg.metadata._teamsBridge.bridgedAt ? ` at ${new Date(msg.metadata._teamsBridge.bridgedAt).toLocaleString()}` : ''}`}
                  >
                    <Plug className="w-3 h-3" />
                    <span>Teams</span>
                  </span>
                )}
              </div>
            )}
            {voiceMetadata && (
              <div
                className={`rvc-message-badge ${
                  voiceMetadata.kind === 'riley.voice.response'
                    ? 'rvc-message-badge--response'
                    : 'rvc-message-badge--turn'
                }`}
                title={`Riley Voice · revision ${voiceMetadata.revision}`}
              >
                <AudioLines aria-hidden="true" className="w-3 h-3" />
                <span>Riley Voice</span>
                {voiceMetadata.kind === 'riley.voice.response' && <span className="rvc-message-badge__detail">reply</span>}
                {voiceMetadata.revision > 0 && (
                  <span className="rvc-message-badge__detail">rev {voiceMetadata.revision}</span>
                )}
              </div>
            )}
            <div
              className={`collab-message-bubble rounded-xl px-4 py-2.5 overflow-hidden max-w-full ${
                isOwnMessage
                  ? 'own rounded-br-sm'
                  : msg.from.type !== 'user'
                  ? 'agent rounded-bl-sm'
                  : 'other rounded-bl-sm'
              } ${msg.id === streamingMessageId ? 'streaming' : ''} ${isMentioningOwner ? 'mention-owner' : ''} ${msg.silent ? 'border-l-2 border-purple-500/30' : ''}`}
            >
              {msg.silent && (
                <span className="inline-flex items-center gap-1 text-[10px] text-purple-400/70 font-medium uppercase tracking-wider mb-1">
                  <EyeOff className="w-3 h-3" /> Silent
                </span>
              )}
              {editingMessageId === msg.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full bg-black/30 border border-white/20 rounded px-2 py-1 text-sm text-white resize-none"
                    rows={2}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        saveEdit(msg.id);
                      }
                      if (e.key === 'Escape') {
                        cancelEditing();
                      }
                    }}
                  />
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => saveEdit(msg.id)}
                      className="px-2 py-1 bg-blue-500/50 hover:bg-blue-500/70 rounded text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={cancelEditing}
                      className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-white/70"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : question ? (
                <AskOwnerCard
                  question={question}
                  currentParticipantId={participantId}
                  resolvedAnswer={askOwnerAnswers.get(question.id) ?? null}
                  onAnswer={postStructuredAnswer}
                  onDismiss={() => dismissAnsweredQuestion(question.id)}
                />
              ) : designReferenceBoard ? (
                <DesignReferenceBoardCard
                  board={designReferenceBoard}
                  currentParticipantId={participantId}
                  resolvedSelection={designReferenceSelections.get(designReferenceSelectionKey({
                    boardId: designReferenceBoard.id,
                    boardRevision: designReferenceBoard.revision,
                    boardFingerprint: designReferenceBoard.fingerprint,
                  })) ?? null}
                  onSelection={postDesignReferenceSelection}
                />
              ) : (
                <>
                  <div
                    id={`collab-message-content-${msg.id}`}
                    className="text-sm whitespace-pre-wrap break-words"
                    style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                    onCopy={(event) => {
                      const selection = window.getSelection();
                      if (!selection || selection.rangeCount === 0) return;
                      const range = selection.getRangeAt(0);
                      if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
                      const payload = buildSelectionClipboardPayload(selection);
                      if (!payload) return;
                      event.preventDefault();
                      event.clipboardData.setData('text/plain', payload.text);
                      event.clipboardData.setData('text/html', payload.html);
                    }}
                  >
                    {(() => {
                      // Incoming cross-channel messages get a clickable "From -> To" header
                      // that addresses the sending agent in its own channel.
                      const split = msg.metadata?.crossChannel ? splitCrossChannelHeader(msg.content) : null;
                      const replyTarget = split ? crossChannelReplyTarget(msg, activeChannel?.id) : null;
                      const body = split ? split.body : msg.content;
                      const rendered = renderMessageContent(body, activeChannel?.participants || [], activeChannel?.projectPath);
                      return (
                        <>
                          {split && (replyTarget && onCrossChannelReply ? (
                            <button
                              type="button"
                              className="collab-xchannel-header collab-xchannel-header--link"
                              onClick={() => onCrossChannelReply(replyTarget)}
                              title={`Also send your next message to ${replyTarget.participantName} in ${replyTarget.channelName}`}
                            >
                              {split.header}
                            </button>
                          ) : (
                            <div className="collab-xchannel-header">{split.header}</div>
                          ))}
                          {searchQuery.trim()
                            ? applySearchHighlight(rendered, searchQuery, msg.id === activeSearchMessageId)
                            : rendered}
                        </>
                      );
                    })()}
                  </div>
                  {msg.metadata?.alsoSentTo && (
                    <div
                      className={`collab-also-sent${msg.metadata.alsoSentTo.ok ? '' : ' collab-also-sent--failed'}`}
                      title={msg.metadata.alsoSentTo.error}
                    >
                      {msg.metadata.alsoSentTo.ok
                        ? `Also sent to ${msg.metadata.alsoSentTo.participantName} · ${msg.metadata.alsoSentTo.channelName}`
                        : `Not sent to ${msg.metadata.alsoSentTo.participantName} · ${msg.metadata.alsoSentTo.channelName}: ${msg.metadata.alsoSentTo.error ?? 'failed'}`}
                    </div>
                  )}
                  {msg.editedAt && !isOwnMessage && (
                    <span className="text-xs text-muted opacity-40">(edited)</span>
                  )}
                </>
              )}
              {/* Single image (backward compatibility) */}
              {msg.image && !msg.images && (
                <img
                  src={msg.image.url || msg.image.data}
                  alt={msg.image.name}
                  className="mt-2 max-w-xs rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => msg.image && setLightboxImage({ data: (msg.image.url || msg.image.data) || '', name: msg.image.name })}
                />
              )}
              {/* Multiple attachments - split into images and files */}
              {msg.images && msg.images.length > 0 && (() => {
                const imageAttachments = msg.images!.filter(img => img.type.startsWith('image/'));
                const fileAttachments = msg.images!.filter(img => !img.type.startsWith('image/'));
                return (
                  <>
                    {/* Image grid */}
                    {imageAttachments.length > 0 && (
                      <div className={`mt-2 grid gap-2 ${imageAttachments.length === 1 ? 'grid-cols-1' : imageAttachments.length === 2 ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3'} max-w-2xl`}>
                        {imageAttachments.map((img, idx) => (
                          <img
                            key={idx}
                            src={img.url || img.data}
                            alt={img.name}
                            className="w-full h-32 object-cover rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => {
                              // Open the whole message's images so the preview can step through them.
                              const gallery = imageAttachments.map(a => ({ data: (a.url || a.data) || '', name: a.name }));
                              setLightboxImage({ ...gallery[idx], gallery, index: idx });
                            }}
                            title={img.name}
                          />
                        ))}
                      </div>
                    )}
                    {/* Audio attachments — inline player */}
                    {fileAttachments.filter(f => f.type.startsWith('audio/')).length > 0 && (
                      <div className="mt-2 flex flex-col gap-2 max-w-sm">
                        {fileAttachments.filter(f => f.type.startsWith('audio/')).map((file, idx) => (
                          <div key={`audio-${idx}`} className="rounded-lg bg-white/[0.06] border border-white/[0.08] px-3 py-2.5">
                            <p className="text-xs text-muted mb-1.5 truncate">{file.name}</p>
                            <audio
                              controls
                              src={file.url || file.data}
                              className="w-full h-8 min-w-0"
                              preload="metadata"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Non-audio file download cards */}
                    {fileAttachments.filter(f => !f.type.startsWith('audio/')).length > 0 && (
                      <div className="mt-2 flex flex-col gap-1.5 max-w-sm">
                        {fileAttachments.filter(f => !f.type.startsWith('audio/')).map((file, idx) => {
                          const FileIcon = getFileIcon(file.type);
                          return (
                            <a
                              key={idx}
                              href={file.url ? `${file.url}?name=${encodeURIComponent(file.name)}` : file.data}
                              download={file.name}
                              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-colors group"
                              title={`Download ${file.name}`}
                            >
                              <div className="w-8 h-8 rounded-md bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                                <FileIcon className="w-4 h-4 text-blue-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-white/90 truncate">{file.name}</p>
                                {file.size && (
                                  <p className="text-xs text-muted">{formatFileSize(file.size)}</p>
                                )}
                              </div>
                              <Download className={`w-4 h-4 text-muted transition-opacity flex-shrink-0 ${isMobile ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'}`} />
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
              {msg.id === streamingMessageId && (
                <div className="flex items-center gap-1 mt-1 text-xs text-blue-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Streaming...</span>
                </div>
              )}
            </div>
            {/* Reactions display */}
            {msg.reactions && Object.keys(msg.reactions).length > 0 && (
              <div className={`flex flex-wrap gap-1 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
                {Object.entries(msg.reactions).map(([emoji, reactorIds]) => (
                  <button
                    key={emoji}
                    onClick={() => toggleReaction(msg.id, emoji)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-all ${
                      reactorIds.includes(participantId || '')
                        ? 'bg-blue-500/30 border border-blue-500/50'
                        : 'bg-white/10 hover:bg-white/20 border border-white/10'
                    }`}
                    title={`${reactorIds.length} reaction${reactorIds.length > 1 ? 's' : ''}`}
                  >
                    <span>{emoji}</span>
                    <span className="text-white/70">{reactorIds.length}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Targeted delivery indicator for own messages */}
            {isOwnMessage && msg.metadata?.deliveryMode === 'targeted' && msg.recipients && (
              <div className="flex items-center gap-1 mt-1 justify-end">
                <AtSign className="w-3 h-3 text-blue-400/60" />
                <span
                  className="text-[10px] text-blue-400/60 cursor-help"
                  title={`Targeted to: ${msg.recipients.map(rid => {
                    const p = activeChannel?.participants?.find(p => p.id === rid);
                    return p?.name || rid.slice(0, 8);
                  }).join(', ')}`}
                >
                  Sent to {msg.recipients.length} recipient{msg.recipients.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            {/* Read receipts - show who has read this message */}
            {isOwnMessage && (() => {
              const readBy = getReadBy(msg.timestamp, activeChannel?.participants || [], msg.from.id, msg.recipients);
              if (readBy.length === 0) return null;
              return (
                <div className="flex items-center gap-1 mt-1 justify-end">
                  <span className="text-[10px] text-muted/60 mr-1">Seen by</span>
                  <div className="flex -space-x-1.5">
                    {readBy.slice(0, 4).map((p) => (
                      <div
                        key={p.id}
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold ring-1 ring-[#0a1428]"
                        style={{ backgroundColor: p.color || '#8B5CF6' }}
                        title={p.name}
                      >
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                    ))}
                  </div>
                  {readBy.length > 4 && (
                    <span className="text-[10px] text-muted/60">+{readBy.length - 4}</span>
                  )}
                </div>
              );
            })()}
            {/* Reply and reaction buttons - appear on hover */}
            <div className={`flex items-center gap-2 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
              <button
                onClick={() => {
                  setReplyingTo(msg);
                  // Put the short reply tag and the sender's @mention at the start of the text
                  setInputValue(prev => withReplyTag(prev, msg.id, msg.from.name));
                  // Focus and move cursor after the mention
                  setTimeout(() => {
                    if (inputRef.current) {
                      inputRef.current.focus();
                    }
                  }, 0);
                }}
                className={`transition-opacity text-xs text-muted hover:text-blue-400 flex items-center gap-1 min-h-[44px] px-1 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                title="Reply to this message"
              >
                <Reply className="w-3 h-3" />
                Reply
              </button>
              {/* Copy button */}
              <button
                onClick={() => {
                  const messageElement = document.getElementById(`collab-message-content-${msg.id}`);
                  copyMessage(
                    msg.id,
                    messageElement?.innerText || msg.content,
                    messageElement ? buildRichClipboardHtml(messageElement) : undefined,
                  );
                }}
                className={`transition-opacity text-xs flex items-center gap-1 min-h-[44px] px-1 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${
                  copiedMessageId === msg.id
                    ? 'text-green-400'
                    : 'text-muted hover:text-blue-400'
                }`}
                title={copiedMessageId === msg.id ? 'Copied!' : 'Copy message'}
              >
                <Copy className="w-3 h-3" />
                {copiedMessageId === msg.id ? 'Copied' : 'Copy'}
              </button>
              {/* Reaction picker — click/tap-toggled (works on touch and desktop) */}
              {!isOwnMessage && <div className={`relative transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                <button
                  onClick={() => setReactionPickerMsgId(prev => prev === msg.id ? null : msg.id)}
                  className={`min-h-[44px] min-w-[44px] flex items-center justify-center text-xs transition-colors ${reactionPickerMsgId === msg.id ? 'text-blue-400' : 'text-muted hover:text-blue-400'}`}
                  title="Add reaction"
                  aria-expanded={reactionPickerMsgId === msg.id}
                  aria-label="Emoji reaction"
                >
                  <Smile className="w-3 h-3" />
                </button>
                {reactionPickerMsgId === msg.id && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setReactionPickerMsgId(null)} />
                    <div className="absolute bottom-full left-0 mb-1 z-20">
                      <div className="bg-[#1a1a2e] border border-white/10 rounded-lg p-1 flex gap-1 shadow-lg">
                        {REACTION_EMOJIS.map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => { toggleReaction(msg.id, emoji); setReactionPickerMsgId(null); }}
                            className="hover:bg-white/10 rounded p-1 text-sm transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>}
              {/* Pin button */}
              <button
                onClick={() => togglePin(msg.id)}
                className={`transition-opacity text-xs flex items-center gap-1 min-h-[44px] px-1 ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${
                  msg.pinnedAt
                    ? 'text-amber-400 hover:text-amber-300'
                    : 'text-muted hover:text-blue-400'
                }`}
                title={msg.pinnedAt ? 'Unpin message' : 'Pin message'}
              >
                <Pin className="w-3 h-3" />
              </button>
              {isOwnMessage && (
                <>
                  <span
                    className="text-xs text-white/70 cursor-help"
                    title={new Date(msg.timestamp).toLocaleString()}
                  >
                    {getRelativeTime(msg.timestamp)} · {formatAbsoluteTime(msg.timestamp)}
                  </span>
                  {/* Edited indicator */}
                  {msg.editedAt && (
                    <span
                      className="text-xs text-muted opacity-40 cursor-help"
                      title={`Edited ${new Date(msg.editedAt).toLocaleString()}`}
                    >
                      (edited)
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        </React.Fragment>
      );
    })
  )}
  {/* Typing Indicator */}
  {typingParticipants.length > 0 && (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      <div className="collab-typing-dots">
        <span className="collab-typing-dot" />
        <span className="collab-typing-dot" />
        <span className="collab-typing-dot" />
      </div>
      <span className="text-blue-300/80">
        {(() => {
          const typing = typingParticipants.filter(t => t.activity === 'typing');
          const working = typingParticipants.filter(t => t.activity !== 'typing');
          const parts: string[] = [];
          if (typing.length > 0) {
            parts.push(`${typing.map(t => t.participantName).join(', ')} ${typing.length === 1 ? 'is typing' : 'are typing'}`);
          }
          if (working.length > 0) {
            parts.push(`${working.map(t => t.participantName).join(', ')} ${working.length === 1 ? 'is working' : 'are working'}`);
          }
          return parts.join(' · ') + '...';
        })()}
      </span>
    </div>
  )}
  <div ref={messagesEndRef} />

  {/* Jump to bottom button */}
  {showScrollToBottom && (
    <button
      onClick={scrollToBottom}
      className="collab-jump-bottom sticky bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-medium"
      style={{ marginLeft: 'calc(50% - 70px)' }}
    >
      <ChevronDown className="w-4 h-4" />
      Jump to bottom
    </button>
  )}
  </div>

  {/* Floating Ask-Owner overlay — pending questions only, pinned bottom-right of
      the chat column. Stacks vertically (newest nearest the corner). Answered
      questions exit (fade) and become the inline collapsed record. */}
  {pendingQuestions.length > 0 && (
    <div className="ask-owner-overlay absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2.5 overflow-y-auto overflow-x-hidden pr-0.5" style={{ maxHeight: 'calc(100% - 2rem)', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
      <AnimatePresence initial={false}>
        {pendingQuestions.map(({ question }) => (
          <motion.div
            key={question.id}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 28, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 20, scale: 0.96 }}
            transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="ask-owner-floating shrink-0 w-[min(22rem,calc(100vw-2rem))] rounded-xl overflow-hidden bg-[#0f1d32] shadow-[0_18px_40px_-10px_rgba(0,0,0,0.7)]"
          >
            <AskOwnerCard
              question={question}
              currentParticipantId={participantId}
              resolvedAnswer={askOwnerAnswers.get(question.id) ?? null}
              onAnswer={postStructuredAnswer}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )}
  </div>

  {msgContextMenu && (
    <MessageContextMenu
      x={msgContextMenu.x}
      y={msgContextMenu.y}
      msg={msgContextMenu.msg}
      channelName={activeChannel?.name ?? ''}
      channelId={activeChannel?.id ?? ''}
      participants={activeChannel?.participants ?? []}
      onClose={() => setMsgContextMenu(null)}
    />
  )}
  </>
  );

}
