'use client';

/**
 * ChatPopoutClient - Standalone chat window for popped-out sessions
 *
 * Features:
 * - Full-screen chat interface
 * - Syncs with main window via BroadcastChannel
 * - Notifies main window on close
 * - Resumes session from localStorage
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Loader2,
  Bot,
  User,
  Terminal,
  X,
  ArrowLeft,
} from 'lucide-react';
import type { GlobalChatSession, ChatMessage } from '@/lib/types';
import { renderMessageContent } from '@/lib/message-renderer';

interface ChatPopoutClientProps {
  sessionId: string;
}

export function ChatPopoutClient({ sessionId }: ChatPopoutClientProps) {
  const [session, setSession] = useState<GlobalChatSession | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const broadcastChannel = useRef<BroadcastChannel | null>(null);
  const abortController = useRef<AbortController | null>(null);

  // Load session from localStorage on mount
  useEffect(() => {
    const loadSession = () => {
      try {
        const savedSession = localStorage.getItem(`devflow-chat-session-${sessionId}`);
        if (savedSession) {
          const parsed = JSON.parse(savedSession) as GlobalChatSession;
          setSession(parsed);
          setIsLoading(false);
        } else {
          // Try loading from the main sessions storage
          const allSessions = localStorage.getItem('devflow-chat-sessions');
          if (allSessions) {
            const parsed = JSON.parse(allSessions) as Record<string, GlobalChatSession>;
            if (parsed[sessionId]) {
              setSession(parsed[sessionId]);
              setIsLoading(false);
              return;
            }
          }
          setError('Session not found. It may have been closed.');
          setIsLoading(false);
        }
      } catch (e) {
        setError('Failed to load session data.');
        setIsLoading(false);
      }
    };

    loadSession();

    // Initialize BroadcastChannel for cross-window sync
    try {
      broadcastChannel.current = new BroadcastChannel('devflow-chat');
      broadcastChannel.current.onmessage = (event) => {
        const { type, sourceId, data } = event.data;
        if (sourceId !== sessionId) return;

        switch (type) {
          case 'POPOUT_CLOSED':
            // Main window wants to close this popout
            window.close();
            break;
        }
      };
    } catch {
      // BroadcastChannel not supported
    }

    // Notify main window when this popup closes
    const handleBeforeUnload = () => {
      broadcastChannel.current?.postMessage({
        type: 'POPOUT_CLOSED',
        sourceId: sessionId,
        timestamp: new Date().toISOString(),
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      broadcastChannel.current?.close();
      abortController.current?.abort();
    };
  }, [sessionId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, session?.streamingContent]);

  // Focus input when loaded
  useEffect(() => {
    if (session && !session.isStreaming) {
      inputRef.current?.focus();
    }
  }, [session]);

  // Update session helper
  const updateSession = useCallback((updates: Partial<GlobalChatSession>) => {
    setSession(prev => prev ? { ...prev, ...updates } : null);
  }, []);

  // Reconnect session if it expired on the server
  const reconnectSession = useCallback(async (): Promise<string | null> => {
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
        setSession(prev => prev ? { ...prev, id: data.sessionId } : null);
        return data.sessionId;
      }
    } catch (err) {
      console.error('Failed to reconnect session:', err);
    }
    return null;
  }, [session]);

  // Send message
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || !session || session.isStreaming) return;

    const content = inputValue.trim();
    setInputValue('');

    // Add user message
    const userMessage: ChatMessage = { role: 'user', content };
    const updatedMessages = [...session.messages, userMessage];

    updateSession({
      messages: updatedMessages,
      isStreaming: true,
      streamingContent: '',
    });

    // Create abort controller
    abortController.current = new AbortController();

    let activeSessionId = session.id;

    try {
      let response = await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          sessionId: activeSessionId,
          content,
        }),
        signal: abortController.current.signal,
      });

      // If session expired, try to reconnect
      if (response.status === 404) {
        console.log('Session expired, reconnecting...');
        const newSessionId = await reconnectSession();
        if (newSessionId) {
          activeSessionId = newSessionId;
          // Retry with new session ID
          response = await fetch('/api/docs/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'message',
              sessionId: activeSessionId,
              content,
            }),
            signal: abortController.current.signal,
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
                updateSession({ streamingContent: assistantContent });

                // Broadcast stream update to main window
                broadcastChannel.current?.postMessage({
                  type: 'STREAM_UPDATE',
                  sourceId: sessionId,
                  data: { streamingContent: assistantContent },
                  timestamp: new Date().toISOString(),
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
      const finalMessages = [...updatedMessages, { role: 'assistant' as const, content: assistantContent }];
      updateSession({
        messages: finalMessages,
        streamingContent: '',
        isStreaming: false,
        lastActivity: new Date().toISOString(),
      });

      // Broadcast to main window
      broadcastChannel.current?.postMessage({
        type: 'MESSAGE_SENT',
        sourceId: sessionId,
        data: { messages: finalMessages },
        timestamp: new Date().toISOString(),
      });

      // Update localStorage
      const allSessions = localStorage.getItem('devflow-chat-sessions');
      if (allSessions) {
        const parsed = JSON.parse(allSessions) as Record<string, GlobalChatSession>;
        parsed[sessionId] = {
          ...parsed[sessionId],
          messages: finalMessages,
          lastActivity: new Date().toISOString(),
        };
        localStorage.setItem('devflow-chat-sessions', JSON.stringify(parsed));
      }

    } catch (err) {
      if ((err as Error).name === 'AbortError') return;

      console.error('Chat error:', err);
      updateSession({
        messages: [...updatedMessages, { role: 'assistant', content: 'Sorry, an error occurred. Please try again.' }],
        streamingContent: '',
        isStreaming: false,
      });
    }
  }, [inputValue, session, sessionId, updateSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReturnToMain = () => {
    // Notify main window to pop this session back in
    broadcastChannel.current?.postMessage({
      type: 'POPOUT_CLOSED',
      sourceId: sessionId,
      timestamp: new Date().toISOString(),
    });
    window.close();
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-green-400" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background p-8">
        <Terminal className="w-12 h-12 text-red-400 mb-4" />
        <h1 className="text-xl font-semibold mb-2">Session Error</h1>
        <p className="text-muted text-center mb-6">{error || 'Session not found'}</p>
        <button
          onClick={() => window.close()}
          className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
        >
          Close Window
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-white/10 bg-black/30">
        <button
          onClick={handleReturnToMain}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Return to main window"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Terminal className="w-5 h-5 text-green-400" />
        <span className="text-sm font-medium truncate flex-1" title={session.sourceTitle}>
          {session.sourceTitle}
        </span>
        <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded">
          MAX
        </span>
        <button
          onClick={() => window.close()}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {session.messages.length === 0 && !session.isStreaming && (
          <div className="text-center text-muted text-sm py-8">
            <Bot className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p>Ask a question about this {session.sourceType}</p>
            <p className="text-xs mt-1 opacity-70">
              Using Claude Code - no API credits consumed
            </p>
          </div>
        )}

        {session.messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-green-400" />
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-accent text-white'
                  : 'bg-white/5 text-foreground'
              }`}
            >
              <p className="text-sm whitespace-pre-wrap break-words">{renderMessageContent(msg.content, [])}</p>
            </div>
            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                <User className="w-5 h-5" />
              </div>
            )}
          </div>
        ))}

        {/* Streaming message */}
        {session.isStreaming && (
          <div className="flex gap-3 justify-start">
            <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-5 h-5 text-green-400" />
            </div>
            <div className="max-w-[85%] rounded-lg px-4 py-3 bg-white/5">
              <p className="text-sm whitespace-pre-wrap break-words">
                {session.streamingContent || '...'}
                <span className="inline-block w-2 h-5 bg-green-400/50 animate-pulse ml-0.5" />
              </p>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-white/10">
        <div className="flex gap-3">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask about this ${session.sourceType}...`}
            disabled={session.isStreaming}
            rows={1}
            className="flex-1 px-4 py-3 bg-black/40 border border-white/10 rounded-lg
                     text-white placeholder-white/40 focus:outline-none focus:border-green-500/50
                     resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || session.isStreaming}
            className="px-4 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {session.isStreaming ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="text-xs text-muted mt-2 text-center">
          Press Enter to send - Uses your MAX subscription
        </p>
      </div>
    </div>
  );
}
