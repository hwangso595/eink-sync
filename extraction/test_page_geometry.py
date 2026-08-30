import pytest

import page_geometry as pg


@pytest.mark.parametrize(
    ("size", "expected", "ppi", "scale"),
    [
        ((1404, 1872), (1404, 1872), 226, 0.73),
        ((1620, 2160), (1620, 2160), 229, 0.73 * 1620 / 1404),
        ((954, 1696), (954, 1696), 264, 0.73 * 954 / 1404),
        ((2160, 1620), (2160, 1620), 229, 0.73 * 2160 / 1872),
    ],
)
def test_known_page_geometries(size, expected, ppi, scale):
    geometry = pg.geometry_from_paper_size(size)
    assert geometry is not None
    assert (geometry.width, geometry.height) == expected
    assert geometry.ppi == ppi
    assert geometry.pdf_coord_scale == pytest.approx(scale)
    assert not geometry.ppi_is_fallback


@pytest.mark.parametrize(
    "size",
    [
        None,
        (),
        (1,),
        (0, 100),
        (99, 100),
        (-1, 100),
        (float("nan"), 200),
        (10_001, 2_000),
    ],
)
def test_invalid_page_geometries(size):
    assert pg.geometry_from_paper_size(size) is None


def test_unknown_valid_size_preserves_canvas_with_ppi_fallback():
    geometry = pg.geometry_from_paper_size((1200, 2000))
    assert geometry is not None
    assert (geometry.width, geometry.height) == (1200, 2000)
    assert geometry.ppi_is_fallback


def test_reads_scene_info_paper_size(tmp_path, monkeypatch):
    rm_path = tmp_path / "page.rm"
    rm_path.write_bytes(b"fixture")
    fake_scene_info = type("SceneInfo", (), {})()
    fake_scene_info.paper_size = (1620, 2160)
    monkeypatch.setattr(pg, "SceneInfo", None)
    monkeypatch.setattr(pg, "read_blocks", lambda _: [fake_scene_info])

    geometry = pg.read_page_geometry(str(rm_path))
    assert geometry.cache_key == "1620x2160"


def test_missing_scene_info_uses_legacy_fallback(tmp_path, monkeypatch):
    rm_path = tmp_path / "page.rm"
    rm_path.write_bytes(b"fixture")
    monkeypatch.setattr(pg, "read_blocks", lambda _: [])
    assert pg.read_page_geometry(str(rm_path)) == pg.LEGACY_PAGE_GEOMETRY
