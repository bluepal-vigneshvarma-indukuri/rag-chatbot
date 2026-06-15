"""
Grounding validator: ensures every citation is backed by retrieved text.
Fail-closed — invalid citations block the answer from being shown.
"""
import re
from typing import List


def validate_answer(answer: str, citations: List[dict], retrieved_chunks: List[dict]) -> dict:
    """
    Validate the structured answer against the retrieved corpus.

    Returns:
        {"valid": bool, "errors": list[str]}
    """
    errors = []

    if not answer or not answer.strip():
        return {"valid": False, "errors": ["Answer is empty"]}

    # Build allowlist: chunk_ids that were actually retrieved this turn
    allowed_ids = {c["chunk_id"] for c in retrieved_chunks}
    chunk_text_map = {c["chunk_id"]: c["excerpt"] for c in retrieved_chunks}

    if not citations:
        # Acceptable if no [n] markers in answer
        markers = re.findall(r"\[(\d+)\]", answer)
        if markers:
            errors.append("Answer has citation markers but no citations provided")
        return {"valid": not errors, "errors": errors}

    # Find all [n] markers used in answer
    markers_in_answer = set(re.findall(r"\[(\d+)\]", answer))
    citation_indices = {str(c.get("citation_index", "")) for c in citations}

    # Every marker in the answer must have a matching citation
    for m in markers_in_answer:
        if m not in citation_indices:
            errors.append(f"Citation marker [{m}] in answer has no matching citation entry")

    for citation in citations:
        idx = citation.get("citation_index")
        chunk_id = citation.get("chunk_id", "")
        excerpt = citation.get("excerpt", "")

        # chunk_id must be in the retrieved allowlist
        if chunk_id not in allowed_ids:
            errors.append(
                f"Citation [{idx}] references chunk_id '{chunk_id}' "
                "which was not retrieved this turn"
            )
            continue

        # Excerpt must be a verbatim substring of the retrieved chunk text
        full_text = chunk_text_map.get(chunk_id, "")
        if excerpt and excerpt.strip() not in full_text:
            # Allow minor whitespace differences
            normalized_excerpt = " ".join(excerpt.split())
            normalized_full = " ".join(full_text.split())
            if normalized_excerpt not in normalized_full:
                errors.append(
                    f"Citation [{idx}] excerpt is not a verbatim substring of the chunk text"
                )

    return {"valid": len(errors) == 0, "errors": errors}
