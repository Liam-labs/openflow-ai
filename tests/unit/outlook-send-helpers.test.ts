import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Stub the underlying sendEmail() so the wrapper test never hits MCP.
const sendEmailMock = vi.fn();
vi.mock('@/lib/outlook-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outlook-client')>(
    '@/lib/outlook-client'
  );
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  };
});

import {
  inferContentType,
  buildAttachment,
  buildAttachments,
  checkCidReferences,
  sendMail,
} from '@/lib/outlook-send-helpers';
import { OutlookClientError } from '@/lib/outlook-client';

let workdir: string;
let pdfPath: string;
let pngPath: string;
let unknownPath: string;

beforeAll(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'outlook-send-test-'));
  pdfPath = join(workdir, 'q1-2026.pdf');
  pngPath = join(workdir, 'logo.png');
  unknownPath = join(workdir, 'data.bin');
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4 stub bytes', 'utf8'));
  // 1×1 transparent PNG
  await fs.writeFile(
    pngPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64'
    )
  );
  await fs.writeFile(unknownPath, Buffer.from([0x01, 0x02, 0x03]));
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('inferContentType', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['LOGO.PNG', 'image/png'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['summary.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['model.svg', 'image/svg+xml'],
    ['notes.md', 'text/markdown'],
    ['archive.zip', 'application/zip'],
    ['noext', 'application/octet-stream'],
    ['data.unknownext', 'application/octet-stream'],
  ])('infers %s → %s', (file, mime) => {
    expect(inferContentType(file)).toBe(mime);
  });
});

describe('buildAttachment', () => {
  it('reads + base64-encodes a file with inferred MIME', async () => {
    const att = await buildAttachment({ path: pdfPath });
    expect(att.name).toBe('q1-2026.pdf');
    expect(att.contentType).toBe('application/pdf');
    expect(att.contentBytes).toBe(
      Buffer.from('%PDF-1.4 stub bytes', 'utf8').toString('base64')
    );
    expect(att.isInline).toBeUndefined();
    expect(att.contentId).toBeUndefined();
  });

  it('honours custom name + contentType overrides', async () => {
    const att = await buildAttachment({
      path: unknownPath,
      name: 'payload.dat',
      contentType: 'application/x-custom',
    });
    expect(att.name).toBe('payload.dat');
    expect(att.contentType).toBe('application/x-custom');
  });

  it('produces inline + contentId when cid is set', async () => {
    const att = await buildAttachment({ path: pngPath, cid: 'logo' });
    expect(att.isInline).toBe(true);
    expect(att.contentId).toBe('logo');
    expect(att.contentType).toBe('image/png');
  });

  it('throws OutlookClientError(tool) when path is missing', async () => {
    await expect(buildAttachment({} as never)).rejects.toMatchObject({
      kind: 'tool',
      tool: 'sendMail',
    });
  });

  it('throws when inline=true but no cid is provided', async () => {
    await expect(
      buildAttachment({ path: pngPath, inline: true })
    ).rejects.toMatchObject({ kind: 'tool' });
  });

  it('throws ENOENT when file does not exist', async () => {
    await expect(
      buildAttachment({ path: join(workdir, 'missing.txt') })
    ).rejects.toBeInstanceOf(OutlookClientError);
  });
});

describe('buildAttachments', () => {
  it('builds many in parallel and preserves order', async () => {
    const out = await buildAttachments([
      { path: pdfPath },
      { path: pngPath, cid: 'logo' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('q1-2026.pdf');
    expect(out[1].name).toBe('logo.png');
    expect(out[1].contentId).toBe('logo');
  });

  it('returns [] for missing input', async () => {
    expect(await buildAttachments()).toEqual([]);
    expect(await buildAttachments([])).toEqual([]);
  });
});

describe('checkCidReferences', () => {
  it('detects missing cid (declared but not in HTML)', () => {
    const r = checkCidReferences('<p>hi</p>', [
      { path: 'a.png', cid: 'logo' },
    ]);
    expect(r.missingInHtml).toEqual(['logo']);
    expect(r.orphanedInAttachments).toEqual([]);
  });

  it('detects orphaned cid (in HTML but not declared)', () => {
    const r = checkCidReferences('<img src="cid:hero">', []);
    expect(r.missingInHtml).toEqual([]);
    expect(r.orphanedInAttachments).toEqual(['hero']);
  });

  it('passes when html cid set === attachment cid set', () => {
    const r = checkCidReferences(
      '<img src="cid:logo"><img src="cid:hero">',
      [
        { path: 'l.png', cid: 'logo' },
        { path: 'h.png', cid: 'hero' },
      ]
    );
    expect(r.missingInHtml).toEqual([]);
    expect(r.orphanedInAttachments).toEqual([]);
  });

  it('ignores non-cid attachments', () => {
    const r = checkCidReferences('<p>hi</p>', [
      { path: 'doc.pdf' },
    ]);
    expect(r.missingInHtml).toEqual([]);
    expect(r.orphanedInAttachments).toEqual([]);
  });
});

describe('sendMail', () => {
  beforeAll(() => sendEmailMock.mockReset());

  it('rejects missing subject', async () => {
    sendEmailMock.mockClear();
    await expect(
      sendMail({ to: 'user@example.com', subject: '', html: '<p>x</p>' })
    ).rejects.toMatchObject({ kind: 'tool' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rejects missing body (no html and no text)', async () => {
    await expect(
      sendMail({ to: 'user@example.com', subject: 'x' })
    ).rejects.toMatchObject({ kind: 'tool' });
  });

  it('rejects empty to[]', async () => {
    await expect(
      sendMail({ to: [], subject: 'x', html: '<p>x</p>' })
    ).rejects.toMatchObject({ kind: 'tool' });
  });

  it('rejects orphan-free but missing-cid attachment', async () => {
    sendEmailMock.mockClear();
    await expect(
      sendMail({
        to: 'user@example.com',
        subject: 'x',
        html: '<p>no cid here</p>',
        attachments: [{ path: pngPath, cid: 'logo' }],
      })
    ).rejects.toMatchObject({ kind: 'tool' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('coerces a single string recipient into to: [string]', async () => {
    sendEmailMock.mockResolvedValue({
      status: 'success',
      message: 'ok',
      subject: 's',
      recipientCount: { to: 1, cc: 0, bcc: 0 },
    });
    await sendMail({ to: 'owner@example.com', subject: 's', text: 'hi' });
    const call = sendEmailMock.mock.calls.at(-1)![0];
    expect(call.to).toEqual(['owner@example.com']);
    expect(call.bodyType).toBe('Text');
    expect(call.body).toBe('hi');
  });

  it('builds attachments from disk and passes through to sendEmail', async () => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: 'success',
      message: 'ok',
      subject: 's',
      recipientCount: { to: 1, cc: 0, bcc: 0 },
    });
    await sendMail({
      to: 'user@example.com',
      subject: 's',
      html: '<p><img src="cid:logo"></p>',
      attachments: [
        { path: pngPath, cid: 'logo' },
        { path: pdfPath },
      ],
    });
    const call = sendEmailMock.mock.calls.at(-1)![0];
    expect(call.bodyType).toBe('HTML');
    expect(call.attachments).toHaveLength(2);
    expect(call.attachments[0]).toMatchObject({
      name: 'logo.png',
      contentType: 'image/png',
      isInline: true,
      contentId: 'logo',
    });
    expect(call.attachments[1]).toMatchObject({
      name: 'q1-2026.pdf',
      contentType: 'application/pdf',
    });
    expect(call.attachments[1].isInline).toBeUndefined();
  });

  it('does not pass userId when caller omits it (preserves auto-inject)', async () => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: 'success',
      message: 'ok',
      subject: 's',
      recipientCount: { to: 1, cc: 0, bcc: 0 },
    });
    await sendMail({ to: 'user@example.com', subject: 's', html: '<p>x</p>' });
    const call = sendEmailMock.mock.calls.at(-1)![0];
    expect('userId' in call).toBe(false);
  });

  it('forwards explicit userId override', async () => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: 'success',
      message: 'ok',
      subject: 's',
      recipientCount: { to: 1, cc: 0, bcc: 0 },
    });
    await sendMail({
      to: 'user@example.com',
      subject: 's',
      html: '<p>x</p>',
      userId: 'override-user',
    });
    const call = sendEmailMock.mock.calls.at(-1)![0];
    expect(call.userId).toBe('override-user');
  });

  it('forwards importance + cc/bcc + saveToSentItems', async () => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: 'success',
      message: 'ok',
      subject: 's',
      recipientCount: { to: 1, cc: 1, bcc: 1 },
    });
    await sendMail({
      to: 'user@example.com',
      cc: 'user@example.com',
      bcc: ['user@example.com'],
      subject: 's',
      html: '<p>x</p>',
      importance: 'high',
      saveToSentItems: false,
    });
    const call = sendEmailMock.mock.calls.at(-1)![0];
    expect(call.importance).toBe('high');
    expect(call.cc).toEqual(['user@example.com']);
    expect(call.bcc).toEqual(['user@example.com']);
    expect(call.saveToSentItems).toBe(false);
  });
});
