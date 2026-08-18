"""Where an intervention is allowed to go, on the AOI grid.

`config/interventions.json` answers "what land cover does this action apply to".
This module answers the other half: a tree may not be planted in the travel lane
or on a crosswalk, must clear a hydrant, a light pole and an intersection, and a
roof or an awning inside a Boston Landmarks Commission district needs a hearing
this pipeline cannot model. The rules and their sources live in
`config/siting.json`; nothing here is hardcoded except the mask names the rules
refer to.

Two design points worth knowing before reading the code:

* **Roadbed vs sidewalk is a nearest-centreline split.** Land cover code 1 is
  "paved" for the travel lane, the sidewalk, a plaza and a parking lot alike, so
  land cover alone cannot keep a tree out of the road. Every ground pixel is
  assigned to whichever centreline is nearer -- a SAM street centreline or a
  sidewalk centreline -- and the paved pixels that land on the street side are
  the roadbed. This needs no width attribute, which is fortunate, because the
  city's sidewalk layer does not have one.

* **Everything is metres, so nothing here is tied to a resolution.** Buffers and
  setbacks are configured in metres and the distance transforms are sampled at
  the AOI's own pixel size. The masks tighten as the grid gets finer -- a 3.05 m
  hydrant setback is a 3-pixel disc at 1 m and a 2-pixel disc at 2 m -- but the
  rule being applied is the same one.

Run directly to rebuild the cached derived layers:

    python scripts/siting.py --rebuild
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

# conda's GDAL data files are not found when the interpreter is invoked directly
# rather than through `conda activate`. Must precede the rasterio import.
_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG = ROOT / "config"
CRS = "EPSG:26986"

BOSTON = DATA / "boston"
DERIVED = BOSTON / "derived"
CACHE = DERIVED / "siting_layers.gpkg"

# Sources, as downloaded by scripts/fetch_boston_open_data.sh.
SIDEWALKS_ZIP = BOSTON / "sidewalk_centerline_geojson.zip"
SIDEWALKS_INNER = "Sidewalk_Centerline.geojson"
STREETS = BOSTON / "street_segments_sam.geojson"
HYDRANTS = BOSTON / "fire_hydrants.geojson"
STREETLIGHTS = BOSTON / "streetlight_locations.csv"
HISTORIC = BOSTON / "blc_historic_districts.geojson"
SIDEWALK_INVENTORY = BOSTON / "sidewalk_inventory.geojson"
CITY_LAND = BOSTON / "city_land_audit.geojson"

# The sidewalk inventory records SWK_WIDTH in feet.
FT_TO_M = 0.3048
# Widths outside this range are survey noise -- a 0.4 ft or a 99.6 ft sidewalk.
WIDTH_RANGE_M = (0.3, 30.0)

# A street node shared by this many segments is an intersection rather than a
# mid-block break. SAM splits its centrelines at every block end, so a node of
# degree 2 is just the seam between two stretches of the same street.
INTERSECTION_DEGREE = 3

# Land-cover codes, repeated rather than imported so this module stays free of
# policy_api (which imports it).
PAVED, BUILDING = 1, 2
GROUND_CODES = (1, 3, 4, 5, 6)

MASK_NAMES = (
    "pedestrian",
    "walkway",
    "crossing",
    "roadbed",
    "narrow_sidewalk",
    "width_imputed",
    "near_obstruction",
    "design_review",
    "existing_canopy",
    "city_owned",
)


def load_rules() -> dict:
    return json.loads((CONFIG / "siting.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# The derived cache
# --------------------------------------------------------------------------- #
# The sidewalk centrelines are a 70 MB GeoJSON inside a zip and the street
# segments another 22 MB; neither carries a spatial index, so a bbox read scans
# the whole file. Twenty AOIs times two resolutions is forty of those scans.
# Projecting them once into a GeoPackage turns each later read into an indexed
# lookup, and gives the intersection nodes somewhere to live.
def ensure_derived(force: bool = False, quiet: bool = False) -> Path | None:
    """Build `data/boston/derived/siting_layers.gpkg` if it is missing.

    Returns the cache path, or None when the source layers are not downloaded.
    """
    if CACHE.exists() and not force:
        return CACHE
    if not (SIDEWALKS_ZIP.exists() and STREETS.exists()):
        return None

    import geopandas as gpd

    def say(msg: str) -> None:
        if not quiet:
            print(msg, flush=True)

    DERIVED.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".part.gpkg")
    if tmp.exists():
        tmp.unlink()

    rules = load_rules()
    ped = rules["pedestrian_space"]

    say(f"reading {SIDEWALKS_INNER} (70 MB, one-off)")
    walk = gpd.read_file(f"zip://{SIDEWALKS_ZIP.as_posix()}!{SIDEWALKS_INNER}").to_crs(CRS)
    walk = walk[["TYPE", "geometry"]]
    walkways = walk[walk["TYPE"].isin(ped["walkway_types"])]
    crossings = walk[walk["TYPE"].isin(ped["crossing_types"])]
    say(f"  {len(walkways)} walkway lines, {len(crossings)} crossing lines")

    say("reading street segments")
    streets = gpd.read_file(STREETS).to_crs(CRS)
    streets = streets[["ST_NAME", "geometry"]]
    nodes = _intersection_nodes(streets, gpd)
    say(f"  {len(streets)} segments, {len(nodes)} intersections")

    obstructions = _obstruction_points(gpd, say)

    walkways.to_file(tmp, layer="walkways", driver="GPKG")
    crossings.to_file(tmp, layer="crossings", driver="GPKG")
    streets.to_file(tmp, layer="streets", driver="GPKG")
    nodes.to_file(tmp, layer="intersections", driver="GPKG")
    if obstructions is not None and not obstructions.empty:
        obstructions.to_file(tmp, layer="obstructions", driver="GPKG")
    if SIDEWALK_INVENTORY.exists():
        import pandas as pd

        say("reading the sidewalk inventory (87 MB, one-off)")
        inv = gpd.read_file(SIDEWALK_INVENTORY).to_crs(CRS)
        inv["width_m"] = pd.to_numeric(inv["SWK_WIDTH"], errors="coerce") * FT_TO_M
        inv = inv[["width_m", "MATERIAL", "geometry"]].dropna(subset=["width_m"])
        lo, hi = WIDTH_RANGE_M
        inv = inv[(inv["width_m"] >= lo) & (inv["width_m"] <= hi)]
        say(f"  {len(inv)} measured sidewalk polygons, "
            f"median {inv['width_m'].median():.1f} m")
        inv.to_file(tmp, layer="sidewalk_widths", driver="GPKG")
    if CITY_LAND.exists():
        land = gpd.read_file(CITY_LAND).to_crs(CRS)
        land = land[["Owner", "Care_and_Custody", "geometry"]]
        say(f"  {len(land)} city-owned parcels")
        land.to_file(tmp, layer="city_land", driver="GPKG")
    if HISTORIC.exists():
        types = load_rules()["review"]["design_review_district_types"]
        hist = gpd.read_file(HISTORIC).to_crs(CRS)
        hist = hist[hist["TYPE"].isin(types)][["HIST_NAME", "TYPE", "geometry"]]
        say(f"  {len(hist)} design-review districts")
        hist.to_file(tmp, layer="design_review", driver="GPKG")

    tmp.replace(CACHE)
    say(f"wrote {CACHE}")
    return CACHE


def _intersection_nodes(streets, gpd):
    """Segment endpoints shared by `INTERSECTION_DEGREE` or more segments."""
    from shapely.geometry import Point

    counts: Counter = Counter()
    for geom in streets.geometry:
        if geom is None or geom.is_empty:
            continue
        parts = geom.geoms if geom.geom_type.startswith("Multi") else [geom]
        for part in parts:
            coords = list(part.coords)
            if len(coords) < 2:
                continue
            for x, y in (coords[0], coords[-1]):
                counts[(round(x, 1), round(y, 1))] += 1
    pts = [Point(x, y) for (x, y), n in counts.items() if n >= INTERSECTION_DEGREE]
    return gpd.GeoDataFrame({"geometry": pts}, crs=CRS)


def _obstruction_points(gpd, say):
    """Hydrants and light poles in one frame, tagged by `kind`."""
    frames = []
    if HYDRANTS.exists():
        hyd = gpd.read_file(HYDRANTS).to_crs(CRS)
        hyd = gpd.GeoDataFrame({"kind": "hydrant", "geometry": hyd.geometry}, crs=CRS)
        say(f"  {len(hyd)} hydrants")
        frames.append(hyd)
    if STREETLIGHTS.exists():
        import pandas as pd

        df = pd.read_csv(STREETLIGHTS, usecols=["Lat", "Long"])
        df = df.dropna()
        pts = gpd.GeoDataFrame(
            {"kind": "streetlight"},
            geometry=gpd.points_from_xy(df["Long"], df["Lat"]),
            crs="EPSG:4326",
            index=df.index,
        ).to_crs(CRS)
        say(f"  {len(pts)} streetlights")
        frames.append(pts)
    if not frames:
        return None
    import pandas as pd

    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=CRS)


# --------------------------------------------------------------------------- #
# Masks on one AOI grid
# --------------------------------------------------------------------------- #
@dataclass
class SitingMasks:
    """Boolean grids on the AOI grid, plus what could not be built.

    `available` names the rules that had data behind them. A rule with no data
    is a mask of all-False (nothing forbidden, nothing required to be there),
    which fails open: a missing hydrant layer must not make every placement
    infeasible. `sidewalk_width_m` is a diagnostic, never a rule -- see
    `not_modelled` in config/siting.json.
    """

    masks: dict[str, np.ndarray]
    sidewalk_width_m: np.ndarray
    available: dict[str, bool]
    rules: dict = field(repr=False, default_factory=dict)
    width_coverage: float = 0.0
    imputed_coverage: float = 0.0

    # Rules whose evidence is inferred rather than observed, and where. A
    # violation that cites one of these should say how much of it was a guess.
    INFERRED = {"narrow_sidewalk": "width_imputed"}

    def inferred_mask(self, rule: str):
        name = self.INFERRED.get(rule)
        return self.masks.get(name) if name else None

    def __getitem__(self, name: str) -> np.ndarray:
        return self.masks[name]

    def allowed(self, action: str) -> np.ndarray:
        """Pixels where `action` breaks no siting rule."""
        ok = np.ones(self.shape, dtype=bool)
        for name, want in self.rule_terms(action):
            ok &= self.masks[name] if want else ~self.masks[name]
        return ok

    def rule_terms(self, action: str):
        """`(mask name, must_be_true)` for each rule bearing on `action`."""
        rule = self.rules.get("action_rules", {}).get(action, {})
        for name in rule.get("require", ()):
            yield name, True
        for name in rule.get("forbid", ()):
            yield name, False

    @property
    def shape(self) -> tuple:
        return next(iter(self.masks.values())).shape

    def summary(self) -> dict:
        out = {name: int(m.sum()) for name, m in self.masks.items()}
        out["layers_available"] = dict(self.available)
        out["measured_width_coverage_of_walkway"] = round(self.width_coverage, 4)
        out["imputed_width_coverage_of_walkway"] = round(self.imputed_coverage, 4)
        return out


def _distance_m(mask: np.ndarray, res: float) -> np.ndarray:
    """Metres from every pixel to the nearest True pixel of `mask`."""
    if not mask.any():
        return np.full(mask.shape, np.inf, dtype="float64")
    return distance_transform_edt(~mask, sampling=(res, res))


def _burn_values(gdf, column, shape, transform) -> np.ndarray:
    """Rasterise a numeric attribute; NaN where no polygon covers the pixel."""
    pairs = [
        (g, float(v)) for g, v in zip(gdf.geometry, gdf[column])
        if g is not None and not g.is_empty and v == v
    ]
    if not pairs:
        return np.full(shape, np.nan, dtype="float64")
    return rasterize(
        pairs, out_shape=shape, transform=transform, fill=np.nan, dtype="float64",
        all_touched=False,
    )


def _burn(gdf, shape, transform, all_touched=True) -> np.ndarray:
    shapes = [(g, 1) for g in gdf.geometry if g is not None and not g.is_empty]
    if not shapes:
        return np.zeros(shape, dtype=bool)
    return rasterize(
        shapes, out_shape=shape, transform=transform, fill=0, dtype="uint8",
        all_touched=all_touched,
    ).astype(bool)


def _read_layer(gpkg: Path, layer: str, bbox: tuple, pad: float):
    import geopandas as gpd
    import pyogrio

    if layer not in set(pyogrio.list_layers(gpkg)[:, 0]):
        return None
    minx, miny, maxx, maxy = bbox
    box = (minx - pad, miny - pad, maxx + pad, maxy + pad)
    try:
        return gpd.read_file(gpkg, layer=layer, bbox=box)
    except Exception as exc:  # a malformed cache should degrade, not crash
        warnings.warn(f"siting: could not read layer {layer!r}: {exc}")
        return None


def build(bbox: tuple, res: float, shape: tuple, landcover: np.ndarray,
          cdsm: np.ndarray) -> SitingMasks:
    """Every siting mask for one AOI, on its own grid.

    `bbox` is the AOI box in EPSG:26986 and `shape` its (rows, cols); both come
    from `aoi.json`, so this follows the AOI's resolution rather than assuming
    one.
    """
    rules = load_rules()
    ped = rules["pedestrian_space"]
    plant = rules["planting"]
    minx, _, _, maxy = bbox
    transform = from_origin(minx, maxy, res, res)

    width_coverage = 0.0
    imputed_coverage = 0.0
    ground = np.isin(landcover, list(GROUND_CODES))
    paved = landcover == PAVED
    masks = {name: np.zeros(shape, dtype=bool) for name in MASK_NAMES}
    masks["existing_canopy"] = np.asarray(cdsm) > 0.0
    available = {name: False for name in MASK_NAMES}
    available["existing_canopy"] = True
    sidewalk_width = np.full(shape, np.nan, dtype="float64")

    gpkg = ensure_derived(quiet=True)
    if gpkg is None:
        # No pedestrian layer at all. Fall back to the whole AOI being walkable
        # -- the same softening `_street_mask` used to do -- so that a checkout
        # without data/boston/ still scores, with `available` recording why.
        masks["pedestrian"] = ground
        masks["walkway"] = ground
        warnings.warn(
            "siting: data/boston/ sidewalk or street layers missing; every ground "
            "pixel is treated as pedestrian space and no siting rule is enforced"
        )
        return SitingMasks(masks, sidewalk_width, available, rules)

    # The buffers below reach at most `walkway_half_width_m` from a line, but the
    # distance transforms need features just outside the AOI too or the masks go
    # wrong at the edges. Pad by the largest distance any rule looks over.
    pad = max(
        ped["walkway_half_width_m"], ped["crossing_half_width_m"],
        plant["setback_hydrant_m"], plant["setback_streetlight_m"],
        plant["setback_intersection_m"], 30.0,
    )

    walkways = _read_layer(gpkg, "walkways", bbox, pad)
    crossings = _read_layer(gpkg, "crossings", bbox, pad)
    streets = _read_layer(gpkg, "streets", bbox, pad)

    walk_px = _burn(walkways, shape, transform) if walkways is not None else np.zeros(shape, bool)
    cross_px = _burn(crossings, shape, transform) if crossings is not None else np.zeros(shape, bool)
    street_px = _burn(streets, shape, transform) if streets is not None else np.zeros(shape, bool)

    d_walk = _distance_m(walk_px, res) if walk_px.any() else np.full(shape, np.inf)

    # Roadbed: paved ground nearer a street centreline than a sidewalk one. This
    # is the rule land cover cannot express -- code 1 is the travel lane, the
    # sidewalk, the plaza and the parking lot alike.
    if street_px.any() and walk_px.any():
        available["roadbed"] = True
        masks["roadbed"] = paved & (_distance_m(street_px, res) < d_walk)

    if walk_px.any():
        available["walkway"] = available["pedestrian"] = True
        masks["walkway"] = (
            ground & (d_walk <= ped["walkway_half_width_m"]) & ~masks["roadbed"]
        )
    else:
        masks["walkway"] = ground

    # Crossings deliberately put part of the roadbed back into pedestrian space:
    # people stand on a crosswalk, so relief there counts, but nothing may be
    # built on it. The action rules forbid both `roadbed` and `crossing`.
    if cross_px.any():
        available["crossing"] = True
        d_cross = _distance_m(cross_px, res)
        masks["crossing"] = ground & (d_cross <= ped["crossing_half_width_m"])

    masks["pedestrian"] = masks["walkway"] | masks["crossing"]

    # Width. The city's 2014 sidewalk inventory measured it, polygon by polygon,
    # so where that survey reaches, the width is a survey figure and the 6 ft
    # planting rule is a real test rather than an inference. Where it does not
    # reach, fall back to the thickness of the contiguous non-roadbed ground the
    # pixel sits in -- bounded by the roadbed on one side and by buildings on the
    # other, so a kerb-to-facade sidewalk reads as itself while a front yard or a
    # plaza inflates it. The fallback therefore over-estimates, and only the
    # measured part is ever allowed to forbid anything.
    if masks["walkway"].any():
        corridor = ground & ~masks["roadbed"]
        sidewalk_width = np.where(
            masks["walkway"],
            2.0 * distance_transform_edt(corridor, sampling=(res, res)),
            np.nan,
        )
    inventory = _read_layer(gpkg, "sidewalk_widths", bbox, pad)
    if inventory is not None and not inventory.empty:
        available["narrow_sidewalk"] = True
        measured = _burn_values(inventory, "width_m", shape, transform)
        surveyed = np.isfinite(measured)

        # The threshold tolerance is not cosmetic. 6.0 ft is the modal width in
        # the survey and the threshold is 6 ft exactly, so a sidewalk that just
        # meets the standard sits on the boundary; without it, float noise and a
        # threshold rounded up to 1.83 m condemn 3,930 compliant polygons and
        # take the rule from 18 % of surveyed sidewalk to 35 %.
        tol = float(plant.get("width_tolerance_m", 1e-6))
        threshold = float(plant["min_sidewalk_width_m"]) - tol

        # Imputation. The 2014 survey reaches roughly a quarter of the walkway,
        # and sidewalk width is strongly autocorrelated along a block, so an
        # unsurveyed pixel takes the width of the nearest surveyed one -- but
        # only within `impute_max_distance_m`. Past that the inference is worse
        # than assuming the sidewalk is wide enough; the hold-out numbers behind
        # the cap are in config/siting.json under `imputation_validation`.
        width = np.where(surveyed, measured, sidewalk_width)
        imputed = np.zeros(shape, dtype=bool)
        if plant.get("impute_width", False) and surveyed.any():
            reach = float(plant.get("impute_max_distance_m", 0.0))
            dist, idx = distance_transform_edt(
                ~surveyed, sampling=(res, res), return_indices=True
            )
            imputed = ~surveyed & (dist <= reach) & masks["walkway"]
            nearest = measured[idx[0], idx[1]]
            width = np.where(imputed, nearest, width)
            available["width_imputed"] = True
        masks["width_imputed"] = imputed
        sidewalk_width = np.where(masks["walkway"], width, np.nan)

        # An unsurveyed, un-imputed pixel is unknown, and unknown must not
        # forbid a tree.
        judged = surveyed
        if plant.get("enforce_imputed_width", False):
            judged = surveyed | imputed
        masks["narrow_sidewalk"] = judged & np.isfinite(width) & (width < threshold)
        if masks["walkway"].any():
            on_walk = masks["walkway"]
            width_coverage = float(surveyed[on_walk].mean())
            imputed_coverage = float(imputed[on_walk].mean())

    # Ownership, reported and never enforced: a cool roof on a private building
    # is a subsidy rather than a placement, which is a real policy instrument.
    # Knowing what share of a plan lands on land the city actually holds is the
    # honest version of that caveat.
    parcels = _read_layer(gpkg, "city_land", bbox, pad)
    if parcels is not None:
        available["city_owned"] = True
        if not parcels.empty:
            masks["city_owned"] = _burn(parcels, shape, transform, all_touched=False)

    blocked = np.zeros(shape, dtype=bool)
    obstructions = _read_layer(gpkg, "obstructions", bbox, pad)
    if obstructions is not None and not obstructions.empty:
        for kind, setback in (("hydrant", plant["setback_hydrant_m"]),
                              ("streetlight", plant["setback_streetlight_m"])):
            sel = obstructions[obstructions["kind"] == kind]
            if sel.empty:
                continue
            available["near_obstruction"] = True
            pts = _burn(sel, shape, transform)
            blocked |= _distance_m(pts, res) < setback
    nodes = _read_layer(gpkg, "intersections", bbox, pad)
    if nodes is not None and not nodes.empty:
        available["near_obstruction"] = True
        blocked |= _distance_m(_burn(nodes, shape, transform), res) < plant["setback_intersection_m"]
    masks["near_obstruction"] = blocked

    districts = _read_layer(gpkg, "design_review", bbox, pad)
    if districts is not None:
        # An AOI outside every district reads back empty, and that is a real
        # answer rather than a missing layer.
        available["design_review"] = True
        if not districts.empty:
            masks["design_review"] = _burn(districts, shape, transform, all_touched=False)

    return SitingMasks(masks, sidewalk_width, available, rules,
                       width_coverage, imputed_coverage)


def validate_width(holdout: float = 0.2, seed: int = 0) -> None:
    """Hold-out test of the nearest-known width imputation.

    Prints accuracy against the planting threshold by distance, which is what
    decides `impute_max_distance_m`. The comparison that matters is not MAE but
    the trivial baseline: assuming every unsurveyed sidewalk is wide enough is
    already right about four times in five, so imputation has to beat that to be
    worth anything, and past the cap it does not.
    """
    import geopandas as gpd
    from scipy.spatial import cKDTree

    gpkg = ensure_derived(quiet=True)
    if gpkg is None:
        raise SystemExit("no derived cache; run python scripts/siting.py --rebuild")
    gdf = gpd.read_file(gpkg, layer="sidewalk_widths")
    pts = gdf.geometry.representative_point()
    xy = np.c_[pts.x.to_numpy(), pts.y.to_numpy()]
    widths = gdf["width_m"].to_numpy()

    plant = load_rules()["planting"]
    threshold = float(plant["min_sidewalk_width_m"]) - float(plant.get("width_tolerance_m", 1e-6))
    cap = float(plant.get("impute_max_distance_m", 0.0))

    rng = np.random.default_rng(seed)
    held = rng.random(len(widths)) < holdout
    actual = widths[held]
    narrow = actual < threshold
    print(f"{len(widths)} surveyed polygons, {held.sum()} held out")
    print(f"threshold {threshold:.4f} m ({threshold / 0.3048:.2f} ft); "
          f"{narrow.mean():.1%} of held-out sidewalk is narrower")
    print(f"baseline 'assume wide enough': {1 - narrow.mean():.1%} accurate, forbids nothing")
    print()

    dist, idx = cKDTree(xy[~held]).query(xy[held])
    predicted = widths[~held][idx]
    called = predicted < threshold
    print(f"{'distance m':>13} {'n':>6} {'MAE m':>7} {'accuracy':>9} {'wrongly forbids':>16}")
    for lo, hi in ((0, 10), (10, 25), (25, 50), (50, float("inf"))):
        sel = (dist >= lo) & (dist < hi)
        if sel.sum() < 20:
            continue
        compliant = ~narrow[sel]
        wrong = (called[sel] & compliant).sum() / max(compliant.sum(), 1)
        label = f"{lo:>5}-{'inf' if hi == float('inf') else int(hi):>7}"
        print(f"{label} {sel.sum():>6} {np.abs(predicted[sel] - actual[sel]).mean():>7.2f} "
              f"{(called[sel] == narrow[sel]).mean():>8.1%} {wrong:>15.1%}")
    inside = dist <= cap
    print()
    print(f"at the configured {cap:g} m cap: {(called[inside] == narrow[inside]).mean():.1%} "
          f"accurate over {inside.sum()} of {held.sum()} held-out polygons")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--rebuild", action="store_true",
                    help="rebuild the derived GeoPackage even if it exists")
    ap.add_argument("--validate-width", action="store_true",
                    help="hold-out test of the width imputation and print its accuracy")
    args = ap.parse_args()
    if args.validate_width:
        validate_width()
        return
    path = ensure_derived(force=args.rebuild)
    if path is None:
        raise SystemExit(
            "siting: need data/boston/sidewalk_centerline_geojson.zip and "
            "street_segments_sam.geojson -- run scripts/fetch_boston_open_data.sh"
        )
    import pyogrio

    print(f"\n{path}")
    for name, geom in pyogrio.list_layers(path):
        info = pyogrio.read_info(path, layer=name)
        print(f"  {name:<14} {info['features']:>7} {geom}")


if __name__ == "__main__":
    main()
