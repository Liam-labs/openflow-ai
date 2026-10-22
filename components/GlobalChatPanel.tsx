'use client';

/**
 * GlobalChatPanel - Feature-rich chat panel with resize, tabs, and pop-out
 *
 * Features:
 * - Resizable sidebar (drag left edge)
 * - Session tabs with overflow dropdown
 * - Pop-out to separate window
 * - Draggable floating cards
 * - Persistent state across refresh
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Send,
  Loader2,
  Bot,
  User,
  Terminal,
  X,
  MessageSquare,
  Minimize2,
  FileText,
  GripVertical,
  ExternalLink,
  ChevronDown,
  ImageIcon,
  Globe,
  Users,
} from 'lucide-react';
import { useChatPanel } from '@/lib/contexts/ChatContext';
import { ColabTrigger } from './ColabPanel';
import type { CollabChannel, CollabParticipant, CollabMessage } from '@/lib/types';
import { renderMessageContent } from '@/lib/message-renderer';
import { filterHiddenMessages, formatCrossChannelMessageForHumans } from '@/lib/hidden-messages';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

// Generate a persistent browser participant ID
const BROWSER_PARTICIPANT_ID = typeof window !== 'undefined'
  ? localStorage.getItem('devflow-collab-participant-id') || (() => {
      const id = `browser-user-${Date.now().toString(36)}`;
      localStorage.setItem('devflow-collab-participant-id', id);
      return id;
    })()
  : 'browser-user';

const MAX_VISIBLE_TABS = 3;

// Image attachment type
interface PendingImage {
  data: string; // base64 data URL
  name: string;
  type: string;
}

export function GlobalChatPanel() {
  const collabRouter = useRouter();
  const {
    sessions,
    activeSessionId,
    isPanelOpen,
    panelWidth,
    cardPositions,
    poppedOutSessions,
    closePanel,
    endSession,
    sendMessage,
    switchSession,
    setPanelWidth,
    setCardPosition,
    popOutSession,
  } = useChatPanel();

  const [inputValue, setInputValue] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [activeCollab, setActiveCollab] = useState<CollabChannel | null>(null);
  const [collabMessages, setCollabMessages] = useState<CollabMessage[]>([]);
  const [collabParticipantId, setCollabParticipantId] = useState<string | null>(null);
  const [isCollabMode, setIsCollabMode] = useState(false);
  const [collabLoading, setCollabLoading] = useState(false);
  const visibleCollabMessages = filterHiddenMessages(collabMessages, false)
    .map(formatCrossChannelMessageForHumans);
  const lastPollTime = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Get active session and all sessions as array
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;
  const allSessions = Array.from(sessions.values())
    .filter(s => !poppedOutSessions.has(s.sourceId));

  // Split sessions into visible tabs and overflow
  const visibleSessions = allSessions.slice(0, MAX_VISIBLE_TABS);
  const overflowSessions = allSessions.slice(MAX_VISIBLE_TABS);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages, activeSession?.streamingContent]);

  // Focus input when panel opens or session expands
  useEffect(() => {
    if (isPanelOpen && activeSession && isExpanded) {
      inputRef.current?.focus();
    }
  }, [isPanelOpen, activeSession, isExpanded]);

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, setPanelWidth]);

  // Close overflow menu when clicking outside
  useEffect(() => {
    if (!showOverflowMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showOverflowMenu]);

  // Join collab channel when selected
  useEffect(() => {
    if (!activeCollab) {
      setIsCollabMode(false);
      setCollabMessages([]);
      setCollabParticipantId(null);
      lastPollTime.current = null;
      return;
    }

    const joinChannel = async () => {
      setCollabLoading(true);
      try {
        // Join as browser participant
        const res = await fetch('/api/collab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'join',
            channelId: activeCollab.id,
            participant: {
              id: BROWSER_PARTICIPANT_ID,
              type: 'user',
              name: (typeof window !== 'undefined' && localStorage.getItem('devflow-collab-username')) || HUMAN_ROUTING_NAME,
              source: 'DevFlow Browser',
            },
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success && data.channel) {
            setCollabMessages(data.channel.messages || []);
            const pid = data.participantId || BROWSER_PARTICIPANT_ID;
            setCollabParticipantId(pid);
            setIsCollabMode(true);
            lastPollTime.current = new Date().toISOString();
            // Mark channel as read so the unread badge clears
            fetch('/api/collab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'mark_read', channelId: activeCollab.id, participantId: pid }),
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('Failed to join collab channel:', err);
      } finally {
        setCollabLoading(false);
      }
    };

    joinChannel();
  }, [activeCollab?.id]);

  // Poll for new collab messages
  useEffect(() => {
    if (!isCollabMode || !activeCollab) return;

    const pollMessages = async () => {
      try {
        const since = lastPollTime.current || new Date().toISOString();
        const res = await fetch(
          `/api/collab?channelId=${activeCollab.id}&since=${encodeURIComponent(since)}`
        );

        if (res.ok) {
          const data = await res.json();
          if (data.messages && data.messages.length > 0) {
            setCollabMessages(prev => [...prev, ...data.messages]);
          }
          lastPollTime.current = data.timestamp;
        }
      } catch (err) {
        console.error('Failed to poll collab messages:', err);
      }
    };

    // Poll every 2 seconds
    const interval = setInterval(pollMessages, 2000);
    return () => clearInterval(interval);
  }, [isCollabMode, activeCollab?.id]);

  // Auto-scroll when collab messages change
  useEffect(() => {
    if (isCollabMode) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [collabMessages, isCollabMode]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // Handle paste event for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          setPendingImage({
            data: dataUrl,
            name: file.name || `pasted-image-${Date.now()}.png`,
            type: file.type,
          });
        };
        reader.readAsDataURL(file);
        break; // Only handle first image
      }
    }
  }, []);

  // Remove pending image
  const removePendingImage = useCallback(() => {
    setPendingImage(null);
  }, []);

  // Handle drag-and-drop for images
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set false if we're leaving the drop zone entirely
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Find the first image file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          setPendingImage({
            data: dataUrl,
            name: file.name,
            type: file.type,
          });
        };
        reader.readAsDataURL(file);
        break; // Only handle first image
      }
    }
  }, []);

  // Send message to collab channel
  const sendCollabMessage = useCallback(async (content: string) => {
    if (!activeCollab || !collabParticipantId) return;

    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          channelId: activeCollab.id,
          participantId: collabParticipantId,
          content,
        }),
      });

      if (res.ok) {
        // Message will appear via polling
        // Force immediate poll
        const pollRes = await fetch(
          `/api/collab?channelId=${activeCollab.id}&since=${encodeURIComponent(lastPollTime.current || new Date().toISOString())}`
        );
        if (pollRes.ok) {
          const data = await pollRes.json();
          if (data.messages && data.messages.length > 0) {
            setCollabMessages(prev => [...prev, ...data.messages]);
          }
          lastPollTime.current = data.timestamp;
        }
      }
    } catch (err) {
      console.error('Failed to send collab message:', err);
    }
  }, [activeCollab, collabParticipantId]);

  // Leave collaboration channel properly
  const handleLeaveCollab = useCallback(async () => {
    if (!activeCollab || !collabParticipantId) {
      // Just clear local state if not properly joined
      setActiveCollab(null);
      setCollabMessages([]);
      setCollabParticipantId(null);
      setIsCollabMode(false);
      return;
    }

    try {
      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          channelId: activeCollab.id,
          participantId: collabParticipantId,
        }),
      });
    } catch (err) {
      console.error('Failed to leave collab channel:', err);
    }

    // Clear local state regardless of API result
    setActiveCollab(null);
    setCollabMessages([]);
    setCollabParticipantId(null);
    setIsCollabMode(false);
    lastPollTime.current = null;
  }, [activeCollab, collabParticipantId]);

  const handleSend = useCallback(async () => {
    const message = inputValue.trim();
    if (!message && !pendingImage) return;

    // Collab mode - send to channel
    if (isCollabMode && activeCollab && collabParticipantId) {
      setInputValue('');
      setPendingImage(null);
      await sendCollabMessage(message);
      return;
    }

    // Normal chat mode
    if (!activeSession || activeSession.isStreaming) return;

    const imageToSend = pendingImage;
    setInputValue('');
    setPendingImage(null);
    await sendMessage(message, imageToSend?.data);
  }, [inputValue, pendingImage, activeSession, sendMessage, isCollabMode, activeCollab, collabParticipantId, sendCollabMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleEndSession = useCallback(async (sourceId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    await endSession(sourceId);
  }, [endSession]);

  const handleCardClick = useCallback((sourceId: string) => {
    switchSession(sourceId);
    setIsExpanded(true);
  }, [switchSession]);

  const handleMinimize = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handlePopOut = useCallback((sourceId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    popOutSession(sourceId);
  }, [popOutSession]);

  // Don't render anything if no sessions
  if (!isPanelOpen || allSessions.length === 0) {
    return null;
  }

  // When minimized, show floating cards only
  if (!isExpanded) {
    return (
      <div className="chat-floating-cards standalone">
        {allSessions.map((session) => (
          <DraggableFloatingCard
            key={session.sourceId}
            session={session}
            isActive={session.sourceId === activeSessionId}
            position={cardPositions.get(session.sourceId)}
            onClick={() => handleCardClick(session.sourceId)}
            onEnd={(e) => handleEndSession(session.sourceId, e)}
            onPopOut={(e) => handlePopOut(session.sourceId, e)}
            onPositionChange={(pos) => setCardPosition(session.sourceId, pos)}
          />
        ))}
      </div>
    );
  }

  // Expanded view - show active session with chat
  return (
    <>
      {/* Floating cards for inactive sessions (not shown when expanded - use tabs instead) */}

      {/* Main chat sidebar */}
      <div
        className={`chat-sidebar ${isResizing ? 'resizing' : ''}`}
        style={{ '--chat-panel-width': `${panelWidth}px` } as React.CSSProperties}
      >
        {/* Resize Handle */}
        <div
          className={`chat-resize-handle ${isResizing ? 'active' : ''}`}
          onMouseDown={handleResizeStart}
        />

        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-main">
            <div className="chat-header-drag">
              <GripVertical className="w-4 h-4" />
            </div>
            <div className="chat-header-title">
              <Terminal className="w-4 h-4 text-green-400 flex-shrink-0" />
              <span className="text-sm font-medium" title={activeSession?.sourceTitle}>
                {activeSession?.sourceTitle || 'Chat'}
              </span>
              <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded flex-shrink-0">
                MAX
              </span>
              {/* Collab participants */}
              {activeCollab && activeCollab.participants.length > 0 && (
                <div className="flex items-center gap-0.5">
                  {activeCollab.participants.slice(0, 4).map((p) => (
                    <div
                      key={p.id}
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium -ml-1 first:ml-0 ring-1 ring-card"
                      style={{ backgroundColor: p.color || '#8B5CF6' }}
                      title={`${p.name} (${p.source})`}
                    >
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                  ))}
                  {activeCollab.participants.length > 4 && (
                    <span className="text-[10px] text-muted ml-1">+{activeCollab.participants.length - 4}</span>
                  )}
                </div>
              )}
            </div>
            {/* Projects button - opens full panel */}
            <ColabTrigger
              onClick={() => collabRouter.push('/')}
              hasActiveChannel={!!activeCollab}
              participantCount={activeCollab?.participants?.length}
            />
            <div className="chat-header-actions">
              {activeSession && (
                <>
                  <button
                    onClick={(e) => handlePopOut(activeSession.sourceId, e)}
                    className="chat-header-btn pop-out"
                    title="Pop out to window"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleEndSession(activeSession.sourceId)}
                    className="chat-header-btn end"
                    title="End session"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </>
              )}
              {/* Minimize button for single session */}
              {allSessions.length === 1 && (
                <button
                  onClick={handleMinimize}
                  className="chat-header-btn"
                  title="Minimize to card"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={closePanel}
                className="chat-header-btn"
                title="Close panel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Session Tab Bar */}
          {allSessions.length > 1 && (
            <div className="session-tab-bar">
              {visibleSessions.map((session) => (
                <button
                  key={session.sourceId}
                  onClick={() => switchSession(session.sourceId)}
                  className={`session-tab ${session.sourceId === activeSessionId ? 'active' : ''} ${session.isStreaming ? 'streaming' : ''}`}
                  title={session.sourceTitle}
                >
                  <FileText className="w-3 h-3 flex-shrink-0" />
                  <span className="session-tab-title">{session.sourceTitle}</span>
                  {session.isStreaming && (
                    <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                  )}
                  <button
                    onClick={(e) => handleEndSession(session.sourceId, e)}
                    className="session-tab-close"
                    title="End session"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </button>
              ))}

              {/* Overflow Dropdown */}
              {overflowSessions.length > 0 && (
                <div className="relative" ref={overflowMenuRef}>
                  <button
                    onClick={() => setShowOverflowMenu(!showOverflowMenu)}
                    className="session-overflow-trigger"
                  >
                    <ChevronDown className="w-3 h-3" />
                    <span>+{overflowSessions.length}</span>
                  </button>

                  {showOverflowMenu && (
                    <div className="session-overflow-menu">
                      {overflowSessions.map((session) => (
                        <button
                          key={session.sourceId}
                          onClick={() => {
                            switchSession(session.sourceId);
                            setShowOverflowMenu(false);
                          }}
                          className={`session-overflow-item ${session.sourceId === activeSessionId ? 'active' : ''}`}
                        >
                          <FileText className="w-4 h-4 flex-shrink-0" />
                          <span className="flex-1 truncate text-left">{session.sourceTitle}</span>
                          {session.isStreaming && (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          )}
                          <button
                            onClick={(e) => {
                              handleEndSession(session.sourceId, e);
                              setShowOverflowMenu(false);
                            }}
                            className="p-1 rounded hover:bg-red-400/20 text-muted hover:text-red-400"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Minimize Button */}
              <button
                onClick={handleMinimize}
                className="chat-header-btn minimize"
                title="Minimize to cards"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Collab Mode */}
          {isCollabMode && activeCollab && (
            <>
              {/* Collab header */}
              <div className="text-center text-muted text-xs py-2 border-b border-white/10 mb-4">
                <Users className="w-4 h-4 inline-block mr-1" />
                Projects: <span className="text-purple-400 font-medium">{activeCollab.name}</span>
                <button
                  onClick={handleLeaveCollab}
                  className="ml-2 text-red-400 hover:text-red-300"
                >
                  Leave
                </button>
              </div>

              {collabLoading ? (
                <div className="text-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-purple-400" />
                  <p className="text-xs text-muted mt-2">Joining channel...</p>
                </div>
              ) : visibleCollabMessages.length === 0 ? (
                <div className="text-center text-muted text-sm py-8">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No messages yet</p>
                  <p className="text-xs mt-1 opacity-70">
                    Start the conversation or wait for others to join
                  </p>
                </div>
              ) : (
                visibleCollabMessages.map((msg) => {
                  const isOwnMessage = msg.from.id === collabParticipantId;
                  const isSystem = msg.from.id === 'system';

                  if (isSystem) {
                    return (
                      <div key={msg.id} className="text-center text-xs text-muted py-1">
                        {renderMessageContent(msg.content, activeCollab?.participants ?? [])}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id}
                      className={`flex gap-3 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
                    >
                      {!isOwnMessage && (
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold"
                          style={{ backgroundColor: msg.from.color || '#8B5CF6' }}
                          title={`${msg.from.name} (${msg.from.source})`}
                        >
                          {msg.from.type === 'claude-terminal' ? (
                            <Terminal className="w-3.5 h-3.5" />
                          ) : msg.from.type === 'claude-browser' ? (
                            <Bot className="w-3.5 h-3.5" />
                          ) : (
                            msg.from.name.charAt(0).toUpperCase()
                          )}
                        </div>
                      )}
                      <div className="max-w-[85%]">
                        {!isOwnMessage && (
                          <div className="text-xs text-muted mb-1">
                            {msg.from.name}
                            <span className="opacity-50 ml-1">({msg.from.source})</span>
                          </div>
                        )}
                        <div
                          className={`rounded-lg px-3 py-2 ${
                            isOwnMessage
                              ? 'bg-accent text-white'
                              : msg.from.type?.includes('claude')
                              ? 'bg-purple-500/10 border border-purple-500/20'
                              : 'bg-white/5'
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap break-words">{renderMessageContent(msg.content, activeCollab?.participants ?? [])}</p>
                        </div>
                      </div>
                      {isOwnMessage && (
                        <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                          <User className="w-4 h-4" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* Normal Chat Mode */}
          {!isCollabMode && (
            <>
              {activeSession?.messages.length === 0 && !activeSession?.isStreaming && (
                <div className="text-center text-muted text-sm py-8">
                  <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>Ask a question about this {activeSession?.sourceType}</p>
                  <p className="text-xs mt-1 opacity-70">
                    Using Claude Code - no API credits consumed
                  </p>
                </div>
              )}

              {activeSession?.messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-4 h-4 text-green-400" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 ${
                      msg.role === 'user'
                        ? 'bg-accent text-white'
                        : 'bg-white/5 text-foreground'
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap break-words">{renderMessageContent(msg.content, [])}</p>
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming message */}
              {activeSession?.isStreaming && (
                <div className="flex gap-3 justify-start">
                  <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                    <Bot className="w-4 h-4 text-green-400" />
                  </div>
                  <div className="max-w-[85%] rounded-lg px-3 py-2 bg-white/5">
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {activeSession.streamingContent || '...'}
                      <span className="inline-block w-2 h-4 bg-green-400/50 animate-pulse ml-0.5" />
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input with drag-and-drop zone */}
        <div
          ref={dropZoneRef}
          className={`chat-input-zone p-3 border-t border-white/10 ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drag overlay */}
          {isDragOver && (
            <div className="chat-drag-overlay">
              <ImageIcon className="w-8 h-8 text-green-400" />
              <span className="text-green-400 font-medium">Drop image here</span>
            </div>
          )}
          {/* Image Preview */}
          {pendingImage && (
            <div className="mb-2 relative inline-block">
              <img
                src={pendingImage.data}
                alt="Pending upload"
                className="max-h-24 rounded-lg border border-white/20"
              />
              <button
                onClick={removePendingImage}
                className="absolute -top-2 -right-2 p-1 bg-red-500 rounded-full hover:bg-red-600 transition-colors"
                title="Remove image"
              >
                <X className="w-3 h-3" />
              </button>
              <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] flex items-center gap-1">
                <ImageIcon className="w-3 h-3" />
                <span>Image attached</span>
              </div>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={pendingImage ? 'Add a message or press Enter to send image...' : `Ask about this ${activeSession?.sourceType || 'content'}...`}
              disabled={activeSession?.isStreaming}
              rows={4}
              className="chat-textarea flex-1 px-3 py-2.5 bg-black/40 border border-white/10 rounded-lg
                       text-white placeholder-white/40 focus:outline-none focus:border-green-500/50
                       resize-none text-sm disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={(!inputValue.trim() && !pendingImage) || activeSession?.isStreaming}
              className="p-3 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-end"
            >
              {activeSession?.isStreaming ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted mt-1.5 text-center">
            Enter to send · Shift+Enter for newline · Paste or drop images
          </p>
        </div>
      </div>

    </>
  );
}

// Draggable floating card component
interface DraggableFloatingCardProps {
  session: {
    sourceId: string;
    sourceTitle: string;
    sourceType: string;
    messages: Array<{ role: string; content: string }>;
    isStreaming: boolean;
    lastActivity: string;
  };
  isActive: boolean;
  position?: { x: number; y: number };
  onClick: () => void;
  onEnd: (e: React.MouseEvent) => void;
  onPopOut: (e: React.MouseEvent) => void;
  onPositionChange: (pos: { x: number; y: number }) => void;
}

function DraggableFloatingCard({
  session,
  isActive,
  position,
  onClick,
  onEnd,
  onPopOut,
  onPositionChange,
}: DraggableFloatingCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // Default position if not set
  const currentPos = position || { x: window.innerWidth - 300, y: 80 };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;

      // Constrain to viewport (keep at least 50px visible)
      const constrainedX = Math.max(50 - 280, Math.min(window.innerWidth - 50, newX));
      const constrainedY = Math.max(0, Math.min(window.innerHeight - 50, newY));

      onPositionChange({ x: constrainedX, y: constrainedY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset, onPositionChange]);

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = cardRef.current?.getBoundingClientRect();
    if (rect) {
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
    setIsDragging(true);
  };

  const messageCount = session.messages.length;
  const lastMessage = session.messages[session.messages.length - 1];
  const preview = lastMessage?.content.slice(0, 50) || 'Click to expand';

  return (
    <div
      ref={cardRef}
      onClick={isDragging ? undefined : onClick}
      className={`chat-floating-card ${isActive ? 'active' : ''} ${session.isStreaming ? 'streaming' : ''} ${isDragging ? 'dragging' : ''}`}
      style={{
        position: 'fixed',
        left: currentPos.x,
        top: currentPos.y,
        zIndex: isDragging ? 100 : 45,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className="card-drag-handle"
          onMouseDown={handleDragStart}
          title="Drag to move"
        >
          <GripVertical className="w-4 h-4" />
        </div>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-green-400' : 'text-muted'}`} />
          <span className={`text-sm font-medium truncate ${isActive ? 'text-green-400' : 'text-white'}`}>
            {session.sourceTitle}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {session.isStreaming && (
            <Loader2 className="w-3 h-3 animate-spin text-green-400" />
          )}
          <button
            onClick={onPopOut}
            className="p-1 rounded hover:bg-blue-400/20 text-muted hover:text-blue-400 transition-colors"
            title="Pop out to window"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            onClick={onEnd}
            className="p-1 rounded hover:bg-red-400/20 text-muted hover:text-red-400 transition-colors"
            title="End session"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {messageCount}
        </span>
        <span className="truncate opacity-70 flex-1">{preview}...</span>
      </div>
    </div>
  );
}
