import { describe, expect, it } from 'vitest';
import {
  attachmentReferenceLabel,
  createAttachmentReference,
  removeAttachmentReference,
  resolveAttachmentReferences,
  stripAttachmentReferences,
} from '@/lib/collab-attachment-references';

describe('inline AgentChat attachment references', () => {
  it('labels images, documents, and other files clearly', () => {
    expect(attachmentReferenceLabel('image/png', 1)).toBe('Image 1');
    expect(attachmentReferenceLabel('application/pdf', 2)).toBe('Document 2');
    expect(attachmentReferenceLabel('video/mp4', 3)).toBe('File 3');
  });

  it('resolves references in place without changing the surrounding message', () => {
    const marker = createAttachmentReference('Image 1', 'upload-1');
    const content = `Use the blue from ${marker} for the footer.`;

    expect(resolveAttachmentReferences(content, [
      { clientId: 'upload-1', url: '/api/collab/images/message-1-0.png' },
    ])).toBe('Use the blue from [Image 1](/api/collab/images/message-1-0.png) for the footer.');
  });

  it('does not resolve one attachment to another attachment URL', () => {
    const content = [
      createAttachmentReference('Image 1', 'upload-1'),
      createAttachmentReference('Image 2', 'upload-2'),
    ].join(' then ');

    expect(resolveAttachmentReferences(content, [
      { clientId: 'upload-1', url: '/api/collab/images/one.png' },
      { clientId: 'upload-2', url: '/api/collab/images/two.png' },
    ])).toBe('[Image 1](/api/collab/images/one.png) then [Image 2](/api/collab/images/two.png)');
  });

  it('removes a deleted attachment marker and strips markers for validation', () => {
    const marker = createAttachmentReference('Document 1', 'upload-1');
    const content = `Review ${marker} please`;

    expect(removeAttachmentReference(content, 'upload-1')).toBe('Review please');
    expect(stripAttachmentReferences(content)).toBe('Review  please');
  });

  it('fails closed to a positional label when an upload URL is unavailable', () => {
    expect(resolveAttachmentReferences(
      createAttachmentReference('Image 1', 'upload-1'),
      [{ clientId: 'upload-1' }],
    )).toBe('Image 1');
  });
});
