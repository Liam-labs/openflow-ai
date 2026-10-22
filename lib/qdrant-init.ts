/**
 * Qdrant Collection Initializer
 *
 * Ensures the agent-memory collection exists on DevFlow startup.
 * Uses Qdrant's REST API directly — no JS client dependency.
 * Works for both native (PM2) and Docker Compose installs.
 *
 * Collection schema matches the RAG ingest pipeline (rag-stack/ingest.py):
 *   - dense: BGE-M3, 1024 dimensions, cosine distance
 *   - sparse: miniCOIL with IDF modifier
 *   - colbert: ColBERTv2, 128 dimensions, MAX_SIM, HNSW disabled (reranking only)
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'agent-memory';
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

interface QdrantCollectionInfo {
  result: { status: string };
}

interface QdrantCollectionsResponse {
  result: { collections: Array<{ name: string }> };
}

/**
 * Ensure the agent-memory collection exists in Qdrant.
 * Retries on connection failure (Qdrant may still be starting).
 */
export async function ensureQdrantCollection(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Check if Qdrant is reachable
      const healthRes = await fetch(`${QDRANT_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (!healthRes.ok) {
        throw new Error(`Qdrant health check failed: ${healthRes.status}`);
      }

      // List collections
      const collectionsRes = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(5000) });
      if (!collectionsRes.ok) {
        throw new Error(`Failed to list collections: ${collectionsRes.status}`);
      }

      const collectionsData = await collectionsRes.json() as QdrantCollectionsResponse;
      const exists = collectionsData.result.collections.some(c => c.name === COLLECTION_NAME);

      if (exists) {
        // Verify collection is healthy
        const infoRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, { signal: AbortSignal.timeout(5000) });
        if (infoRes.ok) {
          const info = await infoRes.json() as QdrantCollectionInfo;
          console.log(`[Qdrant] Collection '${COLLECTION_NAME}' exists (status: ${info.result.status})`);
          return;
        }
      }

      // Create collection with hybrid schema (dense + sparse + colbert)
      console.log(`[Qdrant] Creating collection '${COLLECTION_NAME}' (hybrid: dense + sparse + colbert)...`);

      const createRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          vectors: {
            dense: {
              size: 1024,
              distance: 'Cosine',
            },
            colbert: {
              size: 128,
              distance: 'Cosine',
              multivector_config: {
                comparator: 'max_sim',
              },
              hnsw_config: {
                m: 0,  // Disable HNSW index — ColBERT only used for reranking
              },
            },
          },
          sparse_vectors: {
            sparse: {
              modifier: 'idf',
            },
          },
          quantization_config: {
            scalar: {
              type: 'int8',
              quantile: 0.99,
              always_ram: true,
            },
          },
        }),
      });

      if (!createRes.ok) {
        const errBody = await createRes.text();
        throw new Error(`Failed to create collection: ${createRes.status} — ${errBody}`);
      }

      console.log(`[Qdrant] Collection '${COLLECTION_NAME}' created successfully`);
      return;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt < MAX_RETRIES) {
        console.log(`[Qdrant] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${msg}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.log(`[Qdrant] Could not connect after ${MAX_RETRIES} attempts: ${msg}. RAG memory will be unavailable until Qdrant is reachable.`);
      }
    }
  }
}
