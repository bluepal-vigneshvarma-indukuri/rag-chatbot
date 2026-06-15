"""Split document text into overlapping chunks."""
from typing import List


CHUNK_SIZE = 800        # target characters per chunk
CHUNK_OVERLAP = 150     # overlap between consecutive chunks


def split_into_chunks(text: str) -> List[str]:
    """
    Split text into chunks of ~CHUNK_SIZE characters with overlap.
    Tries to break on paragraph/sentence boundaries first.
    """
    text = text.strip()
    if not text:
        return []

    # Split on paragraph breaks first
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

    chunks: List[str] = []
    current = ""

    for para in paragraphs:
        if not current:
            current = para
            continue

        candidate = current + "\n\n" + para
        if len(candidate) <= CHUNK_SIZE:
            current = candidate
        else:
            # Save current chunk
            if current:
                chunks.append(current)
            # If paragraph itself is too long, split by sentences
            if len(para) > CHUNK_SIZE:
                sub_chunks = _split_long_text(para)
                chunks.extend(sub_chunks[:-1])
                current = sub_chunks[-1] if sub_chunks else ""
            else:
                # Carry last CHUNK_OVERLAP chars as overlap
                overlap = current[-CHUNK_OVERLAP:] if len(current) > CHUNK_OVERLAP else current
                current = overlap + "\n\n" + para if overlap else para

    if current:
        chunks.append(current)

    return [c for c in chunks if len(c.strip()) > 20]


def _split_long_text(text: str) -> List[str]:
    """Hard-split long text into pieces of CHUNK_SIZE chars."""
    pieces = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        piece = text[start:end]
        pieces.append(piece)
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return pieces
