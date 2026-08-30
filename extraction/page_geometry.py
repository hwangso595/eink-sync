"""Per-page canvas geometry for reMarkable v6 scene files."""

from dataclasses import dataclass
import math
from typing import Optional

from constants import RM_SCREEN_HEIGHT, RM_SCREEN_WIDTH

try:
    from rmscene import read_blocks
    from rmscene.scene_stream import SceneInfo
except ImportError:
    read_blocks = None  # type: ignore[assignment]
    SceneInfo = None  # type: ignore[assignment,misc]


# Existing PDF fixtures use a device-independent logical grid. The legacy
# renderer's calibrated 0.73 transform maps that grid to 1404x1872. Scaling the
# transform by the SceneInfo canvas dimension maps the same corner coordinates
# to Paper Pro (1620x2160) without changing legacy output.
LEGACY_PDF_COORD_SCALE = 0.73

_KNOWN_PPI = {
    (1404, 1872): 226.0,
    (1620, 2160): 229.0,
    (954, 1696): 264.0,
}

# SceneInfo comes from a device-owned binary file. Keep future, unfamiliar
# canvases usable, but reject dimensions that could allocate unreasonable
# images or are too small to represent a tablet page.
_MIN_CANVAS_DIMENSION = 100.0
_MAX_CANVAS_DIMENSION = 10_000.0


@dataclass(frozen=True)
class PageGeometry:
    width: float
    height: float
    ppi: float
    source: str
    ppi_is_fallback: bool = False

    @property
    def pdf_coord_scale(self) -> float:
        """Map the shared PDF annotation grid to this page canvas."""
        if self.width > self.height:
            return LEGACY_PDF_COORD_SCALE * self.width / RM_SCREEN_HEIGHT
        return LEGACY_PDF_COORD_SCALE * self.width / RM_SCREEN_WIDTH

    @property
    def cache_key(self) -> str:
        return f"{int(self.width)}x{int(self.height)}"


LEGACY_PAGE_GEOMETRY = PageGeometry(
    RM_SCREEN_WIDTH,
    RM_SCREEN_HEIGHT,
    _KNOWN_PPI[(int(RM_SCREEN_WIDTH), int(RM_SCREEN_HEIGHT))],
    "legacy-fallback",
)


def geometry_from_paper_size(size: object) -> Optional[PageGeometry]:
    """Validate a SceneInfo paper-size pair and return usable geometry."""
    if not isinstance(size, (tuple, list)) or len(size) != 2:
        return None
    try:
        width, height = float(size[0]), float(size[1])
    except (TypeError, ValueError):
        return None
    if (
        not math.isfinite(width)
        or not math.isfinite(height)
        or width < _MIN_CANVAS_DIMENSION
        or height < _MIN_CANVAS_DIMENSION
        or width > _MAX_CANVAS_DIMENSION
        or height > _MAX_CANVAS_DIMENSION
    ):
        return None

    profile = (int(min(width, height)), int(max(width, height)))
    ppi = _KNOWN_PPI.get(profile)
    return PageGeometry(
        width,
        height,
        ppi if ppi is not None else 226.0,
        "scene-info",
        ppi_is_fallback=ppi is None,
    )


def read_page_geometry(rm_path: str) -> PageGeometry:
    """Read SceneInfo.paper_size, falling back safely for legacy/malformed files."""
    if read_blocks is None:
        return LEGACY_PAGE_GEOMETRY
    try:
        with open(rm_path, "rb") as handle:
            for block in read_blocks(handle):
                is_scene_info = SceneInfo is not None and isinstance(block, SceneInfo)
                if is_scene_info or block.__class__.__name__ == "SceneInfo":
                    geometry = geometry_from_paper_size(getattr(block, "paper_size", None))
                    if geometry is not None:
                        return geometry
    # A malformed or newer scene stream must never make extraction fail.  The
    # parser can surface several exception types (including EOFError), so keep
    # geometry detection fail-safe and use the legacy canvas below.
    except Exception:
        pass
    return LEGACY_PAGE_GEOMETRY
