"""Export a built AOI raster stack as aligned, browser-friendly PNG layers.

The GeoTIFFs in ``data/aoi`` remain the scientific source of truth. This script
creates lightweight display products under ``gui/public/data`` for the local GUI.

    .venv/bin/python gui/scripts/export_gui_layers.py --aoi chinatown --res 1
    .venv/bin/python gui/scripts/export_gui_layers.py --all --res 1
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import geopandas as gpd
import numpy as np
from PIL import Image
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import box

GUI_ROOT = Path(__file__).resolve().parents[1]
ROOT = GUI_ROOT.parent
CONFIG = ROOT / "config"
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import siting  # noqa: E402

GROUND_CODES = (1, 3, 4, 5, 6)


def load_aoi_config() -> dict:
    return json.loads((CONFIG / "aois.json").read_text(encoding="utf-8"))["aois"]


def source_directory(aoi: str, resolution: float) -> Path:
    """Find a built AOI by its metadata rather than assuming a suffix scheme."""
    candidates = [ROOT / "data" / "aoi" / aoi, ROOT / "data" / "aoi" / f"{aoi}_{resolution:g}m"]
    for candidate in candidates:
        metadata_path = candidate / "aoi.json"
        if not metadata_path.exists():
            continue
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if abs(float(metadata["resolution_m"]) - resolution) < 1e-9:
            return candidate
    raise FileNotFoundError(f"No {resolution:g} m build found for {aoi}")

def read(path: Path) -> tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        return src.read(1), src.profile


def colorize(values: np.ndarray, stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    normalized = np.clip(values, 0.0, 1.0)
    positions = np.asarray([stop[0] for stop in stops], dtype="float32")
    colors = np.asarray([stop[1] for stop in stops], dtype="float32")
    channels = [np.interp(normalized, positions, colors[:, i]) for i in range(3)]
    return np.stack(channels, axis=-1).astype("uint8")


def save_rgba(path: Path, rgba: np.ndarray) -> None:
    Image.fromarray(rgba.astype("uint8"), "RGBA").save(path, optimize=True)


def save_mask(path: Path, mask: np.ndarray) -> None:
    """Write a boolean policy mask in the format consumed by the browser."""
    Image.fromarray(mask.astype("uint8") * 255, "L").save(path, optimize=True)


def action_placeable_masks(
    landcover: np.ndarray,
    siting_masks: "siting.SitingMasks",
) -> dict[str, np.ndarray]:
    """Mirror ``PlanningContext.placeable`` without loading scoring demographics.

    These files are the editor's feasibility contract.  Keeping the land-cover
    eligibility and ``config/siting.json`` rules together here prevents the GUI
    from offering pixels that the scorer will reject later.
    """
    interventions = json.loads(
        (CONFIG / "interventions.json").read_text(encoding="utf-8")
    )["interventions"]
    masks: dict[str, np.ndarray] = {}
    for action, spec in interventions.items():
        codes = spec.get("applies_to_landcover") or GROUND_CODES
        masks[action] = np.isin(landcover, list(codes)) & siting_masks.allowed(action)
    return masks


def export_street_segments(path: Path, streets: gpd.GeoDataFrame, bbox: list[float], resolution: float) -> int:
    """Export clipped street centre-lines in raster pixel coordinates."""
    minx, miny, maxx, maxy = bbox
    boundary = box(minx, miny, maxx, maxy)
    segments = []
    def text_field(feature, field: str) -> str:
        value = feature.get(field)
        return "" if value is None or str(value).lower() == "nan" else str(value).strip()

    for _, feature in streets.iterrows():
        geometry = feature.geometry.intersection(boundary)
        if geometry.is_empty:
            continue
        lines = list(geometry.geoms) if geometry.geom_type == "MultiLineString" else [geometry]
        paths = [
            [[round((x - minx) / resolution, 2), round((maxy - y) / resolution, 2)] for x, y in line.coords]
            for line in lines
            if line.geom_type == "LineString" and len(line.coords) > 1
        ]
        if paths:
            segments.append({
                "id": int(feature["SEGMENT_ID"]),
                "name": " ".join(filter(None, (text_field(feature, field) for field in ("PRE_DIR", "ST_NAME", "ST_TYPE", "SUF_DIR")))) or "Unnamed street",
                "paths": paths,
            })
    path.write_text(json.dumps({"segments": segments}, separators=(",", ":")) + "\n")
    return len(segments)


def geometry_mask(geometries, shape: tuple[int, int], transform) -> np.ndarray:
    valid = (geometry for geometry in geometries if geometry is not None and not geometry.is_empty)
    return rasterize(
        ((geometry, 1) for geometry in valid),
        out_shape=shape,
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)


def export_depavable_mask(
    path: Path,
    vectors: dict[str, gpd.GeoDataFrame],
    landcover: np.ndarray,
    transform,
) -> dict[str, int]:
    """Export paved, non-road pixels suitable for conversion to grass.

    Boston's local files include street and sidewalk centre-lines, but not road
    edge widths or a complete parking-lot polygon layer.  We therefore exclude
    conservative street corridors by CFCC road class, restore mapped sidewalk
    corridors, and retain paved pixels in mapped open spaces plus other paved
    land outside the road corridors (principally plazas and parking areas).
    The final land-cover-class-1 intersection prevents the derived vectors from
    making buildings, water, or existing vegetation selectable.
    """
    roadway_buffers = []
    for _, feature in vectors["streets"].iterrows():
        cfcc = str(feature.get("CFCC") or "")
        half_width_m = 14.0 if cfcc.startswith("A1") else 9.0 if cfcc.startswith("A2") else 5.25
        roadway_buffers.append(feature.geometry.buffer(half_width_m))

    roadway = geometry_mask(roadway_buffers, landcover.shape, transform)
    sidewalks = geometry_mask(
        vectors["sidewalks"].geometry.buffer(1.8), landcover.shape, transform
    )
    open_space = geometry_mask(
        vectors["open_space"].geometry, landcover.shape, transform
    )
    pavement = landcover == 1
    eligible = pavement & ((~roadway) | sidewalks | open_space)
    Image.fromarray(eligible.astype("uint8") * 255, "L").save(path, optimize=True)
    return {
        "eligible_pixels": int(eligible.sum()),
        "mapped_sidewalk_pixels": int((pavement & sidewalks).sum()),
        "mapped_open_space_pixels": int((pavement & open_space).sum()),
        "excluded_road_pixels": int((pavement & roadway & ~sidewalks & ~open_space).sum()),
    }


def export_roof_regions(
    path: Path,
    buildings: gpd.GeoDataFrame,
    landcover: np.ndarray,
    transform,
    placeable: np.ndarray,
) -> tuple[int, int, int]:
    """Encode selectable whole-building roof IDs as 24-bit RGB pixels."""
    regions = rasterize(
        (
            (geometry, index)
            for index, geometry in enumerate(buildings.geometry, start=1)
            if geometry is not None and not geometry.is_empty
        ),
        out_shape=landcover.shape,
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="int32",
    )
    building_pixels = landcover == 2
    regions[~building_pixels] = 0

    # Retain every land-cover building even where the older vector footprint
    # does not overlap perfectly; each connected remainder becomes one roof.
    missing = building_pixels & (regions == 0)
    missing_labels, missing_count = ndimage.label(
        missing,
        structure=np.asarray([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype="uint8"),
    )
    if missing_count:
        missing_labels[missing_labels > 0] += len(buildings)
        regions[missing] = missing_labels[missing]

    # Roof tools operate on whole buildings.  If even one pixel of a building
    # falls in a design-review exclusion, remove the complete region from the
    # selection image so a click/brush can never create a partial illegal roof.
    invalid_region_ids = np.unique(regions[(regions > 0) & ~placeable])
    if invalid_region_ids.size:
        regions[np.isin(regions, invalid_region_ids)] = 0

    rgba = np.zeros((*landcover.shape, 4), dtype="uint8")
    rgba[..., 0] = regions & 255
    rgba[..., 1] = (regions >> 8) & 255
    rgba[..., 2] = (regions >> 16) & 255
    rgba[..., 3] = np.where(regions > 0, 255, 0).astype("uint8")
    save_rgba(path, rgba)
    eligible_pixels = int((regions > 0).sum())
    return (
        int(np.unique(regions[regions > 0]).size),
        eligible_pixels,
        int(building_pixels.sum()) - eligible_pixels,
    )


def read_local_vectors(bbox: list[float]) -> dict[str, gpd.GeoDataFrame]:
    """Read only features touching an AOI, returning everything in the map CRS."""
    minx, miny, maxx, maxy = bbox
    to_wgs84 = Transformer.from_crs("EPSG:26986", "EPSG:4326", always_xy=True)
    corners = [to_wgs84.transform(x, y) for x, y in ((minx, miny), (maxx, maxy))]
    bbox_wgs84 = (
        min(point[0] for point in corners),
        min(point[1] for point in corners),
        max(point[0] for point in corners),
        max(point[1] for point in corners),
    )
    files = {
        "buildings": "zip://" + str(ROOT / "data/boston/buildings_roof_breaks_geojson.zip"),
        "streets": str(ROOT / "data/boston/street_segments_sam.geojson"),
        "sidewalks": "zip://" + str(ROOT / "data/boston/sidewalk_centerline_geojson.zip"),
        "open_space": str(ROOT / "data/boston/open_space.geojson"),
    }
    return {
        name: gpd.read_file(path, bbox=bbox_wgs84).to_crs("EPSG:26986")
        for name, path in files.items()
    }


def render_vector_base(
    vectors: dict[str, gpd.GeoDataFrame], dsm: np.ndarray, profile: dict
) -> np.ndarray:
    """Render a quiet, independent city-map base from Boston vector layers."""
    shape = dsm.shape
    transform = profile["transform"]
    base = np.empty((*shape, 4), dtype="uint8")
    base[:] = (235, 232, 224, 255)

    open_space = geometry_mask(vectors["open_space"].geometry, shape, transform)
    sidewalk = geometry_mask(vectors["sidewalks"].geometry.buffer(0.85), shape, transform)
    street_casing = geometry_mask(vectors["streets"].geometry.buffer(5.5), shape, transform)
    street_fill = geometry_mask(vectors["streets"].geometry.buffer(4.25), shape, transform)
    buildings = geometry_mask(vectors["buildings"].geometry, shape, transform)

    base[open_space] = (218, 229, 202, 255)
    base[sidewalk] = (224, 220, 210, 255)
    base[street_casing] = (203, 198, 187, 255)
    base[street_fill] = (221, 217, 207, 255)

    # A small southeast shadow plus DSM shading preserves the readable building
    # structure when translucent analytical layers are placed above the base.
    shadow = np.zeros_like(buildings)
    shadow[3:, 3:] = buildings[:-3, :-3]
    shadow &= ~buildings
    base[shadow, :3] = (187, 184, 177)
    base[buildings] = (246, 242, 233, 255)

    valid_dsm = dsm > -9000
    filled_dsm = np.where(valid_dsm, dsm, np.nanmedian(dsm[valid_dsm]))
    gy, gx = np.gradient(filled_dsm.astype("float32"))
    shade = np.clip(1.0 - (gx * -0.55 + gy * 0.85) * 0.022, 0.84, 1.06)
    base[buildings, :3] = np.clip(
        base[buildings, :3] * shade[buildings, None], 0, 255
    ).astype("uint8")
    return base


def export(aoi: str, resolution: float) -> None:
    source = source_directory(aoi, resolution)
    target = GUI_ROOT / "public" / "data" / aoi
    target.mkdir(parents=True, exist_ok=True)

    landcover, profile = read(source / "landcover.tif")
    dsm, _ = read(source / "dsm.tif")
    cdsm, _ = read(source / "cdsm.tif")
    heat, _ = read(source / "heat_ta3pm.tif")
    metadata = json.loads((source / "aoi.json").read_text())
    intervention_menu = json.loads(
        (CONFIG / "interventions.json").read_text(encoding="utf-8")
    )["interventions"]

    strict_siting = siting.build(
        tuple(metadata["bbox_26986"]),
        float(metadata["resolution_m"]),
        landcover.shape,
        landcover,
        np.nan_to_num(cdsm, nan=0.0),
    )
    placeable = action_placeable_masks(landcover, strict_siting)

    vectors = read_local_vectors(metadata["bbox_26986"])
    base = render_vector_base(vectors, dsm, profile)
    save_rgba(target / "base.png", base)

    # This is a complement to the vector base, not a replacement for it.
    # Buildings and canopy stay transparent so building relief and the separate
    # canopy-height layer remain legible. Grass and soil share one class color.
    overlay = np.zeros((*landcover.shape, 4), dtype="uint8")
    overlay[landcover == 1] = (151, 147, 137, 105)  # paved
    overlay[np.isin(landcover, (5, 6))] = (116, 157, 91, 120)  # grass / soil
    overlay[landcover == 7] = (72, 142, 173, 145)  # water
    save_rgba(target / "landcover.png", overlay)

    # The physical crown-footprint check is intentionally separate from the
    # policy-valid centre pixels.  A tree centre must pass both in the browser.
    physical_tree_footprint = ~np.isin(landcover, (2, 7)) & (landcover > 0)
    save_mask(target / "tree_placement_mask.png", physical_tree_footprint)
    editor_placeable_counts: dict[str, int] = {}
    for action in ("tree_small", "tree_medium", "light_road", "grass_conversion", "shade_canopy", "solar_canopy"):
        mask = placeable[action]
        save_mask(target / f"placeable_{action}.png", mask)
        editor_placeable_counts[action] = int(mask.sum())

    # Preserve legacy filenames for old clients while making their contents
    # authoritative rather than heuristic.
    save_mask(target / "pavement_mask.png", placeable["light_road"])
    save_mask(target / "depavable_mask.png", placeable["grass_conversion"])
    depavable_summary = {
        "eligible_pixels": int(placeable["grass_conversion"].sum()),
        "source": "PlanningContext.placeable('grass_conversion')",
    }
    roof_count, roof_pixel_count, roof_excluded_pixel_count = export_roof_regions(
        target / "roof_regions.png",
        vectors["buildings"],
        landcover,
        profile["transform"],
        placeable["cool_roof"] & placeable["green_roof"],
    )
    street_count = export_street_segments(
        target / "street_segments.json",
        vectors["streets"],
        metadata["bbox_26986"],
        float(metadata["resolution_m"]),
    )

    canopy = np.zeros((*cdsm.shape, 4), dtype="uint8")
    canopy_mask = cdsm > 0
    canopy_height = np.clip(cdsm / 25.0, 0, 1)
    canopy[..., :3] = colorize(canopy_height, [(0, (93, 154, 92)), (1, (22, 78, 49))])
    canopy[..., 3] = np.where(canopy_mask, 215, 0).astype("uint8")
    save_rgba(target / "canopy.png", canopy)

    heat_valid = heat > -9000
    low, high = (float(np.nanpercentile(heat[heat_valid], q)) for q in (2, 98))
    heat_norm = np.clip((heat - low) / max(high - low, 1e-6), 0, 1)
    heat_rgba = np.zeros((*heat.shape, 4), dtype="uint8")
    heat_rgba[..., :3] = colorize(
        heat_norm,
        [(0, (53, 104, 151)), (0.35, (115, 174, 157)), (0.58, (241, 214, 126)), (0.8, (224, 125, 82)), (1, (151, 54, 62))],
    )
    heat_rgba[..., 3] = np.where(heat_valid, 190, 0).astype("uint8")
    save_rgba(target / "heat_ta3pm.png", heat_rgba)

    # Three continuous screening fields used by the browser-only early estimate.
    # They are deliberately encoded as normalized scalar channels rather than
    # presentation colors so the GUI can render a baseline and recompute an
    # intervention raster for the current tree layout. These are not SOLWEIG
    # outputs: the City air-temperature pattern supplies spatial variation and
    # land-cover classes provide coarse surface-dependent adjustments.
    screening_valid = heat > 0
    air_pattern = np.clip((heat - low) / max(high - low, 1e-6), 0, 1)
    mrt = 48.0 + 18.0 * air_pattern
    utci = 30.0 + 9.0 * air_pattern
    surface = 31.0 + 13.0 * air_pattern

    mrt += np.select(
        [landcover == 1, landcover == 2, np.isin(landcover, (3, 4)), landcover == 5, landcover == 7],
        [2.5, 1.5, -5.0, -1.0, -3.0],
        default=0.0,
    )
    utci += np.select(
        [landcover == 1, landcover == 2, np.isin(landcover, (3, 4)), landcover == 5, landcover == 7],
        [0.7, 0.4, -1.5, -0.4, -1.0],
        default=0.0,
    )
    surface += np.select(
        [landcover == 1, landcover == 2, np.isin(landcover, (3, 4)), landcover == 5, landcover == 6, landcover == 7],
        [6.0, 8.0, -6.0, -2.0, 2.0, -5.0],
        default=0.0,
    )

    screening_ranges = {
        "mrt": {"display_min": 42.0, "display_max": 69.0, "label": "Mean radiant temperature"},
        "utci": {"display_min": 28.0, "display_max": 41.0, "label": "UTCI / perceived temperature"},
        "surface": {"display_min": 25.0, "display_max": 53.0, "label": "Surface temperature"},
    }
    screening = np.zeros((*heat.shape, 4), dtype="uint8")
    for channel, (key, values) in enumerate((("mrt", mrt), ("utci", utci), ("surface", surface))):
        metric_range = screening_ranges[key]
        normalized = np.clip(
            (values - metric_range["display_min"])
            / (metric_range["display_max"] - metric_range["display_min"]),
            0,
            1,
        )
        screening[..., channel] = np.round(normalized * 255).astype("uint8")
    screening[..., 3] = np.where(screening_valid, 255, 0).astype("uint8")
    save_rgba(target / "screening_metrics.png", screening)

    aoi_config = load_aoi_config().get(aoi, {})
    manifest = {
        "aoi": aoi,
        "label": aoi_config.get("label", aoi.replace("_", " ").title()),
        "split": aoi_config.get("split", "unknown"),
        "crs": metadata["crs"],
        "bbox": metadata["bbox_26986"],
        "width": int(profile["width"]),
        "height": int(profile["height"]),
        "resolution_m": metadata["resolution_m"],
        "interventions": {
            action: {
                "label": spec["label"],
                "unit": spec["unit"],
                "cost_usd_per_unit": spec["cost_usd_per_unit"],
            }
            for action, spec in intervention_menu.items()
        },
        "source_directory": str(source.relative_to(ROOT)),
        "built_utc": metadata["built_utc"],
        "heat_ta3pm_c": {
            "display_min": round(low, 2),
            "display_max": round(high, 2),
            "data_min": round(float(heat[heat_valid].min()), 2),
            "data_max": round(float(heat[heat_valid].max()), 2),
        },
        "screening_metrics": {
            "file": "screening_metrics.png",
            "approximate": True,
            "basis": "City 3 PM air-temperature pattern with coarse land-cover adjustments; not SOLWEIG output",
            "metrics": screening_ranges,
        },
        "summary_masks": {
            "perceived_temperature": "all valid AOI cells except land-cover class 2 building roofs",
            "perceived_temperature_pixels": int(np.count_nonzero(landcover != 2)),
            "excluded_building_roof_pixels": int(np.count_nonzero(landcover == 2)),
        },
        "layers": {
            "base": "base.png",
            "landcover": "landcover.png",
            "canopy": "canopy.png",
            "heat": "heat_ta3pm.png",
            "tree_placement_mask": "tree_placement_mask.png",
            "tree_small_placeable_mask": "placeable_tree_small.png",
            "tree_medium_placeable_mask": "placeable_tree_medium.png",
            "pavement_mask": "pavement_mask.png",
            "depavable_mask": "depavable_mask.png",
            "shade_canopy_placeable_mask": "placeable_shade_canopy.png",
            "solar_canopy_placeable_mask": "placeable_solar_canopy.png",
            "street_segments": "street_segments.json",
            "roof_regions": "roof_regions.png",
        },
        "layer_sources": {
            "base": [
                {"file": "data/boston/buildings_roof_breaks_geojson.zip", "features_in_aoi": len(vectors["buildings"])},
                {"file": "data/boston/street_segments_sam.geojson", "features_in_aoi": len(vectors["streets"])},
                {"file": "data/boston/sidewalk_centerline_geojson.zip", "features_in_aoi": len(vectors["sidewalks"])},
                {"file": "data/boston/open_space.geojson", "features_in_aoi": len(vectors["open_space"])},
                {"file": f"{source.relative_to(ROOT)}/dsm.tif", "use": "building relief only"},
            ],
            "landcover": {
                "file": f"{source.relative_to(ROOT)}/landcover.tif",
                "visible_classes": ["pavement", "grass/soil", "water"],
                "transparent_classes": ["buildings", "canopy"],
            },
            "reflective_pavement": {
                "placement_mask": "PlanningContext.placeable('light_road')",
                "street_segments": street_count,
            },
            "depaving": {
                "placement_mask": "PlanningContext.placeable('grass_conversion')",
                "method": "land-cover eligibility plus config/siting.json roadbed and crossing rules",
                **depavable_summary,
            },
            "cool_roof": {
                "building_footprints": "data/boston/buildings_roof_breaks_geojson.zip",
                "eligible_mask": f"{source.relative_to(ROOT)}/landcover.tif class 2",
                "selectable_roofs": roof_count,
                "eligible_pixels": roof_pixel_count,
                "excluded_design_review_or_partial_building_pixels": roof_excluded_pixel_count,
            },
            "strict_feasibility": {
                "rules": "config/siting.json",
                "policy_placeable_pixels": {action: int(mask.sum()) for action, mask in placeable.items()},
                "editor_placeable_pixels": editor_placeable_counts,
                "note": "Every editor mask is PlanningContext.placeable(), or a stricter subset where the studio intentionally limits canopies to pavement and roof tools to whole buildings.",
            },
            "canopy": {
                "file": f"{source.relative_to(ROOT)}/cdsm.tif",
                "crowns_painted": metadata["cdsm_build"]["crowns_painted"],
            },
            "heat": {
                "file": f"{source.relative_to(ROOT)}/heat_ta3pm.tif",
                "source": metadata["sources"]["heat_ta3pm"],
                "units": "degrees C",
            },
        },
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"exported {aoi} GUI layers -> {target}")


def _polygon_paths(geometry, bounds: tuple[float, float, float, float]) -> list[list[list[float]]]:
    minx, miny, maxx, maxy = bounds
    scale = 1000.0 / max(maxx - minx, maxy - miny)
    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    paths = []
    for polygon in polygons:
        coordinates = [
            [round((x - minx) * scale, 2), round((maxy - y) * scale, 2)]
            for x, y in polygon.exterior.coords
        ]
        if len(coordinates) > 3:
            paths.append(coordinates)
    return paths


def export_overview(resolution: float) -> None:
    """Write a compact Boston outline plus selectable configured AOI windows."""
    neighborhoods = gpd.read_file(ROOT / "data" / "boston" / "neighborhoods.geojson").to_crs("EPSG:26986")
    name_column = next(column for column in ("name", "Name", "BlockGr202", "neighborhood") if column in neighborhoods.columns)
    neighborhoods = neighborhoods[[name_column, "geometry"]].copy()
    neighborhoods["geometry"] = neighborhoods.geometry.simplify(18.0, preserve_topology=True)
    raw_bounds = tuple(float(value) for value in neighborhoods.total_bounds)
    pad = 450.0
    bounds = (raw_bounds[0] - pad, raw_bounds[1] - pad, raw_bounds[2] + pad, raw_bounds[3] + pad)
    minx, miny, maxx, maxy = bounds
    scale = 1000.0 / max(maxx - minx, maxy - miny)

    configured = load_aoi_config()
    areas = []
    for key, spec in configured.items():
        bbox = spec["bbox_26986"]
        manifest_path = GUI_ROOT / "public" / "data" / key / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
        areas.append({
            "id": key,
            "label": spec["label"],
            "split": spec["split"],
            "resolution_m": manifest.get("resolution_m") if manifest else resolution,
            "ready": bool(manifest and abs(float(manifest["resolution_m"]) - resolution) < 1e-9),
            "x": round((bbox[0] - minx) * scale, 2),
            "y": round((maxy - bbox[3]) * scale, 2),
            "width": round((bbox[2] - bbox[0]) * scale, 2),
            "height": round((bbox[3] - bbox[1]) * scale, 2),
            "heat_min_c": manifest.get("heat_ta3pm_c", {}).get("display_min") if manifest else None,
            "heat_max_c": manifest.get("heat_ta3pm_c", {}).get("display_max") if manifest else None,
        })

    payload = {
        "crs": "EPSG:26986",
        "resolution_m": resolution,
        "viewbox": [0, 0, round((maxx - minx) * scale, 2), round((maxy - miny) * scale, 2)],
        "neighborhoods": [
            {"name": str(row[name_column]), "paths": _polygon_paths(row.geometry, bounds)}
            for _, row in neighborhoods.iterrows()
            if row.geometry is not None and not row.geometry.is_empty
        ],
        "areas": areas,
    }
    target = GUI_ROOT / "public" / "data" / "study_areas.json"
    target.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"exported Boston study-area overview -> {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aoi")
    parser.add_argument("--all", action="store_true")
    configured_default = float(json.loads((CONFIG / "aois.json").read_text(encoding="utf-8")).get("default_res_m", 1.0))
    parser.add_argument("--res", type=float, default=configured_default)
    args = parser.parse_args()
    if not args.aoi and not args.all:
        parser.error("one of --aoi or --all is required")
    names = list(load_aoi_config()) if args.all else [args.aoi]
    for name in names:
        export(str(name), args.res)
    export_overview(args.res)


if __name__ == "__main__":
    main()
