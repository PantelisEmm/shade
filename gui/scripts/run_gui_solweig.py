"""Run a SOLWEIG baseline or intervention comparison for a local GUI study area.

The Vite development server writes a request JSON and launches this script in
the project's virtual environment. Baseline-only requests simulate the untouched
AOI once per scenario/date/hour. Comparison requests reuse that baseline, simulate
the requested tree layout, and export compact normalized PNG grids for the browser.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)

import numpy as np
import rasterio
import solweig
from PIL import Image
from scipy.ndimage import distance_transform_edt

GUI_ROOT = Path(__file__).resolve().parents[1]
ROOT = GUI_ROOT.parent
RUNS = ROOT / "runs" / "gui_solweig"
AOI_NAME = "chinatown"
AOI = ROOT / "data" / "aoi" / AOI_NAME
PUBLIC = GUI_ROOT / "public" / "data" / AOI_NAME / "simulations"
PHYSICS_VERSION = "gui-solweig-multi-aoi-v2"
GEOMETRY_VERSION = "gui-solweig-tree-geometry-v1"
REFLECTIVE_ALBEDO = 0.45
BASELINE_PAVEMENT_ALBEDO = 0.12
BASELINE_ROOF_ALBEDO = 0.08
COOL_ROOF_ALBEDO = 0.50
GREEN_ROOF_ALBEDO = 0.25
GREEN_ROOF_EMISSIVITY = 0.94
GREEN_ROOF_TGK = 0.21
GREEN_ROOF_TSTART = -3.38
GREEN_ROOF_TMAXLST = 14.0
DEPAVED_GRASS_ALBEDO = 0.25
SHADE_CANOPY_HEIGHT_M = 3.0
SHADE_CANOPY_BOTTOM_M = 2.85
SOLAR_CANOPY_HEIGHT_M = 3.5
SOLAR_CANOPY_BOTTOM_M = 3.35


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


class Status:
    def __init__(self, path: Path, run_id: str, mode: str) -> None:
        self.path = path
        self.run_id = run_id
        self.mode = mode
        self.started = time.time()

    def update(self, state: str, stage: str, progress: int, **extra: Any) -> None:
        atomic_json(
            self.path,
            {
                "id": self.run_id,
                "mode": self.mode,
                "state": state,
                "stage": stage,
                "progress": max(0, min(100, int(progress))),
                "elapsed_seconds": round(time.time() - self.started, 1),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                **extra,
            },
        )


def canonical_trees(trees: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [
        {
            "id": str(tree["id"]),
            "x": round(float(tree["x"]), 3),
            "y": round(float(tree["y"]), 3),
            "size": "small" if tree.get("size") == "small" else "medium",
            "heightM": round(float(tree["heightM"]), 2),
            "crownDiameterM": round(float(tree["crownDiameterM"]), 2),
        }
        for tree in trees
    ]
    return sorted(normalized, key=lambda tree: tree["id"])


def validate_tree_placements(trees: list[dict[str, Any]], landcover: np.ndarray, resolution: float) -> None:
    """Validate geometry while matching the policy auditor's centre-pixel rule.

    The strict repository contract audits the planting pixel, then paints the
    configured crown as a clipped disc.  Rejecting an otherwise feasible policy
    because that disc crosses a roof edge would make the GUI simulator disagree
    with ``score_policy.py`` and prevent archived policies from being viewed.
    Interactive GUI placement may remain more conservative as a design aid.
    """
    rows, cols = landcover.shape
    for index, tree in enumerate(trees, start=1):
        x = float(tree["x"])
        y = float(tree["y"])
        height = float(tree["heightM"])
        crown_diameter = float(tree["crownDiameterM"])
        if not all(np.isfinite(value) for value in (x, y, height, crown_diameter)):
            raise ValueError(f"Tree {index} contains a non-finite geometry value")
        if not 2.0 <= height <= 30.0:
            raise ValueError(f"Tree {index} height {height:g} m is outside the supported 2–30 m range")
        if not 2.0 <= crown_diameter <= 20.0:
            raise ValueError(f"Tree {index} crown {crown_diameter:g} m is outside the supported 2–20 m range")
        col = int(np.floor(x))
        row = int(np.floor(y))
        if col < 0 or col >= cols or row < 0 or row >= rows:
            raise ValueError(f"Tree {index} planting pixel falls outside the study boundary")
        if int(landcover[row, col]) not in (1, 3, 4, 5, 6):
            raise ValueError(f"Tree {index} planting pixel is on a building, water, or invalid AOI cell")


def encode_raster_mask(mask: np.ndarray) -> dict[str, Any]:
    rows, cols = mask.shape
    packed = np.packbits(mask.reshape(-1), bitorder="little")
    return {
        "width": cols,
        "height": rows,
        "count": int(mask.sum()),
        "data": base64.b64encode(packed.tobytes()).decode(),
    }


def decode_raster_mask(value: Any, shape: tuple[int, int], label: str) -> tuple[np.ndarray, dict[str, Any]]:
    rows, cols = shape
    empty = np.zeros(shape, dtype=bool)
    if not value:
        return empty, encode_raster_mask(empty)
    width = int(value.get("width", 0))
    height = int(value.get("height", 0))
    if (width != cols or height != rows):
        raise ValueError(f"{label} grid {width}x{height} does not match AOI {cols}x{rows}")
    encoded = str(value.get("data", ""))
    packed = np.frombuffer(base64.b64decode(encoded, validate=True), dtype="uint8")
    expected = (rows * cols + 7) // 8
    if packed.size != expected:
        raise ValueError(f"{label} bit grid has the wrong byte length")
    mask = np.unpackbits(packed, bitorder="little")[: rows * cols].reshape(shape).astype(bool)
    return mask, encode_raster_mask(mask)


def fingerprint(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


def select_weather(scenario: str, date: str, hour: int):
    epw = ROOT / "data" / "weather" / "scenarios" / f"boston_{scenario}.epw"
    if not epw.exists():
        raise FileNotFoundError(f"Missing {epw.relative_to(ROOT)}; run scripts/make_weather_scenarios.py")
    weather = solweig.Weather.from_epw(str(epw), start=date, end=date, hours=[hour])
    if not weather:
        raise ValueError(f"No weather row for {date} at {hour}:00 in {epw.name}")
    return epw, weather


def apply_tree_geometry(trees: list[dict[str, Any]], target: Path) -> tuple[Path, Path]:
    target.mkdir(parents=True, exist_ok=True)
    with rasterio.open(AOI / "cdsm.tif") as source:
        cdsm = source.read(1)
        cdsm_profile = source.profile
        resolution = abs(source.transform.a)
    with rasterio.open(AOI / "landcover.tif") as source:
        landcover = source.read(1)
        land_profile = source.profile

    rows, cols = cdsm.shape
    for tree in trees:
        center_x = float(tree["x"])
        center_y = float(tree["y"])
        radius = max(1.0, float(tree["crownDiameterM"]) / (2 * resolution))
        min_x = max(0, int(np.floor(center_x - radius)))
        max_x = min(cols - 1, int(np.ceil(center_x + radius)))
        min_y = max(0, int(np.floor(center_y - radius)))
        max_y = min(rows - 1, int(np.ceil(center_y + radius)))
        yy, xx = np.ogrid[min_y : max_y + 1, min_x : max_x + 1]
        crown = (xx - center_x) ** 2 + (yy - center_y) ** 2 <= radius**2
        view = cdsm[min_y : max_y + 1, min_x : max_x + 1]
        view[crown] = np.maximum(view[crown], float(tree["heightM"]))
        land_view = landcover[min_y : max_y + 1, min_x : max_x + 1]
        land_view[crown] = 4

    cdsm_path = target / "cdsm.tif"
    landcover_path = target / "landcover.tif"
    with rasterio.open(cdsm_path, "w", **cdsm_profile) as destination:
        destination.write(cdsm, 1)
    with rasterio.open(landcover_path, "w", **land_profile) as destination:
        destination.write(landcover, 1)
    return cdsm_path, landcover_path


def apply_depaving_landcover(source: Path, depaved_mask: np.ndarray, target: Path) -> Path:
    """Write an aligned intervention land-cover grid with pavement changed to grass."""
    target.mkdir(parents=True, exist_ok=True)
    with rasterio.open(source) as dataset:
        landcover = dataset.read(1)
        profile = dataset.profile
    if depaved_mask.shape != landcover.shape:
        raise ValueError("Pavement-to-grass mask is not aligned with the land-cover grid")
    # Tree crowns are encoded as class 4 by ``apply_tree_geometry``. Keep that
    # canopy class where a tree overlaps converted ground and convert the
    # remaining selected pavement pixels to class 5 grass.
    if np.any(depaved_mask & ~np.isin(landcover, (1, 4))):
        raise ValueError("Pavement-to-grass conversion includes non-pavement pixels")
    landcover[depaved_mask & (landcover == 1)] = 5
    output = target / "landcover.tif"
    with rasterio.open(output, "w", **profile) as destination:
        destination.write(landcover, 1)
    return output


def apply_shade_canopy_geometry(
    source_cdsm: Path,
    canopy_mask: np.ndarray,
    target: Path,
) -> tuple[Path, Path, np.ndarray]:
    """Add thin 3 m overhead panels on a deterministic 50/50 footprint.

    SOLWEIG exposes one vegetation transmissivity for the entire CDSM. Keeping
    half of the requested footprint open and shading half with leaf-on CDSM
    cells yields approximately 50% area-averaged direct-solar transmission
    without making tree crowns artificially transparent. A high TDSM bottom
    makes the inserted vegetation volume a thin overhead plane rather than a
    shrub extending from near ground level.
    """
    target.mkdir(parents=True, exist_ok=True)
    with rasterio.open(source_cdsm) as dataset:
        cdsm = dataset.read(1)
        profile = dataset.profile
    if canopy_mask.shape != cdsm.shape:
        raise ValueError("Shade-canopy mask is not aligned with the canopy grid")
    yy, xx = np.indices(canopy_mask.shape)
    physical_mask = canopy_mask & (((xx + yy) & 1) == 0)
    original_cdsm = cdsm.copy()
    tdsm = np.where(original_cdsm > 0, original_cdsm * 0.25, 0).astype("float32")
    cdsm[physical_mask] = np.maximum(cdsm[physical_mask], SHADE_CANOPY_HEIGHT_M)
    inserted = physical_mask & (original_cdsm < SHADE_CANOPY_HEIGHT_M)
    tdsm[inserted] = SHADE_CANOPY_BOTTOM_M
    cdsm_path = target / "cdsm.tif"
    tdsm_path = target / "tdsm.tif"
    with rasterio.open(cdsm_path, "w", **profile) as destination:
        destination.write(cdsm, 1)
    with rasterio.open(tdsm_path, "w", **profile) as destination:
        destination.write(tdsm, 1)
    return cdsm_path, tdsm_path, physical_mask


def apply_combined_canopy_geometry(
    source_cdsm: Path,
    shade_canopy_mask: np.ndarray,
    solar_canopy_mask: np.ndarray,
    target: Path,
) -> tuple[Path, Path, np.ndarray, np.ndarray]:
    """Add translucent fabric and more-opaque PV panels to one CDSM/TDSM pair.

    Fabric uses alternating cells to approximate 50% transmission. PV uses its
    entire requested footprint, which is the most opaque per-intervention
    representation possible while retaining the shared leaf-on transmissivity
    and keeping the ground beneath it walkable.
    """
    target.mkdir(parents=True, exist_ok=True)
    with rasterio.open(source_cdsm) as dataset:
        cdsm = dataset.read(1)
        profile = dataset.profile
    if shade_canopy_mask.shape != cdsm.shape or solar_canopy_mask.shape != cdsm.shape:
        raise ValueError("Canopy masks are not aligned with the canopy grid")
    yy, xx = np.indices(cdsm.shape)
    physical_shade = shade_canopy_mask & (((xx + yy) & 1) == 0)
    physical_solar = solar_canopy_mask.copy()
    original_cdsm = cdsm.copy()
    tdsm = np.where(original_cdsm > 0, original_cdsm * 0.25, 0).astype("float32")
    cdsm[physical_shade] = np.maximum(cdsm[physical_shade], SHADE_CANOPY_HEIGHT_M)
    inserted_shade = physical_shade & (original_cdsm < SHADE_CANOPY_HEIGHT_M)
    tdsm[inserted_shade] = SHADE_CANOPY_BOTTOM_M
    before_solar = cdsm.copy()
    cdsm[physical_solar] = np.maximum(cdsm[physical_solar], SOLAR_CANOPY_HEIGHT_M)
    inserted_solar = physical_solar & (before_solar < SOLAR_CANOPY_HEIGHT_M)
    tdsm[inserted_solar] = SOLAR_CANOPY_BOTTOM_M
    cdsm_path = target / "cdsm.tif"
    tdsm_path = target / "tdsm.tif"
    with rasterio.open(cdsm_path, "w", **profile) as destination:
        destination.write(cdsm, 1)
    with rasterio.open(tdsm_path, "w", **profile) as destination:
        destination.write(tdsm, 1)
    return cdsm_path, tdsm_path, physical_shade, physical_solar


@contextmanager
def explicit_material_overrides(
    surface: Any,
    reflective_mask: np.ndarray | None,
    cool_roof_mask: np.ndarray | None,
    green_roof_mask: np.ndarray | None,
    depaved_mask: np.ndarray | None = None,
) -> Iterator[None]:
    """Apply intervention materials without changing semantic land-cover IDs.

    SOLWEIG 0.1.0b92 copies ``surface.albedo`` into each tile, but its land-cover
    property lookup ignores that explicit grid whenever ``land_cover`` is also
    present. This wrapper makes the explicit optical grid take precedence and
    gives green-roof pixels the class-5 grass thermal parameters while retaining
    class 2 in ``land_cover``. Retaining class 2 is essential because SOLWEIG's
    building/GVF calculation identifies buildings from that semantic ID.

    The grass parameters represent SOLWEIG's supported radiative/thermal proxy;
    this version does not expose a roof soil-water or evapotranspiration model.
    """
    has_reflective = reflective_mask is not None and reflective_mask.any()
    has_cool_roof = cool_roof_mask is not None and cool_roof_mask.any()
    has_green_roof = green_roof_mask is not None and green_roof_mask.any()
    has_depaved = depaved_mask is not None and depaved_mask.any()
    if has_reflective and reflective_mask.shape != surface.shape:
        raise ValueError("Reflective pavement mask is not aligned with the SOLWEIG surface")
    if has_cool_roof and cool_roof_mask.shape != surface.shape:
        raise ValueError("Cool-roof mask is not aligned with the SOLWEIG surface")
    if has_green_roof and green_roof_mask.shape != surface.shape:
        raise ValueError("Green-roof mask is not aligned with the SOLWEIG surface")
    if has_depaved and depaved_mask.shape != surface.shape:
        raise ValueError("Pavement-to-grass mask is not aligned with the SOLWEIG surface")

    original = solweig.SurfaceData.get_land_cover_properties
    albedo, emissivity, _, _, _ = original(surface, None)
    surface.albedo = np.array(albedo, dtype="float32", copy=True)
    surface.emissivity = np.array(emissivity, dtype="float32", copy=True)
    if surface.land_cover is None:
        raise ValueError("The Boston material baseline requires a land-cover grid")
    semantic_landcover = np.asarray(surface.land_cover)
    surface.albedo[semantic_landcover == 1] = BASELINE_PAVEMENT_ALBEDO
    surface.albedo[semantic_landcover == 2] = BASELINE_ROOF_ALBEDO
    if has_reflective:
        surface.albedo[reflective_mask] = REFLECTIVE_ALBEDO
    if has_cool_roof:
        surface.albedo[cool_roof_mask] = COOL_ROOF_ALBEDO
    if has_green_roof:
        surface.albedo[green_roof_mask] = GREEN_ROOF_ALBEDO
        surface.emissivity[green_roof_mask] = GREEN_ROOF_EMISSIVITY
    if has_depaved:
        if np.any(np.asarray(surface.land_cover)[depaved_mask] != 5):
            raise ValueError("Pavement-to-grass pixels were not converted to class 5")
        surface.albedo[depaved_mask] = DEPAVED_GRASS_ALBEDO

    def properties_with_explicit_materials(instance, materials=None):
        properties = [np.array(value, dtype="float32", copy=True) for value in original(instance, materials)]
        if instance.albedo is not None:
            properties[0] = np.asarray(instance.albedo, dtype="float32")
        if instance.emissivity is not None:
            properties[1] = np.asarray(instance.emissivity, dtype="float32")
        if instance.land_cover is not None and instance.albedo is not None:
            # Green roofs remain class-2 buildings. Their unique explicit
            # albedo identifies selected pixels inside each SOLWEIG tile.
            green = (np.asarray(instance.land_cover) == 2) & np.isclose(
                np.asarray(instance.albedo), GREEN_ROOF_ALBEDO, atol=1e-6,
            )
            properties[2][green] = GREEN_ROOF_TGK
            properties[3][green] = GREEN_ROOF_TSTART
            properties[4][green] = GREEN_ROOF_TMAXLST
        return tuple(properties)

    solweig.SurfaceData.get_land_cover_properties = properties_with_explicit_materials
    try:
        yield
    finally:
        solweig.SurfaceData.get_land_cover_properties = original


def run_surface(
    *,
    cdsm: Path,
    tdsm: Path | None,
    landcover: Path,
    cache_dir: Path,
    output_dir: Path,
    weather: list[Any],
    location: Any,
    status: Status,
    progress_start: int,
    progress_end: int,
    stage: str,
    reflective_mask: np.ndarray | None = None,
    cool_roof_mask: np.ndarray | None = None,
    green_roof_mask: np.ndarray | None = None,
    depaved_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    output_dir.mkdir(parents=True, exist_ok=True)
    result_cache = output_dir / "gui_result.npz"
    if result_cache.exists():
        with np.load(result_cache) as cached:
            return cached["tmrt"].astype("float32"), cached["utci"].astype("float32")

    status.update("running", f"Preparing {stage} geometry", progress_start)
    surface = solweig.SurfaceData.prepare(
        dsm=str(AOI / "dsm.tif"),
        cdsm=str(cdsm),
        tdsm=str(tdsm) if tdsm is not None else None,
        dem=str(AOI / "dem.tif"),
        land_cover=str(landcover),
        working_dir=str(cache_dir),
    )
    status.update("running", f"Simulating {stage}", progress_start + 5)

    def progress(current: int, total: int) -> None:
        fraction = current / max(total, 1)
        status.update(
            "running",
            f"Simulating {stage}",
            progress_start + 5 + round((progress_end - progress_start - 5) * fraction),
        )

    with explicit_material_overrides(surface, reflective_mask, cool_roof_mask, green_roof_mask, depaved_mask):
        summary = solweig.calculate(
            surface=surface,
            weather=weather,
            location=location,
            output_dir=str(output_dir),
            outputs=None,
            progress_callback=progress,
        )
    tmrt = np.asarray(summary.tmrt_mean, dtype="float32")
    utci = np.asarray(summary.utci_mean, dtype="float32")
    np.savez_compressed(result_cache, tmrt=tmrt, utci=utci)
    return tmrt, utci


def local_mask(
    shape: tuple[int, int], trees: list[dict[str, Any]], resolution_m: float,
    radius_m: float = 20.0,
) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    rows, cols = shape
    radius_pixels = radius_m / max(resolution_m, 1e-6)
    for tree in trees:
        x = float(tree["x"])
        y = float(tree["y"])
        min_x, max_x = max(0, int(x - radius_pixels)), min(cols - 1, int(x + radius_pixels))
        min_y, max_y = max(0, int(y - radius_pixels)), min(rows - 1, int(y + radius_pixels))
        yy, xx = np.ogrid[min_y : max_y + 1, min_x : max_x + 1]
        mask[min_y : max_y + 1, min_x : max_x + 1] |= (xx - x) ** 2 + (yy - y) ** 2 <= radius_pixels**2
    return mask


def surrounding_mask(mask: np.ndarray, resolution_m: float, radius_m: float = 20.0) -> np.ndarray:
    """Include the intervention and cells within a pedestrian-scale radius."""
    if not mask.any():
        return np.zeros_like(mask, dtype=bool)
    return distance_transform_edt(~mask) <= radius_m / max(resolution_m, 1e-6)


def metric_summary(
    baseline: np.ndarray,
    intervention: np.ndarray,
    nearby: np.ndarray,
    mean_mask: np.ndarray | None = None,
) -> dict[str, float]:
    valid = np.isfinite(baseline) & np.isfinite(intervention)
    mean_valid = valid if mean_mask is None else valid & mean_mask
    if not mean_valid.any():
        raise ValueError("The requested metric averaging domain contains no valid cells")
    reduction = baseline - intervention
    local_valid = mean_valid & nearby
    # Keep the display scale anchored to existing conditions so the stable
    # baseline and every later intervention use the same SOLWEIG color scale.
    low, high = np.nanpercentile(baseline[valid], (2, 98))
    if high <= low:
        high = low + 1
    return {
        "display_min": round(float(low), 2),
        "display_max": round(float(high), 2),
        "baseline_mean": round(float(np.nanmean(baseline[mean_valid])), 3),
        "intervention_mean": round(float(np.nanmean(intervention[mean_valid])), 3),
        "study_area_mean_reduction": round(float(np.nanmean(reduction[mean_valid])), 5),
        "local_mean_reduction": round(float(np.nanmean(reduction[local_valid])), 4) if local_valid.any() else 0.0,
        "mean_cell_count": int(mean_valid.sum()),
    }


def baseline_metric_summary(values: np.ndarray, mean_mask: np.ndarray | None = None) -> dict[str, float]:
    valid = np.isfinite(values)
    mean_valid = valid if mean_mask is None else valid & mean_mask
    if not mean_valid.any():
        raise ValueError("The requested baseline averaging domain contains no valid cells")
    low, high = np.nanpercentile(values[valid], (2, 98))
    if high <= low:
        high = low + 1
    return {
        "display_min": round(float(low), 2),
        "display_max": round(float(high), 2),
        "baseline_mean": round(float(np.nanmean(values[mean_valid])), 3),
        "mean_cell_count": int(mean_valid.sum()),
    }


def encode_metrics(path: Path, tmrt: np.ndarray, utci: np.ndarray, metrics: dict[str, dict[str, float]]) -> None:
    height, width = tmrt.shape
    rgba = np.zeros((height, width, 4), dtype="uint8")
    valid = np.isfinite(tmrt) & np.isfinite(utci)
    for channel, (name, values) in enumerate((("mrt", tmrt), ("utci", utci))):
        low = metrics[name]["display_min"]
        high = metrics[name]["display_max"]
        normalized = np.clip((values - low) / max(high - low, 1e-6), 0, 1)
        rgba[..., channel] = np.where(valid, np.round(normalized * 255), 0).astype("uint8")
    rgba[..., 3] = np.where(valid, 255, 0).astype("uint8")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def export_stable_baseline(
    aoi: str,
    scenario: str,
    date: str,
    hour: int,
    tmrt: np.ndarray,
    utci: np.ndarray,
    metrics: dict[str, dict[str, float]],
) -> dict[str, Any]:
    baseline_name = f"{scenario}_{hour}"
    path = GUI_ROOT / "public" / "data" / aoi / "solweig_baselines" / f"{baseline_name}.png"
    encode_metrics(path, tmrt, utci, metrics)
    baseline = {
        "model": f"SOLWEIG {getattr(solweig, '__version__', 'unknown')}",
        "physics_version": PHYSICS_VERSION,
        "scenario": scenario,
        "date": date,
        "hour": hour,
        "aoi": aoi,
        "file": f"/data/{aoi}/solweig_baselines/{baseline_name}.png",
        "mean_domains": {
            "mrt": "all valid AOI cells",
            "utci": "all valid AOI cells except baseline building roofs",
            "utci_cell_count": int(metrics["utci"].get("mean_cell_count", 0)),
        },
        "metrics": {
            name: {
                "display_min": values["display_min"],
                "display_max": values["display_max"],
                "baseline_mean": values["baseline_mean"],
            }
            for name, values in metrics.items()
        },
    }
    atomic_json(path.with_suffix(".json"), baseline)
    return baseline


def main() -> None:
    global AOI_NAME, AOI, PUBLIC
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    configured_aois = json.loads((ROOT / "config" / "aois.json").read_text(encoding="utf-8"))["aois"]
    AOI_NAME = str(request.get("aoi", "chinatown"))
    if AOI_NAME not in configured_aois:
        raise ValueError(f"Unknown study area: {AOI_NAME}")
    gui_manifest_path = GUI_ROOT / "public" / "data" / AOI_NAME / "manifest.json"
    if gui_manifest_path.exists():
        gui_manifest = json.loads(gui_manifest_path.read_text(encoding="utf-8"))
        AOI = ROOT / str(gui_manifest.get("source_directory", f"data/aoi/{AOI_NAME}"))
    else:
        AOI = ROOT / "data" / "aoi" / AOI_NAME
    if not (AOI / "aoi.json").exists():
        raise FileNotFoundError(f"Study area {AOI_NAME} has not been built")
    PUBLIC = GUI_ROOT / "public" / "data" / AOI_NAME / "simulations"
    run_id = str(request["id"])
    mode = str(request.get("mode", "comparison"))
    if mode not in {"baseline", "comparison"}:
        raise ValueError(f"Unsupported run mode: {mode}")
    job_dir = RUNS / run_id
    status = Status(job_dir / "status.json", run_id, mode)
    status.update("running", "Validating inputs", 1)

    try:
        trees = canonical_trees(request.get("trees", []))
        with rasterio.open(AOI / "landcover.tif") as landcover_source:
            aoi_shape = (landcover_source.height, landcover_source.width)
            aoi_resolution = abs(float(landcover_source.transform.a))
            baseline_landcover = landcover_source.read(1)
            baseline_pavement = baseline_landcover == 1
            baseline_buildings = baseline_landcover == 2
            perceived_temperature_domain = ~baseline_buildings
        aoi_metadata = json.loads((AOI / "aoi.json").read_text(encoding="utf-8"))
        grid_hash = fingerprint({
            "aoi": AOI_NAME,
            "source_directory": str(AOI.relative_to(ROOT)),
            "resolution_m": aoi_resolution,
            "shape": aoi_shape,
            "built_utc": aoi_metadata.get("built_utc"),
        })
        validate_tree_placements(trees, baseline_landcover, aoi_resolution)
        reflective_mask, reflective_snapshot = decode_raster_mask(request.get("reflective_pavement"), aoi_shape, "Reflective pavement")
        invalid_reflective_pixels = int(np.count_nonzero(reflective_mask & ~baseline_pavement))
        if invalid_reflective_pixels:
            reflective_mask &= baseline_pavement
            reflective_snapshot = encode_raster_mask(reflective_mask)
            reflective_snapshot["clipped_invalid_pixels"] = invalid_reflective_pixels
        depaved_mask, depaved_snapshot = decode_raster_mask(request.get("depaved_pavement"), aoi_shape, "Pavement to grass")
        eligibility_path = GUI_ROOT / "public" / "data" / AOI_NAME / "depavable_mask.png"
        if not eligibility_path.exists():
            raise FileNotFoundError("Missing offline pavement-to-grass eligibility mask; export the GUI layers first")
        depavable = np.asarray(Image.open(eligibility_path).convert("L")) >= 128
        if depavable.shape != aoi_shape:
            raise ValueError("Pavement-to-grass eligibility mask is not aligned with the AOI")
        depavable &= baseline_pavement
        invalid_depaved_pixels = int(np.count_nonzero(depaved_mask & ~depavable))
        if invalid_depaved_pixels:
            depaved_mask &= depavable
            depaved_snapshot = encode_raster_mask(depaved_mask)
            depaved_snapshot["clipped_invalid_pixels"] = invalid_depaved_pixels
        shade_canopy_mask, shade_canopy_snapshot = decode_raster_mask(request.get("shade_canopy"), aoi_shape, "Shade canopy")
        invalid_shade_canopy_pixels = int(np.count_nonzero(shade_canopy_mask & ~depavable))
        if invalid_shade_canopy_pixels:
            shade_canopy_mask &= depavable
            shade_canopy_snapshot = encode_raster_mask(shade_canopy_mask)
            shade_canopy_snapshot["clipped_invalid_pixels"] = invalid_shade_canopy_pixels
        solar_canopy_mask, solar_canopy_snapshot = decode_raster_mask(request.get("solar_canopy"), aoi_shape, "Solar canopy")
        invalid_solar_canopy_pixels = int(np.count_nonzero(solar_canopy_mask & ~depavable))
        if invalid_solar_canopy_pixels:
            solar_canopy_mask &= depavable
            solar_canopy_snapshot = encode_raster_mask(solar_canopy_mask)
            solar_canopy_snapshot["clipped_invalid_pixels"] = invalid_solar_canopy_pixels
        cool_roof_mask, cool_roof_snapshot = decode_raster_mask(request.get("cool_roof"), aoi_shape, "Cool roof")
        invalid_cool_roof_pixels = int(np.count_nonzero(cool_roof_mask & ~baseline_buildings))
        if invalid_cool_roof_pixels:
            cool_roof_mask &= baseline_buildings
            cool_roof_snapshot = encode_raster_mask(cool_roof_mask)
            cool_roof_snapshot["clipped_invalid_pixels"] = invalid_cool_roof_pixels
        green_roof_mask, green_roof_snapshot = decode_raster_mask(request.get("green_roof"), aoi_shape, "Green roof")
        invalid_green_roof_pixels = int(np.count_nonzero(green_roof_mask & ~baseline_buildings))
        if invalid_green_roof_pixels:
            green_roof_mask &= baseline_buildings
            green_roof_snapshot = encode_raster_mask(green_roof_mask)
            green_roof_snapshot["clipped_invalid_pixels"] = invalid_green_roof_pixels
        overlapping_roof_pixels = int(np.count_nonzero(cool_roof_mask & green_roof_mask))
        if overlapping_roof_pixels:
            raise ValueError(f"Cool- and green-roof treatments overlap on {overlapping_roof_pixels} pixels")
        overlapping_pavement_pixels = int(np.count_nonzero(reflective_mask & depaved_mask))
        if overlapping_pavement_pixels:
            raise ValueError(f"Reflective pavement and pavement-to-grass conversion overlap on {overlapping_pavement_pixels} pixels")
        overlapping_canopy_pixels = int(np.count_nonzero(shade_canopy_mask & solar_canopy_mask))
        if overlapping_canopy_pixels:
            raise ValueError(f"Fabric and solar canopy treatments overlap on {overlapping_canopy_pixels} pixels")
        if mode == "comparison" and not trees and not reflective_mask.any() and not cool_roof_mask.any() and not green_roof_mask.any() and not depaved_mask.any() and not shade_canopy_mask.any() and not solar_canopy_mask.any():
            raise ValueError("At least one tree, valid pavement treatment, or valid roof treatment is required for a full simulation")
        scenario = str(request.get("scenario", "baseline"))
        if scenario not in {"baseline", "warm_2c", "warm_4c", "humid_warm_2c"}:
            raise ValueError(f"Unsupported weather scenario: {scenario}")
        date = str(request.get("date", "07-27"))
        hour = int(request.get("hour", 15))
        epw, weather = select_weather(scenario, date, hour)
        location = solweig.Location.from_epw(str(epw))
        geometry_hash = fingerprint({"version": GEOMETRY_VERSION, "grid_hash": grid_hash, "trees": trees})
        layout_hash = fingerprint({
            "physics_version": PHYSICS_VERSION,
            "grid_hash": grid_hash,
            "aoi": AOI_NAME,
            "geometry_hash": geometry_hash,
            "reflective_pavement": reflective_snapshot["data"],
            "cool_roof": cool_roof_snapshot["data"],
            "green_roof": green_roof_snapshot["data"],
            "depaved_pavement": depaved_snapshot["data"],
            "shade_canopy": shade_canopy_snapshot["data"],
            "solar_canopy": solar_canopy_snapshot["data"],
        })
        forcing_hash = fingerprint({"physics_version": PHYSICS_VERSION, "grid_hash": grid_hash, "scenario": scenario, "date": date, "hour": hour})

        baseline_tmrt, baseline_utci = run_surface(
            cdsm=AOI / "cdsm.tif",
            tdsm=None,
            landcover=AOI / "landcover.tif",
            cache_dir=RUNS / "cache" / AOI_NAME / grid_hash / "baseline_surface",
            output_dir=RUNS / "cache" / AOI_NAME / grid_hash / "baseline_results" / forcing_hash,
            weather=weather,
            location=location,
            status=status,
            progress_start=3,
            progress_end=90 if mode == "baseline" else 42,
            stage="existing conditions",
        )

        if mode == "baseline":
            status.update("running", "Preparing baseline map", 94)
            baseline_metrics = {
                "mrt": baseline_metric_summary(baseline_tmrt),
                "utci": baseline_metric_summary(baseline_utci, perceived_temperature_domain),
            }
            baseline = export_stable_baseline(
                AOI_NAME,
                scenario,
                date,
                hour,
                baseline_tmrt,
                baseline_utci,
                baseline_metrics,
            )
            result = {
                "kind": "baseline",
                "id": run_id,
                "state": "complete",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "baseline": baseline,
            }
            atomic_json(job_dir / "result.json", result)
            status.update("complete", "Baseline ready", 100, result=result)
            return

        status.update("running", "Applying proposed interventions", 45)
        if trees:
            inputs_dir = RUNS / "cache" / AOI_NAME / grid_hash / "layouts" / geometry_hash / "inputs"
            proposed_cdsm, proposed_landcover = apply_tree_geometry(trees, inputs_dir)
        else:
            proposed_cdsm = AOI / "cdsm.tif"
            proposed_landcover = AOI / "landcover.tif"
        proposed_tdsm: Path | None = None
        if shade_canopy_mask.any() or solar_canopy_mask.any():
            proposed_cdsm, proposed_tdsm, physical_shade_canopy_mask, physical_solar_canopy_mask = apply_combined_canopy_geometry(
                proposed_cdsm,
                shade_canopy_mask,
                solar_canopy_mask,
                RUNS / "cache" / AOI_NAME / grid_hash / "layouts" / layout_hash / "inputs",
            )
        else:
            physical_shade_canopy_mask = shade_canopy_mask
            physical_solar_canopy_mask = solar_canopy_mask
        if depaved_mask.any():
            proposed_landcover = apply_depaving_landcover(
                proposed_landcover,
                depaved_mask,
                RUNS / "cache" / AOI_NAME / grid_hash / "layouts" / layout_hash / "inputs",
            )
            with rasterio.open(proposed_landcover) as proposed_landcover_source:
                depaved_material_mask = depaved_mask & (proposed_landcover_source.read(1) == 5)
        else:
            depaved_material_mask = depaved_mask
        proposed_surface_cache = RUNS / "cache" / AOI_NAME / grid_hash / "layouts" / layout_hash / "surface"
        intervention_tmrt, intervention_utci = run_surface(
            cdsm=proposed_cdsm,
            tdsm=proposed_tdsm,
            landcover=proposed_landcover,
            cache_dir=proposed_surface_cache,
            output_dir=RUNS / "cache" / AOI_NAME / grid_hash / "layout_results" / layout_hash / forcing_hash,
            weather=weather,
            location=location,
            status=status,
            progress_start=47,
            progress_end=91,
            stage="combined intervention",
            reflective_mask=reflective_mask,
            cool_roof_mask=cool_roof_mask,
            green_roof_mask=green_roof_mask,
            depaved_mask=depaved_material_mask,
        )

        status.update("running", "Preparing map results", 94)
        nearby = local_mask(baseline_tmrt.shape, trees, aoi_resolution)
        nearby |= reflective_mask
        nearby |= surrounding_mask(cool_roof_mask | green_roof_mask, aoi_resolution)
        nearby |= surrounding_mask(depaved_mask, aoi_resolution)
        nearby |= surrounding_mask(shade_canopy_mask, aoi_resolution)
        nearby |= surrounding_mask(solar_canopy_mask, aoi_resolution)
        metrics = {
            "mrt": metric_summary(baseline_tmrt, intervention_tmrt, nearby),
            "utci": metric_summary(
                baseline_utci,
                intervention_utci,
                nearby,
                perceived_temperature_domain,
            ),
        }
        public_dir = PUBLIC / run_id
        encode_metrics(public_dir / "baseline.png", baseline_tmrt, baseline_utci, metrics)
        encode_metrics(public_dir / "intervention.png", intervention_tmrt, intervention_utci, metrics)
        export_stable_baseline(AOI_NAME, scenario, date, hour, baseline_tmrt, baseline_utci, metrics)
        result = {
            "kind": "comparison",
            "id": run_id,
            "state": "complete",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "model": f"SOLWEIG {getattr(solweig, '__version__', 'unknown')}",
            "physics_version": PHYSICS_VERSION,
            "aoi": AOI_NAME,
            "scenario": scenario,
            "date": date,
            "hour": hour,
            "tree_snapshot": trees,
            "reflective_snapshot": reflective_snapshot,
            "cool_roof_snapshot": cool_roof_snapshot,
            "green_roof_snapshot": green_roof_snapshot,
            "depaved_pavement_snapshot": depaved_snapshot,
            "shade_canopy_snapshot": shade_canopy_snapshot,
            "solar_canopy_snapshot": solar_canopy_snapshot,
            "shade_canopy_physics": {
                "requested_pixels": int(shade_canopy_mask.sum()),
                "physical_shading_pixels": int(physical_shade_canopy_mask.sum()),
                "height_m": SHADE_CANOPY_HEIGHT_M,
                "bottom_m": SHADE_CANOPY_BOTTOM_M,
                "transmission_method": "50/50 shaded-and-open CDSM footprint; shaded cells retain normal leaf-on transmissivity",
            },
            "solar_canopy_physics": {
                "requested_pixels": int(solar_canopy_mask.sum()),
                "physical_shading_pixels": int(physical_solar_canopy_mask.sum()),
                "height_m": SOLAR_CANOPY_HEIGHT_M,
                "bottom_m": SOLAR_CANOPY_BOTTOM_M,
                "transmission_method": "full CDSM footprint using shared leaf-on transmissivity; maximum-opacity walkable overhead representation",
            },
            "layout_hash": layout_hash,
            "mean_domains": {
                "mrt": "all valid AOI cells",
                "utci": "all valid AOI cells except baseline building roofs",
                "utci_cell_count": int(perceived_temperature_domain.sum()),
            },
            "metrics": metrics,
            "files": {
                "baseline": f"/data/{AOI_NAME}/simulations/{run_id}/baseline.png",
                "intervention": f"/data/{AOI_NAME}/simulations/{run_id}/intervention.png",
            },
        }
        atomic_json(public_dir / "result.json", result)
        atomic_json(job_dir / "result.json", result)
        status.update("complete", "Simulation complete", 100, result=result)
    except Exception as error:
        status.update("failed", "Simulation failed", 100, error=str(error))
        raise


if __name__ == "__main__":
    main()
