import fs from 'fs';
import path from 'path';
import { APP_CWD } from './app-paths';
import matter from 'gray-matter';
import MiniSearch from 'minisearch';
import type { Doc, DocMeta, DocSearchResult } from './types';

const DOCS_DIR = path.join(/* turbopackIgnore: true */ APP_CWD, '.DevData', 'docs');

// Cache for documents and search index
let docsCache: Doc[] | null = null;
let searchIndex: MiniSearch<Doc> | null = null;
let lastIndexTime = 0;
const CACHE_TTL = 30000; // 30 seconds

/**
 * Load all documents from the docs directory
 */
export async function loadDocs(): Promise<Doc[]> {
  const now = Date.now();
  if (docsCache && now - lastIndexTime < CACHE_TTL) {
    return docsCache;
  }

  const docs: Doc[] = [];
  const categories = ['snippets', 'guides'];

  for (const category of categories) {
    const categoryPath = path.join(DOCS_DIR, category);

    if (!fs.existsSync(categoryPath)) {
      continue;
    }

    const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(fileContent);

      const id = `${category}/${file.replace('.md', '')}`;
      const excerpt = content
        .replace(/^#.+$/gm, '') // Remove headers
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks for excerpt
        .replace(/\n+/g, ' ')
        .trim()
        .slice(0, 200);

      docs.push({
        id,
        title: data.title || file.replace('.md', ''),
        category: category as 'snippets' | 'guides',
        tags: Array.isArray(data.tags) ? data.tags : [],
        created: data.created || new Date().toISOString().split('T')[0],
        path: filePath,
        content,
        excerpt: excerpt + (excerpt.length >= 200 ? '...' : ''),
      });
    }
  }

  docsCache = docs;
  lastIndexTime = now;

  // Rebuild search index
  searchIndex = new MiniSearch<Doc>({
    fields: ['title', 'content', 'tags'],
    storeFields: ['title', 'category', 'tags', 'excerpt'],
    searchOptions: {
      boost: { title: 3, tags: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  searchIndex.addAll(docs);

  return docs;
}

/**
 * Get search index, creating it if necessary
 */
async function getSearchIndex(): Promise<MiniSearch<Doc>> {
  if (!searchIndex) {
    await loadDocs();
  }
  return searchIndex!;
}

/**
 * Search documents
 */
export async function searchDocs(query: string): Promise<DocSearchResult[]> {
  if (!query.trim()) {
    // Return all docs if no query
    const docs = await loadDocs();
    return docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      tags: doc.tags,
      excerpt: doc.excerpt,
      score: 1,
    }));
  }

  const index = await getSearchIndex();
  const results = index.search(query);

  return results.map(result => ({
    id: result.id,
    title: result.title,
    category: result.category,
    tags: result.tags || [],
    excerpt: result.excerpt,
    score: result.score,
    matches: result.match ? Object.keys(result.match) : [],
  }));
}

/**
 * Get a single document by ID
 */
export async function getDoc(id: string): Promise<Doc | null> {
  const docs = await loadDocs();
  return docs.find(d => d.id === id) || null;
}

/**
 * Get all document metadata (without content)
 */
export async function getDocsMeta(): Promise<DocMeta[]> {
  const docs = await loadDocs();
  return docs.map(({ content, ...meta }) => meta);
}

/**
 * Get all unique tags
 */
export async function getAllTags(): Promise<string[]> {
  const docs = await loadDocs();
  const tags = new Set<string>();
  docs.forEach(doc => doc.tags.forEach(tag => tags.add(tag)));
  return Array.from(tags).sort();
}

/**
 * Invalidate cache (call after adding/editing docs)
 */
export function invalidateDocsCache(): void {
  docsCache = null;
  searchIndex = null;
  lastIndexTime = 0;
}
