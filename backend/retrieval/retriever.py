"""
Hybrid retrieval: FTS + vector search, fused with Reciprocal Rank Fusion (RRF).
"""
from typing import List, Optional
import psycopg2
import psycopg2.extras

RRF_K = 60
MAX_RESULTS = 12
NEIGHBOR_RADIUS = 1        # chunks before/after to add as context
EXCERPT_MAX_CHARS = 800    # max chars per passage shown to agent


def hybrid_search(
    query: str,
    user_id: str,
    document_ids: Optional[List[str]] = None,
    top_k: int = MAX_RESULTS,
    query_embedding: Optional[List[float]] = None,
    db_url: str = "",
) -> List[dict]:
    """
    Run hybrid (FTS + optional vector) search and return fused, hydrated chunks.
    """
    conn = psycopg2.connect(db_url)
    try:
        fts_results = _fts_search(conn, query, user_id, document_ids, top_k * 2)
        vector_results = []
        if query_embedding:
            vector_results = _vector_search(
                conn, query_embedding, user_id, document_ids, top_k * 2
            )

        fused = _rrf_fuse(fts_results, vector_results, top_k)
        hydrated = _hydrate_with_neighbors(conn, fused, NEIGHBOR_RADIUS)
        return hydrated
    finally:
        conn.close()


def _fts_search(conn, query: str, user_id: str, document_ids, limit: int) -> List[dict]:
    doc_filter = ""
    params: list = [user_id, query, query, limit]

    if document_ids:
        placeholders = ",".join(["%s"] * len(document_ids))
        doc_filter = f"AND d.id IN ({placeholders})"
        params = [user_id] + document_ids + [query, query, limit]

    sql = f"""
        SELECT
            c.id,
            c.document_id,
            c.chunk_index,
            c.text,
            ts_rank_cd(c.search_vector, plainto_tsquery('english', %s)) AS score
        FROM public.chunks c
        JOIN public.documents d ON d.id = c.document_id
        WHERE d.user_id = %s
          {doc_filter}
          AND c.search_vector @@ plainto_tsquery('english', %s)
        ORDER BY score DESC
        LIMIT %s
    """
    # Rebuild params in the right order for the query
    if document_ids:
        placeholders = ",".join(["%s"] * len(document_ids))
        sql = f"""
            SELECT
                c.id,
                c.document_id,
                c.chunk_index,
                c.text,
                ts_rank_cd(c.search_vector, plainto_tsquery('english', %s)) AS score
            FROM public.chunks c
            JOIN public.documents d ON d.id = c.document_id
            WHERE d.user_id = %s
              AND d.id IN ({placeholders})
              AND c.search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """
        params = [query, user_id] + document_ids + [query, limit]
    else:
        sql = """
            SELECT
                c.id,
                c.document_id,
                c.chunk_index,
                c.text,
                ts_rank_cd(c.search_vector, plainto_tsquery('english', %s)) AS score
            FROM public.chunks c
            JOIN public.documents d ON d.id = c.document_id
            WHERE d.user_id = %s
              AND c.search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """
        params = [query, user_id, query, limit]

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def _vector_search(conn, embedding: List[float], user_id: str, document_ids, limit: int) -> List[dict]:
    vec_str = "[" + ",".join(str(v) for v in embedding) + "]"

    if document_ids:
        placeholders = ",".join(["%s"] * len(document_ids))
        sql = f"""
            SELECT c.id, c.document_id, c.chunk_index, c.text,
                   (1 - (c.embedding <=> %s::vector)) AS score
            FROM public.chunks c
            JOIN public.documents d ON d.id = c.document_id
            WHERE d.user_id = %s
              AND d.id IN ({placeholders})
              AND c.embedding IS NOT NULL
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """
        params = [vec_str, user_id] + document_ids + [vec_str, limit]
    else:
        sql = """
            SELECT c.id, c.document_id, c.chunk_index, c.text,
                   (1 - (c.embedding <=> %s::vector)) AS score
            FROM public.chunks c
            JOIN public.documents d ON d.id = c.document_id
            WHERE d.user_id = %s
              AND c.embedding IS NOT NULL
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """
        params = [vec_str, user_id, vec_str, limit]

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        return []


def _rrf_fuse(fts: List[dict], vector: List[dict], top_k: int) -> List[dict]:
    """Merge FTS and vector ranked lists using RRF."""
    scores: dict = {}

    for rank, item in enumerate(fts):
        cid = str(item["id"])
        scores.setdefault(cid, {"item": item, "score": 0.0})
        scores[cid]["score"] += 1.0 / (RRF_K + rank + 1)

    for rank, item in enumerate(vector):
        cid = str(item["id"])
        scores.setdefault(cid, {"item": item, "score": 0.0})
        scores[cid]["score"] += 1.0 / (RRF_K + rank + 1)

    ranked = sorted(scores.values(), key=lambda x: x["score"], reverse=True)
    return [entry["item"] for entry in ranked[:top_k]]


def _hydrate_with_neighbors(conn, chunks: List[dict], radius: int) -> List[dict]:
    """Add neighboring chunks and document filename to each result."""
    if not chunks:
        return []

    # Group by document_id
    by_doc: dict = {}
    for c in chunks:
        did = str(c["document_id"])
        by_doc.setdefault(did, [])
        by_doc[did].append(c["chunk_index"])

    # Fetch filenames
    doc_ids = list(by_doc.keys())
    filenames: dict = {}
    placeholders = ",".join(["%s"] * len(doc_ids))
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            f"SELECT id, filename FROM public.documents WHERE id IN ({placeholders})",
            doc_ids,
        )
        for row in cur.fetchall():
            filenames[str(row["id"])] = row["filename"]

    # Fetch neighbor chunks
    result = []
    seen_ids = {str(c["id"]) for c in chunks}

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for c in chunks:
            did = str(c["document_id"])
            ci = c["chunk_index"]
            neighbors = []

            if radius > 0:
                min_idx = max(0, ci - radius)
                max_idx = ci + radius
                cur.execute(
                    """
                    SELECT id, chunk_index, text FROM public.chunks
                    WHERE document_id = %s
                      AND chunk_index BETWEEN %s AND %s
                      AND chunk_index != %s
                    ORDER BY chunk_index
                    """,
                    (did, min_idx, max_idx, ci),
                )
                neighbors = [dict(r) for r in cur.fetchall()]

            passage = c["text"]
            for nb in neighbors:
                if str(nb["id"]) not in seen_ids:
                    if nb["chunk_index"] < ci:
                        passage = nb["text"] + "\n\n" + passage
                    else:
                        passage = passage + "\n\n" + nb["text"]
                    seen_ids.add(str(nb["id"]))

            result.append({
                "chunk_id": str(c["id"]),
                "document_id": did,
                "filename": filenames.get(did, "unknown"),
                "chunk_index": ci,
                "excerpt": passage[:EXCERPT_MAX_CHARS],
            })

    return result


def get_chunks_by_ids(chunk_ids: List[str], db_url: str) -> List[dict]:
    """Fetch full text for specific chunk IDs."""
    if not chunk_ids:
        return []
    conn = psycopg2.connect(db_url)
    try:
        placeholders = ",".join(["%s"] * len(chunk_ids))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT c.id, c.document_id, c.chunk_index, c.text,
                       d.filename
                FROM public.chunks c
                JOIN public.documents d ON d.id = c.document_id
                WHERE c.id IN ({placeholders})
                """,
                chunk_ids,
            )
            return [
                {
                    "chunk_id": str(r["id"]),
                    "document_id": str(r["document_id"]),
                    "filename": r["filename"],
                    "chunk_index": r["chunk_index"],
                    "excerpt": r["text"][:EXCERPT_MAX_CHARS],
                }
                for r in cur.fetchall()
            ]
    finally:
        conn.close()
