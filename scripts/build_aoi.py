"""Build a SOLWEIG-ready raster stack for one Boston study area (AOI).

Pulls from live City of Boston / USGS image services plus the local land-cover
raster, and writes every grid on ONE grid in EPSG:26986 (MA State Plane Mainland,
metres) so SOLWEIG's shadow geometry is in metres.

The default resolution is 2 m, used for both search and final scoring: about 6x
cheaper per SOLWEIG evaluation than 1 m while still resolving street canyons and
crown-scale shade. Build at 1 m with --res 1 only to spot-check that a result is
not an artefact of the grid. See DATA_MANIFEST.md section 8.

    python scripts/build_aoi.py --aoi nubian_square      # 2 m (default)
    python scripts/build_aoi.py --aoi nubian_square --res 1
    python scripts/build_aoi.py --list
    python scripts/build_aoi.py --neighborhood Roxbury

Outputs (data/aoi/<name>/):
    dsm.tif          ground + buildings, metres AMSL   -> SOLWEIG `dsm`
    dem.tif          bare earth, metres AMSL           -> SOLWEIG `dem`
    cdsm.tif         canopy height above ground, m     -> SOLWEIG `cdsm`
    landcover.tif    UMEP class codes                  -> SOLWEIG `landcover`
    dsm_raw.tif      unedited photogrammetric surface (provenance / QA)
    heat_ta3pm.tif   modelled 3 PM air temperature, degC
    heat_ta3am.tif   modelled 3 AM air temperature, degC
    heat_hours.tif   annual heat-event hours
    heat_uhii.tif    urban heat island intensity, degC
    aoi.json         bbox, CRS, resolution, source URLs, build timestamp
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
from pathlib import Path

# conda's GDAL data files are not on PATH when the interpreter is invoked
# directly rather than through `conda activate`.
_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)
# SOLWEIG logs a Unicode check mark that the Windows cp1252 console cannot encode.
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG = ROOT / "config"

# Working CRS: NAD83 / Massachusetts Mainland (metres). SOLWEIG needs metric x/y.
CRS = "EPSG:26986"
FT_TO_M = 0.3048

# The Nearmap DSM is horizontally in EPSG:2249 (feet) but its *values* are metres
# -- checked against 3DEP over paved ground, where the two agree to ~0.3 m. The
# tree-canopy assessment layers are in feet for both position and height.

DSM_SERVICE = "https://gisportal.boston.gov/image/rest/services/dsm_geo_nearmap_2023/ImageServer"
DEM_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
HEAT_SERVICES = {
    "heat_ta3pm": "https://gisportal.boston.gov/image/rest/services/Daytime_Air_Temp_2024/ImageServer",
    "heat_ta3am": "https://gisportal.boston.gov/image/rest/services/Nighttime_Air_Temp_2024/ImageServer",
    "heat_hours": "https://gisportal.boston.gov/image/rest/services/Heat_Event_Hours_2024/ImageServer",
    "heat_uhii": "https://gisportal.boston.gov/image/rest/services/UHII_2024/ImageServer",
}
LANDCOVER_TIF = DATA / "canopy" / "2019-2024Data" / "landcover_2024_boston.tif"
TREE_CENTROIDS = DATA / "canopy" / "2019-2024Data" / "TreeCentroids2024.geojson"

# Boston 2024 high-resolution land cover -> UMEP / SOLWEIG land-cover codes.
# Boston: 1 tree canopy, 2 grass-shrub, 3 bare earth, 4 water, 5 buildings,
#         6 roads, 7 other paved, 0 background.
# UMEP:   1 paved, 2 buildings, 3 evergreen, 4 deciduous, 5 grass,
#         6 bare soil, 7 water.
BOSTON_TO_UMEP = {0: 1, 1: 4, 2: 5, 3: 6, 4: 7, 5: 2, 6: 1, 7: 1}

# Requests bigger than this (per axis) get tiled; services cap at 4100-8000 px.
MAX_PX = 4000

# Default pixel size in metres, used for search and final scoring alike. Changing
# this changes which directory counts as the default build (see the suffix logic
# in main()).
DEFAULT_RES = 2.0


# --------------------------------------------------------------------------- #
# AOI definitions
# --------------------------------------------------------------------------- #
def load_aois() -> dict:
    with open(CONFIG / "aois.json") as fh:
        return json.load(fh)


def neighborhood_bbox(name: str, buffer_m: float = 0.0) -> tuple:
    import geopandas as gpd

    gdf = gpd.read_file(DATA / "boston" / "neighborhoods.geojson").to_crs(CRS)
    col = next(c for c in ("name", "Name", "BlockGr202", "neighborhood") if c in gdf.columns)
    sel = gdf[gdf[col].str.lower() == name.lower()]
    if sel.empty:
        raise SystemExit(f"no neighborhood {name!r}; have: {sorted(gdf[col].unique())}")
    minx, miny, maxx, maxy = sel.total_bounds
    return (minx - buffer_m, miny - buffer_m, maxx + buffer_m, maxy + buffer_m)


def snap(bbox: tuple, res: float) -> tuple:
    minx, miny, maxx, maxy = bbox
    return (
        math.floor(minx / res) * res,
        math.floor(miny / res) * res,
        math.ceil(maxx / res) * res,
        math.ceil(maxy / res) * res,
    )


# --------------------------------------------------------------------------- #
# ArcGIS ImageServer -> numpy on our grid
# --------------------------------------------------------------------------- #
def export_image(service: str, bbox: tuple, width: int, height: int, retries: int = 4) -> np.ndarray:
    """One exportImage call, returned as a float32 array (nodata -> nan)."""
    params = {
        "bbox": ",".join(f"{v:.4f}" for v in bbox),
        "bboxSR": 26986,
        "imageSR": 26986,
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "noDataInterpretation": "esriNoDataMatchAny",
        "f": "image",
    }
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(service + "/exportImage", params=params, timeout=180)
            r.raise_for_status()
            if not r.content.startswith((b"II", b"MM")):
                raise RuntimeError(f"not a TIFF: {r.content[:200]!r}")
            with rasterio.open(io.BytesIO(r.content)) as src:
                arr = src.read(1).astype("float32")
                nod = src.nodata
            if nod is not None:
                arr[arr == nod] = np.nan
            arr[arr < -1e30] = np.nan
            return arr
        except Exception as exc:  # noqa: BLE001 - services flake under load
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"exportImage failed for {service}: {last}")


def fetch_grid(service: str, bbox: tuple, res: float, label: str) -> np.ndarray:
    """Fetch a whole AOI onto the target grid, tiling around service pixel caps."""
    minx, miny, maxx, maxy = bbox
    width = int(round((maxx - minx) / res))
    height = int(round((maxy - miny) / res))
    out = np.full((height, width), np.nan, dtype="float32")
    nx = math.ceil(width / MAX_PX)
    ny = math.ceil(height / MAX_PX)
    for iy in range(ny):
        for ix in range(nx):
            x0, x1 = ix * MAX_PX, min((ix + 1) * MAX_PX, width)
            y0, y1 = iy * MAX_PX, min((iy + 1) * MAX_PX, height)
            tile_bbox = (
                minx + x0 * res,
                maxy - y1 * res,
                minx + x1 * res,
                maxy - y0 * res,
            )
            print(f"    {label} tile {iy * nx + ix + 1}/{nx * ny} ({x1 - x0}x{y1 - y0})", flush=True)
            out[y0:y1, x0:x1] = export_image(service, tile_bbox, x1 - x0, y1 - y0)
    return out


def read_landcover(bbox: tuple, res: float) -> np.ndarray:
    """Nearest-neighbour resample of the local land-cover raster onto our grid."""
    if not LANDCOVER_TIF.exists():
        raise SystemExit(
            f"missing {LANDCOVER_TIF}\n"
            "unzip data/canopy/canopy_change_2019_2024.zip first (see DATA_MANIFEST.md)"
        )
    minx, miny, maxx, maxy = bbox
    width = int(round((maxx - minx) / res))
    height = int(round((maxy - miny) / res))
    dst = np.zeros((height, width), dtype="uint8")
    with rasterio.open(LANDCOVER_TIF) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=from_origin(minx, maxy, res, res),
            dst_crs=CRS,
            resampling=Resampling.nearest,
        )
    return dst


def build_cdsm(bbox: tuple, res: float, canopy_mask: np.ndarray) -> tuple:
    """Paint a canopy height model from the 2024 tree-crown inventory.

    The Nearmap surface model is effectively ground + buildings: only ~11% of
    land-cover canopy pixels sit more than 2 m above the terrain in it, so it
    cannot supply tree heights. The canopy-change assessment ships one point per
    detected crown with a height and a crown radius, which is a better source.
    Each crown becomes a flat-topped disc; canopy-class pixels no crown reaches
    are filled with the AOI's median crown height.
    """
    import geopandas as gpd

    minx, miny, maxx, maxy = bbox
    width = int(round((maxx - minx) / res))
    height = int(round((maxy - miny) / res))
    cdsm = np.zeros((height, width), dtype="float32")

    if not TREE_CENTROIDS.exists():
        print(f"    !! {TREE_CENTROIDS.name} missing - cdsm will be canopy-mask only")
        trees = None
    else:
        from pyproj import Transformer

        # read_file's bbox is read in the *file's* CRS, and the crown inventory
        # is EPSG:2249, so the AOI box has to be projected before filtering.
        pad = 30.0  # metres, so crowns straddling the edge still cast shade inward
        tx = Transformer.from_crs(CRS, "EPSG:2249", always_xy=True)
        x0, y0 = tx.transform(minx - pad, miny - pad)
        x1, y1 = tx.transform(maxx + pad, maxy + pad)
        trees = gpd.read_file(TREE_CENTROIDS, bbox=(x0, y0, x1, y1)).to_crs(CRS)

    n_painted = 0
    if trees is not None and len(trees):
        hcol = "Height" if "Height" in trees.columns else "height"
        rcol = "Radius" if "Radius" in trees.columns else "radius"
        hs = trees[hcol].astype(float).to_numpy() * FT_TO_M
        rs = trees[rcol].astype(float).to_numpy() * FT_TO_M
        xs = trees.geometry.x.to_numpy()
        ys = trees.geometry.y.to_numpy()
        for x, y, h, r in zip(xs, ys, hs, rs):
            if not (np.isfinite(h) and np.isfinite(r)) or h <= 0:
                continue
            r = float(np.clip(r, res, 15.0))  # cap absurd crown radii
            col = (x - minx) / res
            row = (maxy - y) / res
            rp = r / res
            c0, c1 = int(max(0, np.floor(col - rp))), int(min(width, np.ceil(col + rp) + 1))
            r0, r1 = int(max(0, np.floor(row - rp))), int(min(height, np.ceil(row + rp) + 1))
            if c0 >= c1 or r0 >= r1:
                continue
            yy, xx = np.ogrid[r0:r1, c0:c1]
            disc = ((xx + 0.5 - col) ** 2 + (yy + 0.5 - row) ** 2) <= rp**2
            patch = cdsm[r0:r1, c0:c1]
            np.maximum(patch, np.where(disc, h, 0.0).astype("float32"), out=patch)
            n_painted += 1

    covered = cdsm > 0
    gap = canopy_mask & ~covered
    fill = float(np.median(cdsm[covered])) if covered.any() else 6.0
    cdsm[gap] = fill
    # Crowns that land on non-canopy land cover are trimmed back: the land-cover
    # raster is the authority on where canopy actually is.
    cdsm[~canopy_mask & covered] = 0.0

    stats = {
        "crowns_painted": int(n_painted),
        "canopy_pixels_from_crowns": int((covered & canopy_mask).sum()),
        "canopy_pixels_filled_with_median": int(gap.sum()),
        "median_crown_height_m": round(fill, 2),
    }
    return cdsm, stats


def write(path: Path, arr: np.ndarray, bbox: tuple, res: float, dtype: str, nodata) -> None:
    minx, _, _, maxy = bbox
    profile = {
        "driver": "GTiff",
        "height": arr.shape[0],
        "width": arr.shape[1],
        "count": 1,
        "dtype": dtype,
        "crs": CRS,
        "transform": from_origin(minx, maxy, res, res),
        "nodata": nodata,
        "compress": "deflate",
        "tiled": True,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr.astype(dtype), 1)
    print(f"    wrote {path.name}  {arr.shape[1]}x{arr.shape[0]}")


# --------------------------------------------------------------------------- #
def build(name: str, bbox: tuple, res: float, outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    bbox = snap(bbox, res)
    w = int(round((bbox[2] - bbox[0]) / res))
    h = int(round((bbox[3] - bbox[1]) / res))
    print(f"[{name}] bbox={tuple(round(v, 1) for v in bbox)} res={res} m  grid={w}x{h}")

    print("  surface model (Nearmap 2023, metres)")
    dsm_raw = fetch_grid(DSM_SERVICE, bbox, res, "dsm")

    print("  bare earth (USGS 3DEP, metres)")
    dem = fetch_grid(DEM_SERVICE, bbox, res, "dem")

    print("  land cover (Boston 2024, 0.5 ft)")
    lc_boston = read_landcover(bbox, res)
    veg = lc_boston == 1  # Boston class 1 = tree canopy

    # The two elevation sources carry slightly different vertical references.
    # Align them on paved ground, where surface and terrain should coincide.
    paved = np.isin(lc_boston, (6, 7)) & np.isfinite(dsm_raw) & np.isfinite(dem)
    offset = float(np.median((dsm_raw - dem)[paved])) if paved.sum() > 1000 else 0.0
    dem = dem + offset
    print(f"    vertical alignment on paved ground: DEM shifted {offset:+.2f} m")

    height_agl = np.clip(np.where(np.isfinite(dsm_raw) & np.isfinite(dem), dsm_raw - dem, 0.0), 0.0, None)

    # SOLWEIG's `dsm` is ground + buildings only: drop whatever canopy the
    # surface model did capture, and let the CDSM carry the vegetation.
    dsm = np.where(veg & (height_agl > 2.0), dem, np.where(np.isfinite(dsm_raw), dsm_raw, dem))
    dsm = dsm.astype("float32")

    print("  canopy height model (2024 tree crowns)")
    cdsm, cdsm_stats = build_cdsm(bbox, res, veg)
    print(f"    {cdsm_stats['crowns_painted']} crowns, "
          f"{cdsm_stats['canopy_pixels_filled_with_median']} px filled at "
          f"{cdsm_stats['median_crown_height_m']} m")

    lc_umep = np.zeros_like(lc_boston)
    for src_code, umep_code in BOSTON_TO_UMEP.items():
        lc_umep[lc_boston == src_code] = umep_code

    print("  writing SOLWEIG inputs")
    write(outdir / "dsm.tif", dsm, bbox, res, "float32", -9999.0)
    write(outdir / "dem.tif", np.nan_to_num(dem, nan=-9999.0), bbox, res, "float32", -9999.0)
    write(outdir / "cdsm.tif", cdsm, bbox, res, "float32", -9999.0)
    write(outdir / "landcover.tif", lc_umep, bbox, res, "uint8", 0)
    write(outdir / "dsm_raw.tif", np.nan_to_num(dsm_raw, nan=-9999.0), bbox, res, "float32", -9999.0)

    print("  heat metrics (City of Boston 2024 model, degF -> degC where applicable)")
    for key, url in HEAT_SERVICES.items():
        arr = fetch_grid(url, bbox, res, key)
        if key in ("heat_ta3pm", "heat_ta3am"):
            arr = (arr - 32.0) * 5.0 / 9.0
        elif key == "heat_uhii":
            arr = arr * 5.0 / 9.0  # an intensity difference, so no 32 offset
        write(outdir / f"{key}.tif", np.nan_to_num(arr, nan=-9999.0), bbox, res, "float32", -9999.0)

    meta = {
        "name": name,
        "crs": CRS,
        "resolution_m": res,
        "bbox_26986": list(bbox),
        "grid": [w, h],
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": {
            "dsm_raw": DSM_SERVICE,
            "dem": DEM_SERVICE,
            "landcover": str(LANDCOVER_TIF.relative_to(ROOT)),
            **HEAT_SERVICES,
        },
        "vertical_alignment_offset_m": round(offset, 3),
        "cdsm_build": cdsm_stats,
        "notes": {
            "dsm": "canopy pixels replaced by bare earth; buildings retained",
            "cdsm": "flat-topped crowns from TreeCentroids2024 (height/radius in feet), "
                    "trimmed to the land-cover canopy mask",
            "landcover_codes": "1 paved, 2 building, 3 evergreen, 4 deciduous, 5 grass, 6 bare soil, 7 water",
            "heat_uhii": "converted from degF difference to degC difference",
        },
    }
    (outdir / "aoi.json").write_text(json.dumps(meta, indent=2))
    print(f"[{name}] done -> {outdir}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--aoi", help="named AOI from config/aois.json")
    ap.add_argument("--neighborhood", help="build from a BPDA neighborhood polygon instead")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("MINX", "MINY", "MAXX", "MAXY"),
                    help="explicit bbox in EPSG:26986")
    ap.add_argument("--name", help="output name when using --bbox/--neighborhood")
    ap.add_argument("--res", type=float, default=None,
                    help=f"pixel size in metres; overrides config. Default {DEFAULT_RES:g} m, "
                         f"which builds to data/aoi/<name>/. Any other resolution builds to "
                         f"data/aoi/<name>_<res>m/, useful for grid spot-checks.")
    ap.add_argument("--all", action="store_true", help="build every AOI in config/aois.json")
    ap.add_argument("--list", action="store_true", help="list configured AOIs and exit")
    args = ap.parse_args()

    aois = load_aois()
    if args.list:
        for key, spec in aois["aois"].items():
            print(f"{key:24s} {spec['split']:8s} {spec['label']}")
        return

    res_default = args.res if args.res is not None else DEFAULT_RES
    jobs = []
    if args.all:
        jobs = [(k, tuple(v["bbox_26986"]), args.res or v.get("res", DEFAULT_RES))
                for k, v in aois["aois"].items()]
    elif args.aoi:
        spec = aois["aois"][args.aoi]
        jobs = [(args.aoi, tuple(spec["bbox_26986"]), args.res or spec.get("res", DEFAULT_RES))]
    elif args.neighborhood:
        name = args.name or args.neighborhood.lower().replace(" ", "_")
        jobs = [(name, neighborhood_bbox(args.neighborhood), res_default)]
    elif args.bbox:
        jobs = [(args.name or "custom", tuple(args.bbox), res_default)]
    else:
        ap.error("one of --aoi / --all / --neighborhood / --bbox is required")

    for name, bbox, res in jobs:
        suffix = "" if abs(res - DEFAULT_RES) < 1e-9 else f"_{res:g}m"
        build(name, bbox, res, DATA / "aoi" / f"{name}{suffix}")


if __name__ == "__main__":
    sys.exit(main())
