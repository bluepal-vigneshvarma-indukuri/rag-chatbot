"""Upload and ingest endpoints."""
import uuid
import asyncio
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

    document_id = str(uuid.uuid4())
    user_id = user["id"]
    storage_path = f"{user_id}/{document_id}/{file.filename}"

    settings = get_settings()

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
                  (id, user_id, filename, mime_type, file_size_bytes, storage_path, status)
                VALUES (%s, %s, %s, %s, %s, %s, 'processing')
                """,
                (document_id, user_id, file.filename, file.content_type,
                 len(content), storage_path),
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

        # Optional: generate embeddings
        embeddings = await _embed_chunks(
            chunks, settings, embed_base_url, embed_model, embed_api_key, embed_disabled,
        )

        # Insert chunks
        with conn.cursor() as cur:
            for i, chunk_text in enumerate(chunks):
                emb = embeddings[i] if embeddings else None
                cur.execute(
                    """
                    INSERT INTO public.chunks (document_id, chunk_index, text, embedding, token_count)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (document_id, chunk_index) DO NOTHING
                    """,
                    (document_id, i, chunk_text, emb, len(chunk_text.split())),
                )
            # Update document status and chunk count
            cur.execute(
                """
                UPDATE public.documents
                SET status = 'ready', chunk_count = %s, updated_at = now()
                WHERE id = %s
                """,
                (len(chunks), document_id),
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
) -> list:
    """Generate embeddings via specified API provider if configured."""
    if embed_disabled or not embed_base_url or not embed_model or not embed_api_key:
        return []

    api_key = embed_api_key
    base_url = embed_base_url
    model = embed_model

    if not api_key:
        if is_localhost(base_url):
            api_key = "not-needed"

    if not api_key:
        return []

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key, base_url=normalize_base_url(base_url))
        response = await client.embeddings.create(
            model=model,
            input=chunks,
            dimensions=768,
        )
        return [item.embedding for item in response.data]
    except Exception as e:
        print(f"Embedding generation failed: {e}")
        return []


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
