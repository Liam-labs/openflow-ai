/**
 * Sprint 5 — Smaller MCP families bundled:
 * qdrant (§3a), snapshot (§3b), pdf-editor (§3c), canva (§3g),
 * Gmail/GCal/GDrive OAuth-only (§3h–§3j), n8n-mcp (§3k).
 */

import type { FamilyHandler, Handler, IconName, InterpretedAction } from '../types';
import { shortUrl, truncate } from '../utils';

function basenameOf(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

// ── qdrant (catalogue §3a) ──────────────────────────────────────────────

export const qdrantFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const verbs: Record<string, string> = {
    qdrant_find: 'RAG search',
    qdrant_get: 'RAG get',
    qdrant_store: 'RAG store',
  };
  const subject =
    action === 'qdrant_find'
      ? truncate(String(input.query ?? ''), 60)
      : action === 'qdrant_get'
        ? String(input.point_id ?? '')
        : truncate(String(input.content ?? ''), 40);
  return {
    icon: 'brain',
    verb: verbs[action] ?? `qdrant ${action}`,
    subject,
    detail: '',
    outcome: null,
    tone: 'neutral',
    toolName: `mcp__qdrant__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

// ── snapshot (catalogue §3b) ────────────────────────────────────────────

export const snapshotFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const url = typeof input.url === 'string' ? input.url : '';
  const verbs: Record<string, string> = {
    capture_full_page: 'Screenshot full page',
    screenshot: 'Screenshot',
    scroll_page: 'Scroll page',
    wait_for: 'Wait for',
  };
  const subject =
    action === 'capture_full_page' || (action === 'screenshot' && url)
      ? new URL(url).host
      : action === 'scroll_page'
        ? String(input.direction ?? '')
        : action === 'wait_for'
          ? String(input.selector ?? input.event ?? '')
          : '';
  return {
    icon: 'image',
    verb: verbs[action] ?? `snapshot ${action}`,
    subject,
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: `mcp__snapshot__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

// ── pdf-editor (catalogue §3c, 25 actions) ──────────────────────────────

const PDF_VERBS: Readonly<Record<string, string>> = {
  pdf_read: 'PDF read',
  pdf_info: 'PDF info',
  pdf_search: 'PDF search',
  pdf_get_form_fields: 'PDF form fields',
  pdf_extract_images: 'PDF extract images',
  pdf_replace_text: 'PDF replace text',
  pdf_add_text: 'PDF add text',
  pdf_delete_text: 'PDF delete text',
  pdf_fill_form: 'PDF fill form',
  pdf_add_image: 'PDF add image',
  pdf_add_watermark: 'PDF watermark',
  pdf_add_annotation: 'PDF annotate',
  pdf_delete_pages: 'PDF delete pages',
  pdf_insert_page: 'PDF insert page',
  pdf_reorder_pages: 'PDF reorder',
  pdf_rotate_pages: 'PDF rotate',
  pdf_crop_pages: 'PDF crop',
  pdf_merge: 'PDF merge',
  pdf_split: 'PDF split',
  pdf_to_markdown: 'PDF → Markdown',
  markdown_to_pdf: 'Markdown → PDF',
  pdf_copy: 'PDF copy',
  pdf_analyze_form: 'PDF analyze form',
  pdf_smart_fill: 'PDF smart fill',
  pdf_generate_template: 'PDF generate template',
  pdf_fill_from_template: 'PDF fill from template',
  pdf_fill_from_template_file: 'PDF fill from template file',
};

export const pdfEditorFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const path =
    typeof input.path === 'string'
      ? input.path
      : typeof input.output_path === 'string'
        ? input.output_path
        : '';
  return {
    icon: 'file-cog',
    verb: PDF_VERBS[action] ?? `PDF ${action}`,
    subject: basenameOf(path),
    detail: '',
    outcome: null,
    tone: 'mutate',
    toolName: `mcp__pdf-editor__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

// ── canva (catalogue §3g, 22 actions) ───────────────────────────────────

export const canvaFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const verb = action.replace(/-/g, ' ');
  const designId = typeof input.designId === 'string' ? input.designId : '';
  const name = typeof input.name === 'string' ? input.name : '';
  const url = typeof input.url === 'string' ? input.url : '';
  const subject = designId || name || (url ? shortUrl(url) : '');
  return {
    icon: 'cloud',
    verb: `Canva ${verb}`,
    subject,
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: `mcp__canva__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

// ── OAuth-only families (catalogue §3h–§3j) ─────────────────────────────

function oauthFamily(label: string, icon: IconName, prefix: string): FamilyHandler {
  return (action, _input, item): InterpretedAction => {
    const verbs: Record<string, string> = {
      authenticate: `${label}: authenticate`,
      complete_authentication: `${label}: complete auth`,
    };
    return {
      icon,
      verb: verbs[action] ?? `${label} ${action}`,
      subject: '',
      detail: '',
      outcome: null,
      tone: 'external',
      toolName: `${prefix}__${action}`,
      toolUseId: item.toolUseId ?? '',
    };
  };
}

export const gmailFamily = oauthFamily('Gmail', 'mail', 'mcp__claude_ai_Gmail');
export const gcalFamily = oauthFamily('Google Calendar', 'calendar', 'mcp__claude_ai_Google_Calendar');
export const gdriveFamily = oauthFamily('Google Drive', 'cloud', 'mcp__claude_ai_Google_Drive');

// ── n8n-mcp (catalogue §3k) ─────────────────────────────────────────────

export const n8nFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const id = typeof input.id === 'string' ? input.id : '';
  const name = typeof input.name === 'string' ? input.name : '';
  return {
    icon: 'settings',
    verb: `n8n ${action.replace(/_/g, ' ')}`,
    subject: name || id,
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: `mcp__n8n-mcp__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  _exact: Record<string, Handler>,
  family: Record<string, FamilyHandler>,
): void {
  family.qdrant = qdrantFamily;
  family.snapshot = snapshotFamily;
  family['pdf-editor'] = pdfEditorFamily;
  family.canva = canvaFamily;
  family.claude_ai_Gmail = gmailFamily;
  family.claude_ai_Google_Calendar = gcalFamily;
  family.claude_ai_Google_Drive = gdriveFamily;
  family['n8n-mcp'] = n8nFamily;
};
