#!/usr/bin/env python3
"""Real search test for the memory wizard. Run with the wizard's own Python environment:

    <venv>/bin/python scripts/memory-wizard-proof.py <qdrant url> <embedding model> <nonce>

Embeds three short memories with the chosen model, stores them in a throwaway collection, searches with a sentence that shares no
words with the right one, and prints one JSON line: {"ok": bool, "top": "<memory id>", "expected": "...", "detail": "..."}.
The throwaway collection is always deleted. Nothing is read from or written to any other collection.
"""
import json
import sys

MEMORIES = [
    ("garden", "The tomatoes in the greenhouse need watering every morning before the sun gets hot."),
    ("invoice", "Send the quarterly invoice to the accounts team by the end of the month."),
    ("hiking", "We walked along the coastal path and reached the lighthouse at sunset."),
]
QUERY = ("garden", "When should I water my vegetables?")


def main() -> int:
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "detail": "usage: memory-wizard-proof.py URL MODEL NONCE"}))
        return 2
    url, model, nonce = sys.argv[1:4]
    if not nonce.replace("-", "").isalnum():
        print(json.dumps({"ok": False, "detail": "bad nonce"}))
        return 2
    collection = f"openflow-wizard-proof-{nonce}"
    try:
        from fastembed import TextEmbedding
        from qdrant_client import QdrantClient, models
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "detail": f"Python packages missing: {type(error).__name__}"}))
        return 1
    client = QdrantClient(url=url, timeout=30)
    try:
        embedder = TextEmbedding(model_name=model)
        vectors = list(embedder.embed([text for _, text in MEMORIES]))
        client.create_collection(collection, vectors_config=models.VectorParams(size=len(vectors[0]), distance=models.Distance.COSINE))
        client.upsert(collection, points=[models.PointStruct(id=i, vector=v.tolist(), payload={"memory": name}) for i, ((name, _), v) in enumerate(zip(MEMORIES, vectors))])
        qv = next(iter(embedder.embed([QUERY[1]]))).tolist()
        hits = client.query_points(collection, query=qv, limit=3).points
        top = hits[0].payload["memory"] if hits else ""
        ok = top == QUERY[0]
        print(json.dumps({"ok": ok, "top": top, "expected": QUERY[0], "detail": "The right memory came back first." if ok else "The wrong memory came back first."}))
        return 0 if ok else 1
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "detail": f"{type(error).__name__}: {str(error)[:160]}"}))
        return 1
    finally:
        try:
            client.delete_collection(collection)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
