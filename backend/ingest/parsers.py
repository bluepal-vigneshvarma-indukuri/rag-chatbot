"""Extract plain text from uploaded files."""
import io
import chardet


def parse_file(filename: str, content: bytes) -> str:
    """Return plain text from a file given its name and raw bytes."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "txt"

    if ext == "pdf":
        return _parse_pdf(content)
    elif ext in ("docx",):
        return _parse_docx(content)
    elif ext in ("doc",):
        raise ValueError(".doc files are not supported. Please save as .docx.")
    else:
        return _parse_text(content)


def _parse_pdf(content: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages.append(text.strip())
    return "\n\n".join(p for p in pages if p)


def _parse_docx(content: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(content))
    paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def _parse_text(content: bytes) -> str:
    detected = chardet.detect(content)
    encoding = detected.get("encoding") or "utf-8"
    try:
        return content.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return content.decode("utf-8", errors="replace")
