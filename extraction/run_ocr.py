#!/usr/bin/env python3
"""
CLI entry point for OCR processing, called by the TypeScript OCR bridge.

Communicates results as JSON on stdout; logs/errors go to stderr.

Usage:
    python run_ocr.py --mode status
    python run_ocr.py --mode file --input /path/to/image.png [--lang eng]
    python run_ocr.py --mode svg --input /path/to/file.svg [--lang eng] [--dpi 150]
    python run_ocr.py --mode batch --input /path/1.png /path/2.png [--lang eng]

Output format (JSON on stdout):
    {
        "success": true,
        "mode": "file",
        "results": [
            {
                "text": "Recognized text...",
                "confidence": 87.5,
                "language": "eng",
                "warnings": [],
                "source": "/path/to/image.png"
            }
        ],
        "status": null,
        "error": null
    }
"""

import argparse
import json
import sys
import traceback

from ocr_engine import (
    is_ocr_available,
    get_ocr_status,
    ocr_image_file,
    ocr_svg_content,
    batch_ocr_images,
    OcrResult,
)


def result_to_dict(result: OcrResult, source: str = "") -> dict:
    """Convert an OcrResult to a JSON-serializable dict."""
    return {
        "text": result.text,
        "confidence": result.confidence,
        "language": result.language,
        "warnings": result.warnings,
        "source": source,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run OCR on reMarkable notebook page images"
    )
    parser.add_argument(
        "--mode",
        required=True,
        choices=["status", "file", "svg", "batch"],
        help="Operation mode",
    )
    parser.add_argument(
        "--input",
        nargs="*",
        default=[],
        help="Input file path(s)",
    )
    parser.add_argument(
        "--lang",
        default="eng",
        help="Tesseract language code (default: eng)",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="DPI for SVG rasterization (default: 150)",
    )
    args = parser.parse_args()

    output: dict = {
        "success": True,
        "mode": args.mode,
        "results": [],
        "status": None,
        "error": None,
    }

    try:
        if args.mode == "status":
            output["status"] = get_ocr_status()

        elif args.mode == "file":
            if not args.input:
                output["success"] = False
                output["error"] = "No input file specified"
            else:
                file_path = args.input[0]
                result = ocr_image_file(file_path, lang=args.lang)
                output["results"].append(result_to_dict(result, source=file_path))

        elif args.mode == "svg":
            if not args.input:
                output["success"] = False
                output["error"] = "No input SVG file specified"
            else:
                svg_path = args.input[0]
                with open(svg_path, "r", encoding="utf-8") as f:
                    svg_content = f.read()
                result = ocr_svg_content(svg_content, lang=args.lang, dpi=args.dpi)
                output["results"].append(result_to_dict(result, source=svg_path))

        elif args.mode == "batch":
            if not args.input:
                output["success"] = False
                output["error"] = "No input files specified"
            else:
                results = batch_ocr_images(args.input, lang=args.lang)
                for i, result in enumerate(results):
                    source = args.input[i] if i < len(args.input) else ""
                    output["results"].append(result_to_dict(result, source=source))

    except ImportError as e:
        output["success"] = False
        output["error"] = str(e)
    except Exception as e:
        output["success"] = False
        output["error"] = f"OCR processing failed: {e}"
        print(traceback.format_exc(), file=sys.stderr, flush=True)

    print(json.dumps(output, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
