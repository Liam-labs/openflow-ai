/**
 * Claude Code Session Manager
 * Spawns real Claude Code CLI processes that use the MAX subscription.
 * Uses child_process.spawn with stdin for prompts and stream-json for output.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import type { CollabMessage, CollabParticipant, CollabChannel } from './types';
import { buildAgentPrimer, generateAgentName, generateAgentColor } from './collab-utils';

// Temp directory for images
const TEMP_IMAGE_DIR = join(tmpdir(), 'devflow-chat-images');

// Ensure temp directory exists
try {
  if (!existsSync(TEMP_IMAGE_DIR)) {
    mkdirSync(TEMP_IMAGE_DIR, { recursive: true });
  }
} catch {
  // Ignore errors
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeSession {
  id: string;
  documentTitle: string;
  documentContent: string;
  messages: ChatMessage[];
  createdAt: Date;
  lastActivity: Date;
}

// Store active sessions in memory
const sessions = new Map<string, ClaudeSession>();

// Session timeout (cleanup after 30 minutes of inactivity)
const SESSION_TIMEOUT = 30 * 60 * 1000;

// Caps
const MAX_MESSAGES_PER_SESSION = 100;
const MAX_CONCURRENT_SESSIONS = 50;

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `doc-chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a new chat session for a document
 */
export function createSession(documentTitle: string, documentContent: string): ClaudeSession {
  // Enforce session count cap — evict oldest by lastActivity
  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    let oldestId: string | undefined;
    let oldestTime = Infinity;
    for (const [id, s] of sessions) {
      const t = s.lastActivity.getTime();
      if (t < oldestTime) { oldestTime = t; oldestId = id; }
    }
    if (oldestId) sessions.delete(oldestId);
  }

  const session: ClaudeSession = {
    id: generateSessionId(),
    documentTitle,
    documentContent,
    messages: [],
    createdAt: new Date(),
    lastActivity: new Date(),
  };

  sessions.set(session.id, session);
  return session;
}

/**
 * Get an existing session by ID
 */
export function getSession(sessionId: string): ClaudeSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/**
 * Build the prompt with document context and conversation history
 */
function buildPrompt(session: ClaudeSession, userMessage: string): string {
  // Truncate document if too large (keep under 30k chars for context)
  const maxDocLength = 30000;
  let docContent = session.documentContent;
  let truncated = false;
  if (docContent.length > maxDocLength) {
    docContent = docContent.slice(0, maxDocLength);
    truncated = true;
  }

  // Build conversation history (last 10 messages for context)
  const recentMessages = session.messages.slice(-10);
  const historyParts: string[] = [];
  for (const msg of recentMessages) {
    if (msg.role === 'user') {
      historyParts.push(`Human: ${msg.content}`);
    } else {
      historyParts.push(`Assistant: ${msg.content}`);
    }
  }

  const history = historyParts.length > 0
    ? `\nConversation so far:\n${historyParts.join('\n')}\n`
    : '';

  return `You are discussing a document titled "${session.documentTitle}".

Document content:
${docContent}
${truncated ? '[...truncated...]' : ''}
${history}
Human: ${userMessage}

Respond helpfully and concisely.`;
}

/**
 * Save base64 image data to a temp file
 * Returns the file path
 */
function saveImageToTemp(imageData: string): string | null {
  try {
    // Parse data URL: data:image/png;base64,xxxxx
    const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return null;

    const [, extension, base64Data] = matches;
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `chat-image-${Date.now()}.${extension}`;
    const filepath = join(TEMP_IMAGE_DIR, filename);

    writeFileSync(filepath, buffer);
    return filepath;
  } catch (err) {
    console.error('Failed to save image:', err);
    return null;
  }
}

/**
 * Clean up temp image file
 */
function cleanupTempImage(filepath: string): void {
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Send a message to Claude and stream the response
 * Returns an EventEmitter that emits 'data', 'end', and 'error' events
 */
export function sendMessage(
  sessionId: string,
  userMessage: string,
  imageData?: string
): EventEmitter {
  const emitter = new EventEmitter();

  const session = sessions.get(sessionId);
  if (!session) {
    process.nextTick(() => {
      emitter.emit('error', new Error('Session not found'));
    });
    return emitter;
  }

  // Update activity timestamp
  session.lastActivity = new Date();

  // Handle image if provided
  let imagePath: string | null = null;
  if (imageData) {
    imagePath = saveImageToTemp(imageData);
  }

  // Add user message to history (include note about image); trim oldest if over cap
  const historyMessage = imagePath ? `${userMessage} [with image]` : userMessage;
  session.messages.push({ role: 'user', content: historyMessage });
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
  }

  // Build the full prompt
  let prompt = buildPrompt(session, userMessage);

  // If image was saved, include it in the prompt for Claude
  // Claude CLI can analyze images when given the path
  if (imagePath) {
    prompt = `${prompt}\n\n[The user has attached an image located at: ${imagePath}. Please analyze this image and respond to their question about it.]`;
  }

  // Build CLI arguments
  const cliArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ];

  // Add image file as an argument if present
  // Claude Code can read images passed as file arguments
  if (imagePath) {
    cliArgs.push(imagePath);
  }

  // Spawn Claude CLI with print mode and stream-json output
  // Note: --verbose is required when using stream-json with -p
  const claude = spawn('claude', cliArgs, {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  // Write prompt to stdin and close it
  claude.stdin.write(prompt);
  claude.stdin.end();

  let fullResponse = '';
  let hasError = false;
  let buffer = '';

  // Stream stdout - parse stream-json format
  claude.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Handle different event types
        if (event.type === 'assistant' && event.message?.content) {
          // Extract text from content blocks
          for (const block of event.message.content) {
            if (block.type === 'text') {
              const text = block.text || '';
              fullResponse += text;
              emitter.emit('data', text);
            }
          }
        } else if (event.type === 'content_block_delta' && event.delta?.text) {
          // Handle streaming deltas
          fullResponse += event.delta.text;
          emitter.emit('data', event.delta.text);
        } else if (event.type === 'result' && event.result) {
          // Final result
          if (!fullResponse && event.result) {
            fullResponse = event.result;
            emitter.emit('data', event.result);
          }
        }
      } catch {
        // If it's not JSON, it might be raw text output
        if (line.trim()) {
          fullResponse += line;
          emitter.emit('data', line);
        }
      }
    }
  });

  // Capture stderr for errors
  claude.stderr.on('data', (data: Buffer) => {
    const errorText = data.toString();
    console.error('Claude stderr:', errorText);
    // Only treat as error if it looks like an actual error
    if (errorText.toLowerCase().includes('error') || errorText.includes('Error')) {
      hasError = true;
      emitter.emit('error', new Error(errorText));
    }
  });

  // Handle process completion
  claude.on('close', (code: number | null) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'result' && event.result) {
          fullResponse = event.result;
        }
      } catch {
        // Raw text
        fullResponse += buffer;
      }
      emitter.emit('data', buffer);
    }

    // Clean up temp image file if one was created
    if (imagePath) {
      cleanupTempImage(imagePath);
    }

    if (code === 0 || fullResponse) {
      // Add assistant response to history; trim oldest if over cap
      if (fullResponse.trim()) {
        session.messages.push({ role: 'assistant', content: fullResponse.trim() });
        if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
          session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
        }
      }
      emitter.emit('end', fullResponse.trim());
    } else if (!hasError) {
      emitter.emit('error', new Error(`Claude exited with code ${code}`));
    }
  });

  claude.on('error', (err: Error) => {
    // Clean up temp image on error too
    if (imagePath) {
      cleanupTempImage(imagePath);
    }
    emitter.emit('error', err);
  });

  return emitter;
}

/**
 * Clean up old sessions (call periodically)
 */
export function cleanupSessions(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessions) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT) {
      sessions.delete(id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Get session count (for monitoring)
 */
export function getSessionCount(): number {
  return sessions.size;
}

// Run cleanup every 5 minutes (handle stored so it can be cancelled if needed)
export const cleanupInterval: ReturnType<typeof setInterval> = setInterval(cleanupSessions, 5 * 60 * 1000);
// Allow Node.js to exit even if this interval is still pending
if (cleanupInterval.unref) cleanupInterval.unref();

// ============================================
// Collaboration Agent Spawning
// ============================================

// Re-export utilities for use by API routes
export { generateAgentName, generateAgentColor } from './collab-utils';

export interface SpawnCollabAgentOptions {
  channelName: string;
  triggerMessage?: string;
  conversationHistory: CollabMessage[];
  participants: CollabParticipant[];
  agentName?: string;  // If not provided, will be auto-generated
}

export interface SpawnCollabAgentResult {
  emitter: EventEmitter;
  agentName: string;
  agentColor: string;
}

/**
 * Spawn a Claude agent to respond in a collaboration channel
 *
 * Uses Claude CLI with MAX subscription for responses.
 * Returns an EventEmitter that emits 'data', 'end', and 'error' events,
 * along with the assigned agent name and color.
 */
export function spawnCollabAgent(options: SpawnCollabAgentOptions): SpawnCollabAgentResult {
  const {
    channelName,
    triggerMessage,
    conversationHistory,
    participants,
  } = options;

  // Generate or use provided agent name
  const agentName = options.agentName || generateAgentName();
  const agentColor = generateAgentColor(agentName);

  const emitter = new EventEmitter();

  // Build the primer with full context
  const prompt = buildAgentPrimer(
    agentName,
    channelName,
    conversationHistory,
    participants,
    triggerMessage
  );

  // Use Claude CLI with MAX subscription (more reliable than API credits)
  const cliArgs = [
    '-p',  // Print mode - single response, no interactive
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ];

  // Spawn Claude CLI process
  const claude = spawn('claude', cliArgs, {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  // Write prompt to stdin and close it
  claude.stdin.write(prompt);
  claude.stdin.end();

  let fullResponse = '';
  let hasError = false;
  let buffer = '';

  // Stream stdout - parse stream-json format
  claude.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Handle different event types
        if (event.type === 'assistant' && event.message?.content) {
          // Extract text from content blocks
          for (const block of event.message.content) {
            if (block.type === 'text') {
              const text = block.text || '';
              fullResponse += text;
              emitter.emit('data', text);
            }
          }
        } else if (event.type === 'content_block_delta' && event.delta?.text) {
          // Handle streaming deltas
          fullResponse += event.delta.text;
          emitter.emit('data', event.delta.text);
        } else if (event.type === 'result' && event.result) {
          // Final result
          if (!fullResponse && event.result) {
            fullResponse = event.result;
            emitter.emit('data', event.result);
          }
        }
      } catch {
        // If it's not JSON, it might be raw text output
        if (line.trim()) {
          fullResponse += line;
          emitter.emit('data', line);
        }
      }
    }
  });

  // Capture stderr for errors
  claude.stderr.on('data', (data: Buffer) => {
    const errorText = data.toString();
    console.error('Claude CLI stderr:', errorText);
    // Only treat as error if it looks like an actual error
    if (errorText.toLowerCase().includes('error') || errorText.includes('Error')) {
      hasError = true;
      emitter.emit('error', new Error(errorText));
    }
  });

  // Handle process completion
  claude.on('close', (code: number | null) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'result' && event.result) {
          fullResponse = event.result;
        }
      } catch {
        // Raw text
        fullResponse += buffer;
      }
      emitter.emit('data', buffer);
    }

    if (code === 0 || fullResponse) {
      emitter.emit('end', fullResponse.trim());
    } else if (!hasError) {
      emitter.emit('error', new Error(`Claude CLI exited with code ${code}`));
    }
  });

  claude.on('error', (err: Error) => {
    console.error('Claude CLI spawn error:', err);
    emitter.emit('error', err);
  });

  return { emitter, agentName, agentColor };
}

/**
 * Check if Anthropic API key is available
 */
export function hasAnthropicApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Spawn a Claude agent using the Anthropic API directly
 *
 * This uses API credits instead of MAX subscription, but works reliably
 * for programmatic agent spawning.
 */
export function spawnCollabAgentAPI(options: SpawnCollabAgentOptions): SpawnCollabAgentResult {
  const {
    channelName,
    triggerMessage,
    conversationHistory,
    participants,
  } = options;

  // Generate or use provided agent name
  const agentName = options.agentName || generateAgentName();
  const agentColor = generateAgentColor(agentName);

  const emitter = new EventEmitter();

  // Build the primer with full context
  const systemPrompt = buildAgentPrimer(
    agentName,
    channelName,
    conversationHistory,
    participants,
    triggerMessage
  );

  // Run API call asynchronously
  (async () => {
    try {
      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });

      // Use streaming for real-time responses
      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: triggerMessage || 'Please respond to the conversation.',
          },
        ],
      });

      let fullResponse = '';

      // Handle streaming chunks
      stream.on('text', (text) => {
        fullResponse += text;
        emitter.emit('data', text);
      });

      stream.on('error', (error) => {
        console.error('Anthropic API stream error:', error);
        emitter.emit('error', error);
      });

      stream.on('end', () => {
        emitter.emit('end', fullResponse.trim());
      });

      // Wait for completion
      await stream.finalMessage();

    } catch (error) {
      console.error('Anthropic API error:', error);
      emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return { emitter, agentName, agentColor };
}

/**
 * Smart agent spawner - uses API if available, falls back to CLI
 */
export function spawnCollabAgentSmart(options: SpawnCollabAgentOptions): SpawnCollabAgentResult {
  if (hasAnthropicApiKey()) {
    console.log('[Collab] Using Anthropic API for agent response');
    return spawnCollabAgentAPI(options);
  } else {
    console.log('[Collab] Using Claude CLI for agent response (no API key)');
    return spawnCollabAgent(options);
  }
}
