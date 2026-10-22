'use client';

import React, { useMemo } from 'react';
import { sanitizeHtml } from '@/lib/html-sanitizer';

interface HtmlBlockProps {
  code: string;
}

const HTML_SIZE_CAP = 50_000; // 50KB

export default function HtmlBlock({ code }: HtmlBlockProps) {
  const sanitized = useMemo(() => {
    if (code.length > HTML_SIZE_CAP) return null;
    return sanitizeHtml(code);
  }, [code]);

  if (code.length > HTML_SIZE_CAP) {
    return (
      <div className="text-red-500 text-sm p-2" role="alert">
        HTML content exceeds 50KB limit.
      </div>
    );
  }

  if (!sanitized) {
    return (
      <div className="text-gray-500 text-sm p-2" role="alert">
        Empty HTML content.
      </div>
    );
  }

  return (
    <div className="collab-html-block my-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4 overflow-x-auto">
      <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    </div>
  );
}
