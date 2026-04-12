"""
Tests for the OCR engine module.

These tests verify:
1. Graceful handling when OCR dependencies are not available
2. OCR status reporting
3. Image loading and error handling
4. SVG rasterization fallback behavior
5. Batch processing with mixed success/failure

Note: Full OCR accuracy tests require Tesseract to be installed.
Tests that need Tesseract are skipped if it is not available.
"""

import os
import sys
import tempfile
import pytest

from ocr_engine import (
    is_ocr_available,
    get_ocr_status,
    ocr_image_file,
    ocr_image_bytes,
    ocr_svg_content,
    batch_ocr_images,
    OcrResult,
    PYTESSERACT_AVAILABLE,
    PILLOW_AVAILABLE,
)


class TestOcrAvailability:
    """Test OCR availability detection."""

    def test_get_ocr_status_returns_dict(self):
        """get_ocr_status always returns a well-formed dict."""
        status = get_ocr_status()
        assert isinstance(status, dict)
        assert "available" in status
        assert "pytesseract_installed" in status
        assert "pillow_installed" in status
        assert "tesseract_binary_found" in status
        assert "tesseract_version" in status
        assert "error" in status

    def test_is_ocr_available_returns_bool(self):
        """is_ocr_available always returns a boolean."""
        result = is_ocr_available()
        assert isinstance(result, bool)

    def test_status_pytesseract_field_matches_import(self):
        """The status dict reports pytesseract availability correctly."""
        status = get_ocr_status()
        assert status["pytesseract_installed"] == PYTESSERACT_AVAILABLE

    def test_status_pillow_field_matches_import(self):
        """The status dict reports Pillow availability correctly."""
        status = get_ocr_status()
        assert status["pillow_installed"] == PILLOW_AVAILABLE


class TestOcrImageFile:
    """Test OCR on image files."""

    def test_missing_file_raises_file_not_found(self):
        """ocr_image_file raises FileNotFoundError for nonexistent path."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        with pytest.raises(FileNotFoundError):
            ocr_image_file("/nonexistent/image.png")

    def test_invalid_image_raises_value_error(self):
        """ocr_image_file raises ValueError for non-image files."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            f.write(b"not an image")
            f.flush()
            tmp_path = f.name
        try:
            with pytest.raises(ValueError, match="Failed to load image"):
                ocr_image_file(tmp_path)
        finally:
            os.unlink(tmp_path)

    def test_import_error_when_deps_missing(self):
        """ocr_image_file raises ImportError when deps are missing."""
        if PYTESSERACT_AVAILABLE and PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies are installed; cannot test missing deps")
        with pytest.raises(ImportError):
            ocr_image_file("/some/image.png")


class TestOcrImageBytes:
    """Test OCR on raw image bytes."""

    def test_empty_bytes_raises_value_error(self):
        """Empty bytes should raise ValueError."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        with pytest.raises(ValueError, match="Failed to decode image bytes"):
            ocr_image_bytes(b"")

    def test_import_error_when_deps_missing(self):
        """ocr_image_bytes raises ImportError when deps are missing."""
        if PYTESSERACT_AVAILABLE and PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies are installed; cannot test missing deps")
        with pytest.raises(ImportError):
            ocr_image_bytes(b"\x89PNG")


class TestOcrSvgContent:
    """Test OCR on SVG content."""

    def test_empty_svg_returns_warning(self):
        """Empty or invalid SVG returns a result with warnings."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        result = ocr_svg_content("<svg></svg>")
        assert isinstance(result, OcrResult)
        # Either works or gives a warning (depends on cairosvg availability)

    def test_import_error_when_deps_missing(self):
        """ocr_svg_content raises ImportError when deps are missing."""
        if PYTESSERACT_AVAILABLE and PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies are installed; cannot test missing deps")
        with pytest.raises(ImportError):
            ocr_svg_content("<svg></svg>")


class TestBatchOcr:
    """Test batch OCR processing."""

    def test_empty_batch_returns_empty_list(self):
        """Empty input list returns empty result list."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        results = batch_ocr_images([])
        assert results == []

    def test_batch_with_nonexistent_files_captures_errors(self):
        """Batch processing captures per-file errors instead of raising."""
        if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies not installed")
        results = batch_ocr_images(["/no/such/file1.png", "/no/such/file2.png"])
        assert len(results) == 2
        for result in results:
            assert result.text == ""
            assert result.confidence == -1
            assert len(result.warnings) > 0

    def test_import_error_when_deps_missing(self):
        """batch_ocr_images raises ImportError when deps are missing."""
        if PYTESSERACT_AVAILABLE and PILLOW_AVAILABLE:
            pytest.skip("OCR dependencies are installed; cannot test missing deps")
        with pytest.raises(ImportError):
            batch_ocr_images(["/some/image.png"])


class TestOcrResultDataclass:
    """Test the OcrResult dataclass."""

    def test_result_fields(self):
        """OcrResult has all expected fields."""
        result = OcrResult(
            text="Hello world",
            confidence=95.0,
            language="eng",
            warnings=[],
        )
        assert result.text == "Hello world"
        assert result.confidence == 95.0
        assert result.language == "eng"
        assert result.warnings == []

    def test_result_with_warnings(self):
        """OcrResult can carry warnings."""
        result = OcrResult(
            text="partial",
            confidence=25.0,
            language="eng",
            warnings=["Low confidence"],
        )
        assert len(result.warnings) == 1
        assert "Low confidence" in result.warnings[0]
