"""Upload and ingest endpoints."""
import uuid
import asyncio
import hashlib
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
import psycopg2
import psycopg2.extras

from auth.middleware import get_current_user
from config import get_settings
from providers.openai_compat import is_localhost, normalize_base_url
from .parsers import parse_file
from .chunking import split_into_chunks

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_EXTENSIONS = {
    "pdf", "docx", "xlsx", "csv",
    "txt", "md", "html", "htm",
    "py", "js", "ts", "jsx", "tsx",
    "java", "cpp", "c", "cs", "go", "rs", "rb", "php", "css",
    "json", "yaml", "yml", "xml", "sql",
}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


def get_db():
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = False
    try:
        yield conn
    finally:
        conn.close()


@router.get("/")
async def list_documents(user: dict = Depends(get_current_user)):
    """List all documents owned by the current user."""
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, filename, mime_type, file_size_bytes, status,
                       error_message, chunk_count, created_at
                FROM public.documents
                WHERE user_id = %s
                ORDER BY created_at DESC
                """,
                (user["id"],),
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    embed_base_url: str = Form(default=""),
    embed_model: str = Form(default=""),
    embed_api_key: str = Form(default=""),
    embed_disabled: str = Form(default="false"),
    user: dict = Depends(get_current_user),
):
    """Accept a file upload, store it, and start ingest."""
    # Validate extension
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type .{ext} not supported. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    # SHA-256 duplicate detection
    content_hash = hashlib.sha256(content).hexdigest()
    user_id = user["id"]

    settings = get_settings()
    conn_check = psycopg2.connect(settings.database_url)
    try:
        with conn_check.cursor() as cur:
            cur.execute(
                """
                SELECT filename FROM public.documents
                WHERE user_id = %s AND content_hash = %s
                LIMIT 1
                """,
                (user_id, content_hash),
            )
            existing = cur.fetchone()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Duplicate file: this document has already been uploaded as '{existing[0]}'.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # If hash column doesn't exist yet, skip check gracefully
    finally:
        conn_check.close()

    document_id = str(uuid.uuid4())
    storage_path = f"{user_id}/{document_id}/{file.filename}"

    # Upload raw file to Supabase Storage
    try:
        from supabase import create_client
        sb = create_client(settings.supabase_url, settings.supabase_service_role_key)
        sb.storage.from_("uploads").upload(
            path=storage_path,
            file=content,
            file_options={"content-type": file.content_type or "application/octet-stream"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    # Insert document row
    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.documents
                  (id, user_id, filename, mime_type, file_size_bytes, storage_path, status, content_hash)
                VALUES (%s, %s, %s, %s, %s, %s, 'processing', %s)
                """,
                (document_id, user_id, file.filename, file.content_type,
                 len(content), storage_path, content_hash),
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=500, detail=f"DB insert failed: {e}")
    finally:
        conn.close()

    disabled_bool = embed_disabled.lower() in ("true", "1", "yes", "on")

    # Run ingest in background with embed settings captured now
    asyncio.create_task(
        _ingest(
            document_id, file.filename, content,
            embed_base_url, embed_model, embed_api_key, disabled_bool,
        )
    )

    return {"document_id": document_id, "status": "processing", "filename": file.filename}


async def _ingest(
    document_id: str,
    filename: str,
    content: bytes,
    embed_base_url: str,
    embed_model: str,
    embed_api_key: str,
    embed_disabled: bool,
):
    """Parse → chunk → embed (optional) → insert chunks."""
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    try:
        # Parse text
        text = parse_file(filename, content)
        if not text.strip():
            _mark_failed(conn, document_id, "No text could be extracted from file")
            return

        chunks = split_into_chunks(text)
        if not chunks:
            _mark_failed(conn, document_id, "No chunks generated from text")
            return

        # Get DB embedding dimension
        db_dimension = 1536  # default fallback
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT atttypmod 
                    FROM pg_attribute 
                    WHERE attrelid = 'public.chunks'::regclass 
                      AND attname = 'embedding';
                """)
                row = cur.fetchone()
                if row and row[0] > 0:
                    db_dimension = row[0]
        except Exception as e:
            print(f"Failed to query embedding dimension from DB: {e}")

        # Optional: generate embeddings
        embeddings, embedding_err = await _embed_chunks(
            chunks, settings, embed_base_url, embed_model, embed_api_key, embed_disabled, db_dimension
        )
        if embedding_err:
            embedding_err = f"Embedding generation failed: {embedding_err}"

        # Insert chunks
        with conn.cursor() as cur:
            for i, chunk_text in enumerate(chunks):
                emb = embeddings[i] if (embeddings and i < len(embeddings)) else None
                cur.execute(
                    """
                    INSERT INTO public.chunks (document_id, chunk_index, text, embedding, token_count)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (document_id, chunk_index) DO NOTHING
                    """,
                    (document_id, i, chunk_text, emb, len(chunk_text.split())),
                )
            # Update document status, chunk count and error message (for warning details)
            cur.execute(
                """
                UPDATE public.documents
                SET status = 'ready', chunk_count = %s, error_message = %s, updated_at = now()
                WHERE id = %s
                """,
                (len(chunks), embedding_err, document_id),
            )
        conn.commit()

    except Exception as e:
        conn.rollback()
        _mark_failed(conn, document_id, str(e))
    finally:
        conn.close()


async def _embed_chunks(
    chunks: list,
    settings,
    embed_base_url: str,
    embed_model: str,
    embed_api_key: str,
    embed_disabled: bool,
    db_dimension: int,
) -> tuple[list, str | None]:
    """Generate embeddings via specified API provider if configured. Processes chunks in batches of 50."""
    if embed_disabled or not embed_base_url or not embed_model or not embed_api_key:
        return [], None

    api_key = embed_api_key
    base_url = embed_base_url
    model = embed_model

    if not api_key:
        if is_localhost(base_url):
            api_key = "not-needed"

    if not api_key:
        return [], None

    batch_size = 50
    embeddings = []

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key, base_url=normalize_base_url(base_url))
        try:
            # Try with dimensions argument first in batches of 50
            for i in range(0, len(chunks), batch_size):
                batch = chunks[i:i + batch_size]
                response = await client.embeddings.create(
                    model=model,
                    input=batch,
                    dimensions=db_dimension,
                )
                embeddings.extend([item.embedding for item in response.data])
            return embeddings, None
        except Exception as e:
            err_msg = str(e).lower()
            if any(k in err_msg for k in ("dimension", "extra fields", "unexpected keyword argument", "parameter")):
                # Fallback: retry without dimensions argument in batches of 50
                embeddings = []
                for i in range(0, len(chunks), batch_size):
                    batch = chunks[i:i + batch_size]
                    response = await client.embeddings.create(
                        model=model,
                        input=batch,
                    )
                    embeddings.extend([item.embedding for item in response.data])
                if embeddings and len(embeddings[0]) != db_dimension:
                    raise ValueError(
                        f"Embedding model '{model}' returned vector of dimension {len(embeddings[0])}, "
                        f"but the database requires exactly {db_dimension} dimensions. Truncation is not supported by this model."
                    )
                return embeddings, None
            else:
                raise e
    except Exception as e:
        print(f"Embedding generation failed: {e}")
        return [], str(e)


@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    user: dict = Depends(get_current_user),
):
    """Delete a document, its chunks/embeddings, and the file from Supabase Storage."""
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    storage_path = None
    try:
        with conn.cursor() as cur:
            # Verify ownership and get storage path
            cur.execute(
                "SELECT storage_path FROM public.documents WHERE id = %s AND user_id = %s",
                (document_id, user["id"]),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Document not found")
            storage_path = row[0]
            # Delete chunks first (embeddings cascade)
            cur.execute("DELETE FROM public.chunks WHERE document_id = %s", (document_id,))
            # Delete document record
            cur.execute("DELETE FROM public.documents WHERE id = %s", (document_id,))
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"DB delete failed: {e}")
    finally:
        conn.close()

    # Remove file from Supabase Storage (best-effort)
    if storage_path:
        try:
            from supabase import create_client
            sb = create_client(settings.supabase_url, settings.supabase_service_role_key)
            sb.storage.from_("uploads").remove([storage_path])
        except Exception as e:
            print(f"Storage delete warning (non-fatal): {e}")

    return {"status": "deleted"}


def _mark_failed(conn, document_id: str, reason: str):
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.documents
                SET status = 'failed', error_message = %s, updated_at = now()
                WHERE id = %s
                """,
                (reason[:500], document_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
