/**
 * Documentation Actions
 *
 * Actions for managing documentation files.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext, DocMeta, Doc } from '@/lib/types';
import { appPath, appRoot } from '@/lib/app-paths';

const DOCS_BASE = 'docs';

interface DocsIndex {
  documents: DocMeta[];
  lastUpdated: string;
}

async function loadDocsIndex(): Promise<DocsIndex> {
  try {
    const indexPath = appPath(DOCS_BASE, 'index.json');
    const content = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Try to build index from filesystem
    return await rebuildDocsIndex();
  }
}

async function saveDocsIndex(index: DocsIndex): Promise<void> {
  index.lastUpdated = new Date().toISOString();
  const indexPath = appPath(DOCS_BASE, 'index.json');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

async function rebuildDocsIndex(): Promise<DocsIndex> {
  const documents: DocMeta[] = [];

  // Scan for markdown files in docs directory
  const docsPath = appPath(DOCS_BASE);

  try {
    await fs.access(docsPath);
  } catch {
    await fs.mkdir(docsPath, { recursive: true });
  }

  async function scanDir(dir: string, category: 'snippets' | 'guides') {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(dir, entry.name);
          const content = await fs.readFile(filePath, 'utf-8');

          // Extract title from first heading or filename
          const titleMatch = content.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1] : entry.name.replace('.md', '');

          // Extract tags from frontmatter if present
          const tagsMatch = content.match(/^tags:\s*\[(.+)\]/m);
          const tags = tagsMatch
            ? tagsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''))
            : [];

          const stats = await fs.stat(filePath);

          documents.push({
            id: entry.name.replace('.md', ''),
            title,
            category,
            tags,
            created: stats.birthtime.toISOString(),
            path: path.relative(appRoot(), filePath),
          });
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await scanDir(path.join(docsPath, 'snippets'), 'snippets');
  await scanDir(path.join(docsPath, 'guides'), 'guides');

  const index: DocsIndex = {
    documents,
    lastUpdated: new Date().toISOString(),
  };

  await saveDocsIndex(index);
  return index;
}

/**
 * docs.list - List all documents
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ documents: DocMeta[]; count: number }> {
  const index = await loadDocsIndex();

  let documents = index.documents;

  // Filter by category if specified
  if (body.category && typeof body.category === 'string') {
    documents = documents.filter(d => d.category === body.category);
  }

  // Filter by tag if specified
  if (body.tag && typeof body.tag === 'string') {
    documents = documents.filter(d => d.tags.includes(body.tag as string));
  }

  return {
    documents,
    count: documents.length,
  };
}

/**
 * docs.get - Get a document by ID
 */
export async function get(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ document: Doc | null; found: boolean }> {
  const docId = body.docId;

  if (!docId || typeof docId !== 'string') {
    throw new Error('docId is required');
  }

  const index = await loadDocsIndex();
  const meta = index.documents.find(d => d.id === docId);

  if (!meta) {
    return { document: null, found: false };
  }

  try {
    const filePath = appPath(meta.path);
    const content = await fs.readFile(filePath, 'utf-8');

    // Generate excerpt (first 200 chars, stripping markdown)
    const excerpt = content
      .replace(/^#.+$/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()
      .slice(0, 200);

    const doc: Doc = {
      ...meta,
      content,
      excerpt,
    };

    return { document: doc, found: true };
  } catch {
    return { document: null, found: false };
  }
}

/**
 * docs.search - Search documents
 */
export async function search(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  results: Array<DocMeta & { score: number; excerpt: string }>;
  count: number;
}> {
  const query = body.query;

  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }

  const index = await loadDocsIndex();
  const queryLower = query.toLowerCase();
  const results: Array<DocMeta & { score: number; excerpt: string }> = [];

  for (const meta of index.documents) {
    let score = 0;
    let excerpt = '';

    // Check title match
    if (meta.title.toLowerCase().includes(queryLower)) {
      score += 10;
    }

    // Check tag match
    if (meta.tags.some(t => t.toLowerCase().includes(queryLower))) {
      score += 5;
    }

    // Check content match
    try {
      const filePath = appPath(meta.path);
      const content = await fs.readFile(filePath, 'utf-8');
      const contentLower = content.toLowerCase();

      if (contentLower.includes(queryLower)) {
        score += 3;

        // Find excerpt around first match
        const matchIndex = contentLower.indexOf(queryLower);
        const start = Math.max(0, matchIndex - 50);
        const end = Math.min(content.length, matchIndex + query.length + 100);
        excerpt = content.slice(start, end).trim();

        if (start > 0) excerpt = '...' + excerpt;
        if (end < content.length) excerpt = excerpt + '...';
      }
    } catch {
      // Skip if can't read file
    }

    if (score > 0) {
      results.push({ ...meta, score, excerpt });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return {
    results,
    count: results.length,
  };
}

/**
 * docs.create - Create a new document
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ document: DocMeta }> {
  const title = body.title;
  const category = body.category;
  const content = body.content;
  const tags = body.tags;

  if (!title || typeof title !== 'string') {
    throw new Error('title is required');
  }
  if (!category || !['snippets', 'guides'].includes(category as string)) {
    throw new Error('category must be snippets or guides');
  }
  if (!content || typeof content !== 'string') {
    throw new Error('content is required');
  }

  // Generate ID from title
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!id) {
    throw new Error('Could not generate valid ID from title');
  }

  // Build file path
  const fileName = `${id}.md`;
  const filePath = appPath(DOCS_BASE, category as string, fileName);

  // Check if already exists
  try {
    await fs.access(filePath);
    throw new Error(`Document with ID "${id}" already exists`);
  } catch (error) {
    if ((error as Error).message.includes('already exists')) {
      throw error;
    }
    // File doesn't exist, which is what we want
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Write file
  await fs.writeFile(filePath, content);

  // Update index
  const index = await loadDocsIndex();
  const newDoc: DocMeta = {
    id,
    title,
    category: category as 'snippets' | 'guides',
    tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string') : [],
    created: new Date().toISOString(),
    path: path.relative(appRoot(), filePath),
  };

  index.documents.push(newDoc);
  await saveDocsIndex(index);

  return { document: newDoc };
}

/**
 * docs.delete - Delete a document
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; docId: string }> {
  const docId = body.docId;

  if (!docId || typeof docId !== 'string') {
    throw new Error('docId is required');
  }

  const index = await loadDocsIndex();
  const docIndex = index.documents.findIndex(d => d.id === docId);

  if (docIndex === -1) {
    throw new Error(`Document not found: ${docId}`);
  }

  const doc = index.documents[docIndex];

  // Delete file
  try {
    const filePath = appPath(doc.path);
    await fs.unlink(filePath);
  } catch {
    // File might not exist
  }

  // Update index
  index.documents.splice(docIndex, 1);
  await saveDocsIndex(index);

  return { deleted: true, docId };
}
