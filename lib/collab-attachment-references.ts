/**
 * Inline attachment references used by the AgentChat composer.
 *
 * The browser does not know the durable attachment URL until the message is
 * stored, so drafts carry a short-lived `attachment:` target. The message
 * handler replaces it with the saved `/api/collab/images/...` URL before the
 * message is persisted or delivered to an agent.
 */

const ATTACHMENT_REFERENCE_RE = /\[([^\]\n]+)\]\(attachment:([A-Za-z0-9_-]+)\)/g;

export interface AttachmentReference {
  clientId?: string;
  url?: string;
}

export function attachmentReferenceLabel(mimeType: string, ordinal: number): string {
  if (mimeType.startsWith('image/')) return `Image ${ordinal}`;
  if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.startsWith('text/')) {
    return `Document ${ordinal}`;
  }
  return `File ${ordinal}`;
}

export function createAttachmentReference(label: string, clientId: string): string {
  return `[${label}](attachment:${clientId})`;
}

export function resolveAttachmentReferences(
  content: string,
  attachments: AttachmentReference[],
): string {
  const urls = new Map(
    attachments
      .filter((attachment): attachment is Required<AttachmentReference> =>
        Boolean(attachment.clientId && attachment.url),
      )
      .map(attachment => [attachment.clientId, attachment.url]),
  );

  return content.replace(ATTACHMENT_REFERENCE_RE, (_match, label: string, clientId: string) => {
    const url = urls.get(clientId);
    // A rejected/failed upload must not leave an inert internal scheme in the
    // canonical message. Keep the positional label, but remove the dead target.
    return url ? `[${label}](${url})` : label;
  });
}

export function removeAttachmentReference(content: string, clientId: string): string {
  const escapedId = clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = new RegExp(`\\[([^\\]\\n]+)\\]\\(attachment:${escapedId}\\)`);
  return content
    .replace(target, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
}

export function stripAttachmentReferences(content: string): string {
  return content.replace(ATTACHMENT_REFERENCE_RE, '');
}
