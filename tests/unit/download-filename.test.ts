/**
 * Unit tests for download-filename sanitizer + Content-Disposition builder.
 *
 * Backstop for /api/collab/images/[id]?name= — Content-Disposition filename
 * injection is a real attack class so the sanitizer must defend against:
 *   - Header-injection control chars (CR/LF, NUL, etc.)
 *   - Path traversal (../, /, \)
 *   - Hidden-file confusion (leading dot)
 *   - Length-based DoS / filesystem-name limit overruns
 */

import { describe, it, expect } from 'vitest';
import { sanitizeDownloadFilename, buildContentDisposition } from '@/lib/download-filename';

describe('sanitizeDownloadFilename', () => {
  describe('happy path', () => {
    it('returns ordinary filenames unchanged', () => {
      expect(sanitizeDownloadFilename('report.pdf')).toBe('report.pdf');
      expect(sanitizeDownloadFilename('Q4 budget.xlsx')).toBe('Q4 budget.xlsx');
      expect(sanitizeDownloadFilename('image_01.png')).toBe('image_01.png');
    });

    it('preserves hyphens, underscores, dots, spaces', () => {
      expect(sanitizeDownloadFilename('a-b_c.d e.txt')).toBe('a-b_c.d e.txt');
    });
  });

  describe('null/empty handling', () => {
    it('returns null for non-string input', () => {
      expect(sanitizeDownloadFilename(null)).toBeNull();
      expect(sanitizeDownloadFilename(undefined)).toBeNull();
      expect(sanitizeDownloadFilename(42)).toBeNull();
      expect(sanitizeDownloadFilename({})).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(sanitizeDownloadFilename('')).toBeNull();
    });

    it('returns null when all chars get stripped', () => {
      // Only control chars
      expect(sanitizeDownloadFilename('\x00\x01\x02')).toBeNull();
    });

    it('returns null when only whitespace remains', () => {
      expect(sanitizeDownloadFilename('   ')).toBeNull();
    });
  });

  describe('path traversal — reject outright', () => {
    it('rejects ../', () => {
      expect(sanitizeDownloadFilename('../etc/passwd')).toBeNull();
      expect(sanitizeDownloadFilename('foo/../bar.txt')).toBeNull();
    });

    it('rejects forward slashes', () => {
      expect(sanitizeDownloadFilename('foo/bar.txt')).toBeNull();
      expect(sanitizeDownloadFilename('/etc/passwd')).toBeNull();
    });

    it('rejects backslashes', () => {
      expect(sanitizeDownloadFilename('foo\\bar.txt')).toBeNull();
      expect(sanitizeDownloadFilename('C:\\Windows\\system32')).toBeNull();
    });

    it('rejects double-dot anywhere', () => {
      expect(sanitizeDownloadFilename('..hidden.txt')).toBeNull();
      expect(sanitizeDownloadFilename('foo..bar.txt')).toBeNull();
    });
  });

  describe('header injection — strip control chars', () => {
    it('strips CR/LF used to inject headers', () => {
      // Classic injection: "foo.txt\r\nX-Evil: 1"
      expect(sanitizeDownloadFilename('foo.txt\r\nX-Evil: 1')).toBe('foo.txtX-Evil_ 1');
    });

    it('strips NUL byte', () => {
      expect(sanitizeDownloadFilename('foo\x00.txt')).toBe('foo.txt');
    });

    it('strips DEL byte (0x7f)', () => {
      expect(sanitizeDownloadFilename('foo\x7f.txt')).toBe('foo.txt');
    });

    it('strips other control chars', () => {
      expect(sanitizeDownloadFilename('a\x01b\x02c.txt')).toBe('abc.txt');
    });
  });

  describe('character replacement', () => {
    it('replaces unicode/disallowed chars with underscore', () => {
      expect(sanitizeDownloadFilename('résumé.pdf')).toBe('r_sum_.pdf');
    });

    it('replaces shell metachars with underscore', () => {
      expect(sanitizeDownloadFilename('file;rm$x.txt')).toBe('file_rm_x.txt');
    });

    it('replaces double-quotes with underscore (Content-Disposition delimiter)', () => {
      expect(sanitizeDownloadFilename('a"b.txt')).toBe('a_b.txt');
    });

    it('collapses consecutive underscores', () => {
      expect(sanitizeDownloadFilename('a@@@b.txt')).toBe('a_b.txt');
    });
  });

  describe('hidden-file bans', () => {
    it('strips leading dot', () => {
      expect(sanitizeDownloadFilename('.bashrc')).toBe('bashrc');
    });

    it('strips multiple leading dots', () => {
      expect(sanitizeDownloadFilename('...hidden')).toBeNull();
      // ...hidden contains '..' so traversal-reject fires first → null
    });

    it('keeps middle dots', () => {
      expect(sanitizeDownloadFilename('a.b.c.txt')).toBe('a.b.c.txt');
    });
  });

  describe('length cap', () => {
    it('truncates names over 255 bytes preserving extension', () => {
      const stem = 'a'.repeat(300);
      const result = sanitizeDownloadFilename(`${stem}.pdf`);
      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(255);
      expect(result!.endsWith('.pdf')).toBe(true);
    });

    it('truncates names without extension', () => {
      const long = 'b'.repeat(500);
      const result = sanitizeDownloadFilename(long);
      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(255);
    });

    it('keeps extension when truncating', () => {
      const result = sanitizeDownloadFilename('x'.repeat(260) + '.txt');
      expect(result).not.toBeNull();
      expect(result!.endsWith('.txt')).toBe(true);
    });

    it('treats long final segment as no extension', () => {
      // "extension" longer than 16 chars → treated as part of stem
      const result = sanitizeDownloadFilename('a'.repeat(250) + '.thisisaverylongextensionyes');
      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(255);
    });
  });

  describe('trim', () => {
    it('strips leading/trailing whitespace', () => {
      expect(sanitizeDownloadFilename('  report.pdf  ')).toBe('report.pdf');
    });

    it('strips leading/trailing underscores produced by replacement', () => {
      expect(sanitizeDownloadFilename('@report.pdf@')).toBe('report.pdf');
    });
  });
});

describe('buildContentDisposition', () => {
  it('emits attachment-only for null', () => {
    expect(buildContentDisposition(null)).toBe('attachment');
  });

  it('emits both filename= and filename*= for ASCII names', () => {
    const result = buildContentDisposition('report.pdf');
    expect(result).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('percent-encodes filename* for unicode names', () => {
    const result = buildContentDisposition('café.txt');
    expect(result).toContain(`filename*=UTF-8''caf%C3%A9.txt`);
  });

  it('escapes backslash and double-quote in legacy filename=', () => {
    // sanitizer would already strip these, but the builder must defend if a
    // caller bypasses the sanitizer and passes in a raw string.
    const result = buildContentDisposition('a"b\\c.txt');
    expect(result).toContain(`filename="a\\"b\\\\c.txt"`);
  });

  it('handles spaces correctly', () => {
    const result = buildContentDisposition('Q4 budget.xlsx');
    expect(result).toContain(`filename="Q4 budget.xlsx"`);
    expect(result).toContain(`filename*=UTF-8''Q4%20budget.xlsx`);
  });
});
