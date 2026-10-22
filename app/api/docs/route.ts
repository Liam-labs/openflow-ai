import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { searchDocs, getDoc, getDocsMeta, getAllTags, invalidateDocsCache } from '@/lib/docs';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

export const dynamic = 'force-dynamic';

const DOCS_DIR = appPath('.DevData', 'docs');

/**
 * GET /api/docs - Search or list documents
 * Query params:
 *   - q: search query (optional)
 *   - id: get specific doc by ID (optional)
 *   - tags: get all tags (optional, set to 'true')
 */
export const GET = tracked('/api/docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q');
    const docId = searchParams.get('id');
    const getTags = searchParams.get('tags');

    // Get all unique tags
    if (getTags === 'true') {
      const tags = await getAllTags();
      return NextResponse.json({ tags });
    }

    // Get specific document
    if (docId) {
      const doc = await getDoc(docId);
      if (!doc) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }
      return NextResponse.json({ doc });
    }

    // Search documents
    const results = await searchDocs(query || '');
    return NextResponse.json({ results });
  } catch (error) {
    console.error('Docs API error:', error);
    return NextResponse.json(
      { error: 'Failed to search documents' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/docs - Invalidate cache (for manual refresh)
 */
export const POST = tracked('/api/docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    invalidateDocsCache();
    const meta = await getDocsMeta();
    return NextResponse.json({
      success: true,
      message: 'Cache invalidated',
      count: meta.length
    });
  } catch (error) {
    console.error('Docs refresh error:', error);
    return NextResponse.json(
      { error: 'Failed to refresh documents' },
      { status: 500 }
    );
  }
});

/**
 * PUT /api/docs - Create or update a document
 */
export const PUT = tracked('/api/docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { title, category, tags, content } = body as {
      title: string;
      category: 'snippets' | 'guides';
      tags: string[];
      content: string;
    };

    // Validate inputs
    if (!title || !category || !content) {
      return NextResponse.json(
        { error: 'Missing required fields: title, category, content' },
        { status: 400 }
      );
    }

    if (!['snippets', 'guides'].includes(category)) {
      return NextResponse.json(
        { error: 'Category must be "snippets" or "guides"' },
        { status: 400 }
      );
    }

    // Generate filename from title
    const filename = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '.md';

    const categoryDir = path.join(DOCS_DIR, category);
    const filePath = path.join(categoryDir, filename);

    // Ensure category directory exists
    await fs.mkdir(categoryDir, { recursive: true });

    // Check if file already exists
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (fileExists) {
      return NextResponse.json(
        { error: `A document with this name already exists in ${category}` },
        { status: 409 }
      );
    }

    // Build frontmatter
    const today = new Date().toISOString().split('T')[0];
    const tagsString = tags.length > 0
      ? `[${tags.map(t => `"${t}"`).join(', ')}]`
      : '[]';

    const safeTitle = title.includes(':') ? `"${title}"` : title;
    const frontmatter = `---
title: ${safeTitle}
category: ${category}
tags: ${tagsString}
created: ${today}
---

`;

    // Write file
    const fullContent = frontmatter + content;
    await fs.writeFile(filePath, fullContent, 'utf-8');

    // Invalidate cache
    invalidateDocsCache();

    return NextResponse.json({
      success: true,
      id: `${category}/${filename.replace('.md', '')}`,
      path: filePath,
      message: 'Document created successfully'
    });
  } catch (error) {
    console.error('Create doc error:', error);
    return NextResponse.json(
      { error: 'Failed to create document' },
      { status: 500 }
    );
  }
});

/**
 * DELETE /api/docs - Delete a document
 */
export const DELETE = tracked('/api/docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const searchParams = request.nextUrl.searchParams;
    const docId = searchParams.get('id');

    if (!docId) {
      return NextResponse.json(
        { error: 'Document ID required' },
        { status: 400 }
      );
    }

    // Parse ID to get category and filename
    const [category, filename] = docId.split('/');
    if (!category || !filename) {
      return NextResponse.json(
        { error: 'Invalid document ID' },
        { status: 400 }
      );
    }

    const filePath = path.join(DOCS_DIR, category, `${filename}.md`);

    const docExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!docExists) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    // Delete file
    await fs.unlink(filePath);

    // Invalidate cache
    invalidateDocsCache();

    return NextResponse.json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    console.error('Delete doc error:', error);
    return NextResponse.json(
      { error: 'Failed to delete document' },
      { status: 500 }
    );
  }
});
