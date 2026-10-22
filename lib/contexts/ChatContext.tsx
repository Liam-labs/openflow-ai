'use client';

/**
 * ChatContext - Global Chat Panel State Management
 *
 * Provides persistent chat sessions that survive navigation between tabs.
 * Sessions are stored in memory and can be opened from docs, projects, etc.
 * Supports resizable panel, draggable cards, and pop-out windows.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import type { GlobalChatSession, ChatSourceType, ChatMessage, CardPosition } from '@/lib/types';

// localStorage keys
const STORAGE_KEYS = {
  PANEL_WIDTH: 'devflow-chat-panel-width',
  CARD_POSITIONS: 'devflow-chat-card-positions',
  SESSIONS: 'devflow-chat-sessions',
};

// Default values
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 800;

interface ChatContextValue {
  // State
  sessions: Map<string, GlobalChatSession>;
  activeSessionId: string | null;
  isPanelOpen: boolean;

  // UI State
  panelWidth: number;
  cardPositions: Map<string, CardPosition>;
  poppedOutSessions: Set<string>;

  // Actions
  openSession: (
    sourceType: ChatSourceType,
    sourceId: string,
    title: string,
    content?: string
  ) => Promise<void>;
  closeSession: (sourceId: string) => Promise<void>;
  endSession: (sourceId: string) => Promise<void>;
  switchSession: (sourceId: string) => void;
  sendMessage: (content: string, imageData?: string) => Promise<void>;
  togglePanel: () => void;
  closePanel: () => void;
  openPanel: () => void;

  // UI Actions
  setPanelWidth: (width: number) => void;
  setCardPosition: (sourceId: string, position: CardPosition) => void;
  popOutSession: (sourceId: string) => void;
  popInSession: (sourceId: string) => void;

  // Queries
  hasActiveSession: (sourceId: string) => boolean;
  getSession: (sourceId: string) => GlobalChatSession | undefined;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatPanel(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChatPanel must be used within ChatProvider');
  }
  return context;
}

interface ChatProviderProps {
  children: ReactNode;
}

export function ChatProvider({ children }: ChatProviderProps) {
  // Core state
  const [sessions, setSessions] = useState<Map<string, GlobalChatSession>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  // UI state - initialized from localStorage
  const [panelWidth, setPanelWidthState] = useState<number>(DEFAULT_PANEL_WIDTH);
  const [cardPositions, setCardPositionsState] = useState<Map<string, CardPosition>>(new Map());
  const [poppedOutSessions, setPoppedOutSessions] = useState<Set<string>>(new Set());

  // Track abort controllers for active streams
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // BroadcastChannel for cross-window communication
  const broadcastChannel = useRef<BroadcastChannel | null>(null);

  // Helper to save sessions to localStorage
  const saveSessionsToStorage = useCallback((sessionsMap: Map<string, GlobalChatSession>) => {
    const sessionsObj: Record<string, GlobalChatSession> = {};
    sessionsMap.forEach((session, id) => {
      // Don't persist streaming state
      sessionsObj[id] = {
        ...session,
        isStreaming: false,
        streamingContent: '',
      };
    });
    localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sessionsObj));
  }, []);

  // Initialize from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Load panel width
    const savedWidth = localStorage.getItem(STORAGE_KEYS.PANEL_WIDTH);
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10);
      if (!isNaN(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH) {
        setPanelWidthState(parsed);
      }
    }

    // Load card positions
    const savedPositions = localStorage.getItem(STORAGE_KEYS.CARD_POSITIONS);
    if (savedPositions) {
      try {
        const parsed = JSON.parse(savedPositions) as Record<string, CardPosition>;
        setCardPositionsState(new Map(Object.entries(parsed)));
      } catch {
        // Invalid JSON, ignore
      }
    }

    // Load saved sessions
    const savedSessions = localStorage.getItem(STORAGE_KEYS.SESSIONS);
    if (savedSessions) {
      try {
        const parsed = JSON.parse(savedSessions) as Record<string, GlobalChatSession>;
        const sessionsMap = new Map(Object.entries(parsed));

        // Validate sessions against server (check if they're still alive)
        // For now, just restore them - the server session may have expired
        // but we still have the conversation history
        if (sessionsMap.size > 0) {
          setSessions(sessionsMap);
          // Set the most recent session as active
          const sortedSessions = Array.from(sessionsMap.values())
            .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
          if (sortedSessions.length > 0) {
            setActiveSessionId(sortedSessions[0].sourceId);
          }
        }
      } catch {
        // Invalid JSON, ignore
      }
    }

    // Initialize BroadcastChannel for cross-window sync
    try {
      broadcastChannel.current = new BroadcastChannel('devflow-chat');
      broadcastChannel.current.onmessage = (event) => {
        const { type, sourceId, data } = event.data;
        switch (type) {
          case 'POPOUT_CLOSED':
            // Remove from popped out set when pop-out window closes
            setPoppedOutSessions(prev => {
              const next = new Set(prev);
              next.delete(sourceId);
              return next;
            });
            break;
          case 'STREAM_UPDATE':
            // Update streaming content from pop-out window
            if (data && typeof data === 'object' && 'streamingContent' in data) {
              setSessions(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(sourceId);
                if (existing) {
                  newMap.set(sourceId, {
                    ...existing,
                    streamingContent: (data as { streamingContent: string }).streamingContent,
                  });
                }
                return newMap;
              });
            }
            break;
          case 'MESSAGE_SENT':
            // Sync messages from pop-out window
            if (data && typeof data === 'object' && 'messages' in data) {
              setSessions(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(sourceId);
                if (existing) {
                  newMap.set(sourceId, {
                    ...existing,
                    messages: (data as { messages: ChatMessage[] }).messages,
                    isStreaming: false,
                    streamingContent: '',
                  });
                }
                return newMap;
              });
            }
            break;
        }
      };
    } catch {
      // BroadcastChannel not supported
    }

    return () => {
      broadcastChannel.current?.close();
    };
  }, []);

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    if (sessions.size > 0) {
      saveSessionsToStorage(sessions);
    } else {
      // Clear storage when all sessions are closed
      localStorage.removeItem(STORAGE_KEYS.SESSIONS);
    }
  }, [sessions, saveSessionsToStorage]);

  // Persist panel width to localStorage
  const setPanelWidth = useCallback((width: number) => {
    const clamped = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
    setPanelWidthState(clamped);
    localStorage.setItem(STORAGE_KEYS.PANEL_WIDTH, String(clamped));
  }, []);

  // Persist card position to localStorage
  const setCardPosition = useCallback((sourceId: string, position: CardPosition) => {
    setCardPositionsState(prev => {
      const newMap = new Map(prev);
      newMap.set(sourceId, position);
      // Save to localStorage
      const obj: Record<string, CardPosition> = {};
      newMap.forEach((pos, id) => { obj[id] = pos; });
      localStorage.setItem(STORAGE_KEYS.CARD_POSITIONS, JSON.stringify(obj));
      return newMap;
    });
  }, []);

  // Pop out a session to its own window
  const popOutSession = useCallback((sourceId: string) => {
    const session = sessions.get(sourceId);
    if (!session) return;

    // Store session data in localStorage for the pop-out window to read
    localStorage.setItem(
      `devflow-chat-session-${sourceId}`,
      JSON.stringify(session)
    );

    // Open a minimal popup window
    const width = 450;
    const height = 700;
    const left = window.screenX + window.innerWidth - width - 20;
    const top = window.screenY + 80;

    window.open(
      `/chat/${encodeURIComponent(sourceId)}`,
      `chat-${sourceId}`,
      `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes`
    );

    // Track as popped out
    setPoppedOutSessions(prev => new Set([...prev, sourceId]));

    // Broadcast to other windows
    broadcastChannel.current?.postMessage({
      type: 'POPOUT_OPENED',
      sourceId,
      timestamp: new Date().toISOString(),
    });
  }, [sessions]);

  // Pop in a session from its own window
  const popInSession = useCallback((sourceId: string) => {
    setPoppedOutSessions(prev => {
      const next = new Set(prev);
      next.delete(sourceId);
      return next;
    });

    // Broadcast to close the pop-out window
    broadcastChannel.current?.postMessage({
      type: 'POPOUT_CLOSED',
      sourceId,
      timestamp: new Date().toISOString(),
    });
  }, []);

  // Helper to update a session
  const updateSession = useCallback((sourceId: string, updates: Partial<GlobalChatSession>) => {
    setSessions(prev => {
      const newMap = new Map(prev);
      const existing = newMap.get(sourceId);
      if (existing) {
        newMap.set(sourceId, { ...existing, ...updates, lastActivity: new Date().toISOString() });
      }
      return newMap;
    });
  }, []);

  // Open or switch to a session
  const openSession = useCallback(async (
    sourceType: ChatSourceType,
    sourceId: string,
    title: string,
    content?: string
  ) => {
    // Check if session already exists
    const existing = sessions.get(sourceId);
    if (existing) {
      // Just switch to it and open panel
      setActiveSessionId(sourceId);
      setIsPanelOpen(true);
      updateSession(sourceId, {}); // Update lastActivity
      return;
    }

    // Create new server session
    try {
      const response = await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          documentTitle: title,
          documentContent: content || `Context: ${title}`,
        }),
      });

      const data = await response.json();

      if (data.success && data.sessionId) {
        const newSession: GlobalChatSession = {
          id: data.sessionId,
          sourceType,
          sourceId,
          sourceTitle: title,
          sourceContent: content,
          messages: [],
          streamingContent: '',
          isStreaming: false,
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        };

        setSessions(prev => {
          const newMap = new Map(prev);
          newMap.set(sourceId, newSession);
          return newMap;
        });
        setActiveSessionId(sourceId);
        setIsPanelOpen(true);
      } else {
        console.error('Failed to create chat session:', data.error);
      }
    } catch (error) {
      console.error('Error creating chat session:', error);
    }
  }, [sessions, updateSession]);

  // Close panel but keep session alive
  const closePanel = useCallback(() => {
    setIsPanelOpen(false);
  }, []);

  // Open panel (if there's an active session)
  const openPanel = useCallback(() => {
    if (activeSessionId) {
      setIsPanelOpen(true);
    }
  }, [activeSessionId]);

  // Toggle panel
  const togglePanel = useCallback(() => {
    setIsPanelOpen(prev => !prev);
  }, []);

  // Close session but keep it in memory (just hide from panel)
  const closeSession = useCallback(async (sourceId: string) => {
    // Cancel any active stream
    const controller = abortControllers.current.get(sourceId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(sourceId);
    }

    // If this is the active session, switch to another or close panel
    if (activeSessionId === sourceId) {
      const otherSessions = Array.from(sessions.keys()).filter(id => id !== sourceId);
      if (otherSessions.length > 0) {
        setActiveSessionId(otherSessions[0]);
      } else {
        setActiveSessionId(null);
        setIsPanelOpen(false);
      }
    }
  }, [activeSessionId, sessions]);

  // End session completely (stop on server, remove from memory)
  const endSession = useCallback(async (sourceId: string) => {
    const session = sessions.get(sourceId);
    if (!session) return;

    // Cancel any active stream
    const controller = abortControllers.current.get(sourceId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(sourceId);
    }

    // Stop session on server
    try {
      await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          sessionId: session.id,
        }),
      });
    } catch (error) {
      console.error('Error stopping session:', error);
    }

    // Remove from local state
    setSessions(prev => {
      const newMap = new Map(prev);
      newMap.delete(sourceId);
      return newMap;
    });

    // Update active session
    if (activeSessionId === sourceId) {
      const remaining = Array.from(sessions.keys()).filter(id => id !== sourceId);
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0]);
      } else {
        setActiveSessionId(null);
        setIsPanelOpen(false);
      }
    }
  }, [sessions, activeSessionId]);

  // Switch to a different session
  const switchSession = useCallback((sourceId: string) => {
    if (sessions.has(sourceId)) {
      setActiveSessionId(sourceId);
      setIsPanelOpen(true);
    }
  }, [sessions]);

  // Reconnect an expired session
  const reconnectSession = useCallback(async (sourceId: string): Promise<string | null> => {
    const session = sessions.get(sourceId);
    if (!session) return null;

    try {
      const response = await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          documentTitle: session.sourceTitle,
          documentContent: session.sourceContent || `Context: ${session.sourceTitle}`,
        }),
      });

      const data = await response.json();
      if (data.success && data.sessionId) {
        // Update session with new server ID
        setSessions(prev => {
          const newMap = new Map(prev);
          const existing = newMap.get(sourceId);
          if (existing) {
            newMap.set(sourceId, { ...existing, id: data.sessionId });
          }
          return newMap;
        });
        return data.sessionId;
      }
    } catch (err) {
      console.error('Failed to reconnect session:', err);
    }
    return null;
  }, [sessions]);

  // Send a message to the active session
  const sendMessage = useCallback(async (content: string, imageData?: string) => {
    if (!activeSessionId) return;

    const session = sessions.get(activeSessionId);
    if (!session || session.isStreaming) return;

    // Add user message (with image indicator if present)
    const displayContent = imageData ? `${content}\n[Image attached]` : content;
    const userMessage: ChatMessage = { role: 'user', content: displayContent || '[Image]' };
    updateSession(activeSessionId, {
      messages: [...session.messages, userMessage],
      isStreaming: true,
      streamingContent: '',
    });

    // Create abort controller for this stream
    const controller = new AbortController();
    abortControllers.current.set(activeSessionId, controller);

    let activeServerId = session.id;

    try {
      let response = await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          sessionId: activeServerId,
          content: content || 'Please analyze this image.',
          imageData,
        }),
        signal: controller.signal,
      });

      // If session expired on server, try to reconnect
      if (response.status === 404) {
        console.log('Session expired, reconnecting...');
        const newSessionId = await reconnectSession(activeSessionId);
        if (newSessionId) {
          activeServerId = newSessionId;
          // Retry with new session ID
          response = await fetch('/api/docs/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'message',
              sessionId: activeServerId,
              content: content || 'Please analyze this image.',
              imageData,
            }),
            signal: controller.signal,
          });
        }
      }

      if (!response.ok) {
        throw new Error(`Message request failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'text') {
                assistantContent += parsed.content;
                // Update streaming content
                setSessions(prev => {
                  const newMap = new Map(prev);
                  const current = newMap.get(activeSessionId);
                  if (current) {
                    newMap.set(activeSessionId, {
                      ...current,
                      streamingContent: assistantContent,
                    });
                  }
                  return newMap;
                });
              } else if (parsed.type === 'error') {
                throw new Error(parsed.message);
              }
            } catch {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }

      // Finalize message
      setSessions(prev => {
        const newMap = new Map(prev);
        const current = newMap.get(activeSessionId);
        if (current) {
          newMap.set(activeSessionId, {
            ...current,
            messages: [...current.messages, { role: 'assistant', content: assistantContent }],
            streamingContent: '',
            isStreaming: false,
            lastActivity: new Date().toISOString(),
          });
        }
        return newMap;
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // Stream was cancelled, that's fine
        return;
      }

      console.error('Chat error:', error);

      // Add error message
      setSessions(prev => {
        const newMap = new Map(prev);
        const current = newMap.get(activeSessionId);
        if (current) {
          newMap.set(activeSessionId, {
            ...current,
            messages: [
              ...current.messages,
              { role: 'assistant', content: 'Sorry, an error occurred. Please try again.' },
            ],
            streamingContent: '',
            isStreaming: false,
          });
        }
        return newMap;
      });
    } finally {
      abortControllers.current.delete(activeSessionId);
    }
  }, [activeSessionId, sessions, updateSession]);

  // Query: check if a source has an active session
  const hasActiveSession = useCallback((sourceId: string) => {
    return sessions.has(sourceId);
  }, [sessions]);

  // Query: get a session by source ID
  const getSession = useCallback((sourceId: string) => {
    return sessions.get(sourceId);
  }, [sessions]);

  const value: ChatContextValue = {
    // Core state
    sessions,
    activeSessionId,
    isPanelOpen,

    // UI state
    panelWidth,
    cardPositions,
    poppedOutSessions,

    // Core actions
    openSession,
    closeSession,
    endSession,
    switchSession,
    sendMessage,
    togglePanel,
    closePanel,
    openPanel,

    // UI actions
    setPanelWidth,
    setCardPosition,
    popOutSession,
    popInSession,

    // Queries
    hasActiveSession,
    getSession,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
