'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, MessageSquare, Bot, User, Terminal, X } from 'lucide-react';
import { renderMessageContent } from '@/lib/message-renderer';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DocChatProps {
  documentContent: string;
  documentTitle: string;
  onClose?: () => void;
}

export function DocChat({ documentContent, documentTitle, onClose }: DocChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting] = useState(true);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Start session when component mounts
  useEffect(() => {
    let mounted = true;

    const startSession = async () => {
      try {
        const response = await fetch('/api/docs/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'start',
            documentTitle,
            documentContent,
          }),
        });

        const data = await response.json();

        if (!mounted) return;

        if (data.success && data.sessionId) {
          setSessionId(data.sessionId);
          setError(null);
        } else {
          setError(data.error || 'Failed to start session');
        }
      } catch (err) {
        if (mounted) {
          setError('Failed to connect to Claude');
          console.error('Session start error:', err);
        }
      } finally {
        if (mounted) {
          setIsStarting(false);
        }
      }
    };

    startSession();

    // Cleanup: stop session when component unmounts
    return () => {
      mounted = false;
      if (sessionId) {
        fetch('/api/docs/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', sessionId }),
        }).catch(() => {}); // Ignore errors on cleanup
      }
    };
  }, [documentTitle, documentContent]);

  // Stop session on unmount (separate effect to capture latest sessionId)
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
        fetch('/api/docs/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', sessionId: sid }),
        }).catch(() => {});
      }
    };
  }, []);

  // Focus input when session is ready
  useEffect(() => {
    if (sessionId && !isStarting) {
      inputRef.current?.focus();
    }
  }, [sessionId, isStarting]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isStreaming || !sessionId) return;

    const userMessage: Message = { role: 'user', content: inputValue.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsStreaming(true);
    setStreamingContent('');
    setError(null);

    try {
      const response = await fetch('/api/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          sessionId,
          content: userMessage.content,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Message request failed');
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
                setStreamingContent(assistantContent);
              } else if (parsed.type === 'error') {
                throw new Error(parsed.message);
              }
            } catch {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }

      // Add completed assistant message
      if (assistantContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
      }
    } catch (err) {
      console.error('Chat error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Sorry, an error occurred. Please try again.' },
      ]);
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
    }
  }, [inputValue, isStreaming, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Show loading state while starting session
  if (isStarting) {
    return (
      <div className="flex flex-col h-full bg-black/20 rounded-lg border border-white/10">
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <Terminal className="w-4 h-4 text-accent" />
          <span className="text-sm font-medium">Claude Code Session</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="w-8 h-8 animate-spin text-accent mx-auto mb-2" />
            <p className="text-sm text-muted">Starting Claude session...</p>
            <p className="text-xs text-muted mt-1">Uses MAX subscription</p>
          </div>
        </div>
      </div>
    );
  }

  // Show error state if session failed to start
  if (!sessionId && error) {
    return (
      <div className="flex flex-col h-full bg-black/20 rounded-lg border border-white/10">
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <Terminal className="w-4 h-4 text-red-400" />
          <span className="text-sm font-medium">Session Error</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-4">
            <p className="text-red-400 mb-2">{error}</p>
            <p className="text-xs text-muted">Make sure Claude Code is installed and working</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-black/20 rounded-lg border border-white/10">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium">Claude Code</span>
          <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded">
            MAX
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Close chat"
          >
            <X className="w-4 h-4 text-muted" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-muted text-sm py-8">
            <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>Ask a question about this document</p>
            <p className="text-xs mt-1 opacity-70">
              Using Claude Code - no API credits consumed
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
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
        {isStreaming && (
          <div className="flex gap-3 justify-start">
            <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-green-400" />
            </div>
            <div className="max-w-[85%] rounded-lg px-3 py-2 bg-white/5">
              <p className="text-sm whitespace-pre-wrap break-words">
                {streamingContent || '...'}
                <span className="inline-block w-2 h-4 bg-green-400/50 animate-pulse ml-0.5" />
              </p>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && !isStreaming && (
          <div className="text-center text-red-400 text-xs py-2">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-white/10">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this document..."
            disabled={isStreaming || !sessionId}
            rows={1}
            className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-lg
                     text-white placeholder-white/40 focus:outline-none focus:border-green-500/50
                     resize-none text-sm disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming || !sessionId}
            className="p-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isStreaming ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="text-xs text-muted mt-1 text-center">
          Press Enter to send - Uses your MAX subscription
        </p>
      </div>
    </div>
  );
}
