"""
Parse reMarkable .metadata and .content files to resolve UUIDs to human-readable names
and reconstruct the folder hierarchy from the flat xochitl structure.

The xochitl filesystem stores documents as flat UUID directories with companion files:
  - {uuid}.metadata  -- JSON with visibleName, parent UUID, type, etc.
  - {uuid}.content   -- JSON with page UUIDs, file format, etc.
  - {uuid}/          -- Directory containing per-page .rm files
  - {uuid}.pdf       -- Source PDF (if document is a PDF)

This module reads those files and builds a tree structure.
"""

import json
import os
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class DocumentMetadata:
    """Parsed content of a .metadata file."""

    uuid: str
    visible_name: str
    parent_uuid: str  # Empty string means root level
    doc_type: str  # "DocumentType" in metadata: "pdf", "epub", or "" for notebooks
    last_modified: int  # Epoch milliseconds
    deleted: bool
    pinned: bool
    version: int


@dataclass
class PageTag:
    """A tag assigned to a specific page."""
    name: str
    page_id: str


@dataclass
class DocumentContent:
    """Parsed content of a .content file."""

    uuid: str
    file_type: str  # "pdf", "epub", "notebook", or ""
    page_count: int
    page_uuids: list[str] = field(default_factory=list)
    orientation: str = "portrait"
    # v6 .rm format uses cPages structure
    c_pages: Optional[dict] = None
    # Mapping from page array index to original PDF page index (0-based).
    page_redir: Optional[dict[int, int]] = None
    # Document-level tags
    tags: list[str] = field(default_factory=list)
    # Page-level tags: maps page UUID to list of tag names
    page_tags: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class ReMarkableDocument:
    """A fully resolved document with metadata, content info, and path."""

    uuid: str
    visible_name: str
    parent_uuid: str
    doc_type: str
    last_modified: int
    page_count: int
    page_uuids: list[str]
    has_pdf: bool
    folder_path: str  # Reconstructed path like "Papers/Machine Learning"
    tags: list[str] = field(default_factory=list)
    page_tags: dict[str, list[str]] = field(default_factory=dict)


def parse_metadata_file(filepath: str) -> Optional[DocumentMetadata]:
    """
    Parse a .metadata JSON file.

    Returns None if the file cannot be read or is malformed.
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        return DocumentMetadata(
            uuid=os.path.splitext(os.path.basename(filepath))[0],
            visible_name=data.get("visibleName", "Untitled"),
            parent_uuid=data.get("parent", ""),
            doc_type=data.get("type", "DocumentType"),
            last_modified=int(data.get("lastModified", "0")),
            deleted=data.get("deleted", False),
            pinned=data.get("pinned", False),
            version=data.get("version", 0),
        )
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def parse_content_file(filepath: str) -> Optional[DocumentContent]:
    """
    Parse a .content JSON file to get page UUIDs and document structure.

    The .content file contains:
    - pages: list of page UUIDs (legacy format)
    - cPages: dict with page info (v6 format, firmware 3.0+)
    - fileType: "pdf", "epub", or ""
    - pageCount: number of pages
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        page_uuids: list[str] = []
        page_redir: dict[int, int] = {}
        c_pages = data.get("cPages", None)

        # v6 format uses cPages.pages[].id
        if c_pages and "pages" in c_pages:
            live_idx = 0
            for page in c_pages["pages"]:
                # Skip deleted/tombstoned pages
                if page.get("deleted", False):
                    continue
                page_id = page.get("id", page.get("uuid", ""))
                if page_id:
                    page_uuids.append(page_id)
                # redir.value maps this page to its original PDF page index
                redir = page.get("redir")
                if isinstance(redir, dict) and "value" in redir:
                    try:
                        page_redir[live_idx] = int(redir["value"])
                    except (ValueError, TypeError):
                        pass
                live_idx += 1
        # Legacy format uses pages array directly
        elif "pages" in data:
            page_uuids = data["pages"]

        page_count = data.get("pageCount", len(page_uuids))

        # Parse document-level tags
        doc_tags: list[str] = []
        for tag in data.get("tags", []):
            if isinstance(tag, dict):
                doc_tags.append(tag.get("name", ""))
            elif isinstance(tag, str):
                doc_tags.append(tag)
        doc_tags = [t for t in doc_tags if t]

        # Parse page-level tags
        page_tags_map: dict[str, list[str]] = {}
        for pt in data.get("pageTags", []):
            if isinstance(pt, dict):
                page_id = pt.get("pageId", "")
                tag_name = pt.get("name", "")
                if page_id and tag_name:
                    if page_id not in page_tags_map:
                        page_tags_map[page_id] = []
                    page_tags_map[page_id].append(tag_name)

        return DocumentContent(
            uuid=os.path.splitext(os.path.basename(filepath))[0],
            file_type=data.get("fileType", ""),
            page_count=page_count,
            page_uuids=page_uuids,
            orientation=data.get("orientation", "portrait"),
            c_pages=c_pages,
            page_redir=page_redir if page_redir else None,
            tags=doc_tags,
            page_tags=page_tags_map,
        )
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def _scan_xochitl_directory(
    xochitl_path: str,
) -> tuple[dict[str, "DocumentMetadata"], dict[str, "DocumentContent"], Callable[[str], str]]:
    """
    Shared scanning logic for document discovery functions.

    Reads all .metadata and .content files from the xochitl directory,
    builds the folder hierarchy, and returns a folder-path resolver.

    Args:
        xochitl_path: Absolute path to the synced xochitl directory.

    Returns:
        A tuple of (metadata_map, content_map, resolve_folder_path) where
        resolve_folder_path is a callable that turns a parent UUID into
        a slash-separated folder path string.
    """
    metadata_map: dict[str, DocumentMetadata] = {}
    content_map: dict[str, DocumentContent] = {}

    # Phase 1: Read all metadata files
    for entry in os.listdir(xochitl_path):
        if entry.endswith(".metadata"):
            if "sync-conflict" in entry or ".syncthing." in entry:
                continue
            uuid = entry[: -len(".metadata")]
            meta = parse_metadata_file(os.path.join(xochitl_path, entry))
            if meta and not meta.deleted:
                metadata_map[uuid] = meta

    # Phase 2: Read content files for non-deleted documents
    for uuid in metadata_map:
        content_path = os.path.join(xochitl_path, f"{uuid}.content")
        if os.path.exists(content_path):
            content = parse_content_file(content_path)
            if content:
                content_map[uuid] = content

    # Phase 3: Build folder hierarchy (folders are entries with type "CollectionType")
    folder_names: dict[str, str] = {}
    for uuid, meta in metadata_map.items():
        if meta.doc_type == "CollectionType":
            folder_names[uuid] = meta.visible_name

    def resolve_folder_path(parent_uuid: str) -> str:
        """Walk the parent chain to build a full folder path."""
        parts: list[str] = []
        current = parent_uuid
        max_depth = 20
        depth = 0
        while current and current in folder_names and depth < max_depth:
            parts.append(folder_names[current])
            if current in metadata_map:
                current = metadata_map[current].parent_uuid
            else:
                break
            depth += 1
        parts.reverse()
        return "/".join(parts)

    return metadata_map, content_map, resolve_folder_path


def discover_documents(xochitl_path: str) -> list[ReMarkableDocument]:
    """
    Scan the xochitl directory and return all non-deleted PDF documents.

    This function:
    1. Reads all .metadata files to get document names and hierarchy
    2. Reads all .content files to get page UUIDs
    3. Reconstructs folder paths from parent UUID chains
    4. Filters to only PDF documents (the primary extraction target)

    Args:
        xochitl_path: Absolute path to the synced xochitl directory.

    Returns:
        List of ReMarkableDocument objects for all PDF documents.
    """
    if not os.path.isdir(xochitl_path):
        return []

    metadata_map, content_map, resolve_folder_path = _scan_xochitl_directory(
        xochitl_path
    )

    documents: list[ReMarkableDocument] = []
    for uuid, meta in metadata_map.items():
        if meta.doc_type == "CollectionType":
            continue  # Skip folders

        content = content_map.get(uuid)
        if not content:
            continue

        # For this function, only process PDFs
        is_pdf = content.file_type == "pdf"
        if not is_pdf:
            continue

        has_pdf_file = os.path.exists(os.path.join(xochitl_path, f"{uuid}.pdf"))
        folder_path = resolve_folder_path(meta.parent_uuid)

        documents.append(
            ReMarkableDocument(
                uuid=uuid,
                visible_name=meta.visible_name,
                parent_uuid=meta.parent_uuid,
                doc_type="pdf",
                last_modified=meta.last_modified,
                page_count=content.page_count,
                page_uuids=content.page_uuids,
                has_pdf=has_pdf_file,
                folder_path=folder_path,
                tags=content.tags,
                page_tags=content.page_tags,
            )
        )

    return documents


def discover_all_documents(
    xochitl_path: str,
    include_notebooks: bool = True,
    include_pdfs: bool = True,
) -> list[ReMarkableDocument]:
    """
    Scan the xochitl directory and return all non-deleted documents.

    Unlike discover_documents() which only returns PDFs, this function
    can also return notebooks (documents with no fileType or empty fileType
    in .content). This is needed for Sprint 8 handwritten annotation support.

    Args:
        xochitl_path: Absolute path to the synced xochitl directory.
        include_notebooks: Whether to include notebook documents.
        include_pdfs: Whether to include PDF documents.

    Returns:
        List of ReMarkableDocument objects.
    """
    if not os.path.isdir(xochitl_path):
        return []

    metadata_map, content_map, resolve_folder_path = _scan_xochitl_directory(
        xochitl_path
    )

    documents: list[ReMarkableDocument] = []
    for uuid, meta in metadata_map.items():
        if meta.doc_type == "CollectionType":
            continue

        content = content_map.get(uuid)
        if not content:
            continue

        is_pdf = content.file_type == "pdf"
        is_epub = content.file_type == "epub"
        is_notebook = (
            not content.file_type
            or content.file_type == ""
            or content.file_type == "notebook"
        )

        # Filter by requested types
        if is_pdf and not include_pdfs:
            continue
        if is_notebook and not include_notebooks:
            continue
        if not is_pdf and not is_notebook and not is_epub:
            continue

        has_pdf_file = os.path.exists(os.path.join(xochitl_path, f"{uuid}.pdf"))

        if is_pdf:
            doc_type = "pdf"
        elif is_epub:
            doc_type = "epub"
        else:
            doc_type = "notebook"

        folder_path = resolve_folder_path(meta.parent_uuid)

        documents.append(
            ReMarkableDocument(
                uuid=uuid,
                visible_name=meta.visible_name,
                parent_uuid=meta.parent_uuid,
                doc_type=doc_type,
                last_modified=meta.last_modified,
                page_count=content.page_count,
                page_uuids=content.page_uuids,
                has_pdf=has_pdf_file,
                folder_path=folder_path,
                tags=content.tags,
                page_tags=content.page_tags,
            )
        )

    return documents
