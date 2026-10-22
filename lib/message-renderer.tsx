'use client';

import React, { Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import type { CollabParticipant } from '@/lib/types';
import { parseTokens, getBlockType, hasBlockMarkdown, parseBlocks } from '@/lib/message-parser';
import { splitTextByPaths } from '@/lib/path-chip-injection';
import ProgressBlock from '@/components/chat-blocks/ProgressBlock';
import PathChip from '@/components/PathChip';

// Heavy deps are lazy-loaded so the chat bundle stays lean
const ChartBlock = React.lazy(() => import('@/components/chat-blocks/ChartBlock'));
const MermaidBlock = React.lazy(() => import('@/components/chat-blocks/MermaidBlock'));
const SvgBlock = React.lazy(() => import('@/components/chat-blocks/SvgBlock'));
const HtmlBlock = React.lazy(() => import('@/components/chat-blocks/HtmlBlock'));
const SandboxBlock = React.lazy(() => import('@/components/chat-blocks/SandboxBlock'));

const BlockFallback = ({ label }: { label: string }) => (
  <div className="chat-block chat-block--loading" aria-label={`${label} loading`}>
    <span className="chat-block__label">{label}</span>
  </div>
);

function isLocalBrowserHandoffUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && /^\/account-browser-handoff\/[0-9a-f-]{36}$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function openBrowserHandoffWindow(event: React.MouseEvent<HTMLAnchorElement>, href: string): void {
  if (!isLocalBrowserHandoffUrl(href)) return;
  const popup = window.open(
    href,
    'devflowSecureBrowserHandoff',
    'popup,width=1500,height=1000,resizable=yes,scrollbars=yes',
  );
  if (!popup) return; // Let the anchor's normal new-tab fallback proceed.
  popup.opener = null;
  popup.focus();
  event.preventDefault();
}

/**
 * Render a message string into React nodes.
 *
 * Two passes:
 *  - If the content has block-level markdown (headings / list items), render it
 *    structurally as <h2>/<ul>/<ol>, with each block's text run through the
 *    inline renderer below. This makes the sent message match the WYSIWYG
 *    composer (no literal "##" / "- ").
 *  - Otherwise, render inline-only exactly as before (zero behaviour change).
 *
 * Pass an empty array for `participants` when no mention-coloring is needed.
 */
export function renderMessageContent(
  content: string,
  participants: CollabParticipant[],
  channelProjectPath?: string,
): (string | React.ReactNode)[] | string {
  // Normalise Windows-style and legacy carriage returns to Unix line endings.
  // CSS white-space: pre-wrap only breaks on \n — bare \r renders as invisible
  // or, when double-escaped through JSON, as a literal backslash in the UI.
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!hasBlockMarkdown(content)) {
    return renderInlineContent(content, participants, channelProjectPath);
  }

  const blocks = parseBlocks(content);
  const out: React.ReactNode[] = [];
  blocks.forEach((b, i) => {
    switch (b.type) {
      case 'fence':
        out.push(
          <React.Fragment key={`blk-fence-${i}`}>
            {renderInlineContent(b.value, participants, channelProjectPath)}
          </React.Fragment>,
        );
        break;
      case 'heading': {
        const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3');
        out.push(
          <Tag key={`blk-h-${i}`} className={`collab-md-heading collab-md-h${b.level}`}>
            {renderInlineContent(b.text, participants, channelProjectPath)}
          </Tag>,
        );
        break;
      }
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        out.push(
          <Tag key={`blk-list-${i}`} className="collab-md-list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInlineContent(item, participants, channelProjectPath)}</li>
            ))}
          </Tag>,
        );
        break;
      }
      default:
        out.push(
          <div key={`blk-p-${i}`} className="collab-md-p">
            {renderInlineContent(b.text, participants, channelProjectPath)}
          </div>,
        );
    }
  });
  return out;
}

/**
 * Inline-only renderer: bold, italic, underline, inline-code, URLs, @mentions, paths, and
 * language-tagged code blocks that dispatch to rich block components.
 */
function renderInlineContent(
  content: string,
  participants: CollabParticipant[],
  channelProjectPath?: string,
): (string | React.ReactNode)[] | string {
  const tokens = parseTokens(content);
  if (tokens.length === 0) {
    // No formatting tokens — but still check for paths
    const segments = splitTextByPaths(content, channelProjectPath);
    if (segments.length <= 1 && segments[0]?.type === 'text') return content;
    return segments.map((seg, j) =>
      seg.type === 'path'
        ? <PathChip key={`pc-root-${j}`} path={seg.path} resolvedPath={seg.resolved} />
        : seg.value,
    );
  }

  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;

  for (const token of tokens) {
    if (token.start > lastIndex) {
      parts.push(content.slice(lastIndex, token.start));
    }

    switch (token.type) {
      case 'code-block': {
        const blockType = getBlockType(token.language ?? '');
        const inner = token.inner ?? '';

        switch (blockType) {
          case 'chart':
            parts.push(
              <Suspense key={`chart-${token.start}`} fallback={<BlockFallback label="chart" />}>
                <ChartBlock spec={inner} />
              </Suspense>,
            );
            break;
          case 'mermaid':
            parts.push(
              <Suspense key={`mmd-${token.start}`} fallback={<BlockFallback label="mermaid" />}>
                <MermaidBlock source={inner} />
              </Suspense>,
            );
            break;
          case 'svg':
            parts.push(
              <Suspense key={`svg-${token.start}`} fallback={<BlockFallback label="svg" />}>
                <SvgBlock markup={inner} />
              </Suspense>,
            );
            break;
          case 'progress':
            parts.push(<ProgressBlock key={`prog-${token.start}`} spec={inner} />);
            break;
          case 'html':
            parts.push(
              <Suspense key={`html-${token.start}`} fallback={<BlockFallback label="html" />}>
                <HtmlBlock code={inner} />
              </Suspense>,
            );
            break;
          case 'sandbox':
            parts.push(
              <Suspense key={`sandbox-${token.start}`} fallback={<BlockFallback label="sandbox" />}>
                <SandboxBlock code={inner} />
              </Suspense>,
            );
            break;
          default: {
            const lang = token.language;
            parts.push(
              <div key={`cb-${token.start}`} className="collab-code-block-wrap">
                <pre className="collab-code-block">
                  {lang && <span className="collab-code-lang">{lang}</span>}
                  {inner}
                </pre>
              </div>,
            );
          }
        }
        break;
      }

      case 'inline-code':
        parts.push(
          <code key={`ic-${token.start}`} className="collab-inline-code">
            {token.inner}
          </code>,
        );
        break;

      case 'bold':
        parts.push(
          <strong key={`b-${token.start}`} className="font-semibold">
            {token.inner}
          </strong>,
        );
        break;

      case 'italic':
        parts.push(<em key={`i-${token.start}`}>{token.inner}</em>);
        break;

      case 'underline':
        parts.push(<u key={`u-${token.start}`} className="collab-underline">{token.inner}</u>);
        break;

      case 'url': {
        let href = token.value;
        if (href.startsWith('localhost')) href = `http://${href}`;
        else if (href.startsWith('www.')) href = `https://${href}`;
        const displayUrl = token.value.length > 50 ? token.value.slice(0, 47) + '...' : token.value;
        parts.push(
          <a
            key={`url-${token.start}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="collab-link"
            title={token.value}
            onClick={(event) => openBrowserHandoffWindow(event, href)}
          >
            {displayUrl}
            <ExternalLink className="inline-block w-3 h-3 ml-1 opacity-60" />
          </a>,
        );
        break;
      }

      case 'markdown-link': {
        const label = token.linkLabel ?? token.linkTarget ?? token.value;
        const target = token.linkTarget ?? '';

        if (target.startsWith('/api/collab/images/')) {
          parts.push(
            <a
              key={`md-attachment-${token.start}`}
              href={target}
              target="_blank"
              rel="noopener noreferrer"
              className="collab-link"
              title={label}
            >
              {label}
              <ExternalLink className="inline-block w-3 h-3 ml-1 opacity-60" />
            </a>,
          );
        } else if (target.startsWith('/')) {
          parts.push(
            <PathChip key={`md-path-${token.start}`} path={target} label={label} />,
          );
        } else {
          let href = target;
          if (href.startsWith('localhost')) href = `http://${href}`;
          else if (href.startsWith('www.')) href = `https://${href}`;

          if (/^https?:\/\//i.test(href)) {
            parts.push(
              <a
                key={`md-link-${token.start}`}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="collab-link"
                title={target}
                onClick={(event) => openBrowserHandoffWindow(event, href)}
              >
                {label}
                <ExternalLink className="inline-block w-3 h-3 ml-1 opacity-60" />
              </a>,
            );
          } else {
            // Preserve unsupported schemes/relative destinations as inert text.
            // This prevents javascript: links and misleading dead anchors.
            parts.push(token.value);
          }
        }
        break;
      }

      case 'mention': {
        const matched = participants?.find(
          p => p.name.toLowerCase() === token.mentionName?.toLowerCase(),
        );
        parts.push(
          <span
            key={`mention-${token.start}`}
            className="collab-mention"
            style={
              matched
                ? { backgroundColor: `${matched.color}25`, borderColor: `${matched.color}40` }
                : undefined
            }
            title={matched ? matched.name : token.mentionName}
          >
            @{token.mentionName}
          </span>,
        );
        break;
      }
    }

    lastIndex = token.end;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  // Post-process: inject PathChip into text gaps (string parts only).
  // Code blocks, inline code, URLs, and mentions are already React nodes
  // and won't be processed — paths inside them are naturally excluded.
  const withPaths: (string | React.ReactNode)[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part !== 'string') {
      withPaths.push(part);
      continue;
    }
    const segments = splitTextByPaths(part, channelProjectPath);
    if (segments.length <= 1 && segments[0]?.type === 'text') {
      withPaths.push(part);
      continue;
    }
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j];
      withPaths.push(
        seg.type === 'path'
          ? <PathChip key={`pc-${i}-${j}`} path={seg.path} resolvedPath={seg.resolved} />
          : seg.value,
      );
    }
  }

  return withPaths;
}
