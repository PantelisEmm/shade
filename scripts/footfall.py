"""How many people are actually on the street, approximately -- and why the
scorer does not use it.

`population` on the PlanningContext is a residence proxy: tract population
spread evenly over the tract's pedestrian pixels. It answers "who lives with
this heat", not "who walks through it", and those are different questions -- a
bus stop on a commercial corridor carries people who live three tracts away.

**There is no citywide pedestrian count for Boston.** The Transportation
Department's turning-movement and pedestrian counts exist only as scanned PDFs
behind a document-search portal, and the one open sensor dataset is a
three-location pilot. So this module models trip *generation* instead: transit
boardings, bus service, retail frontage and institutions, each decayed over
walking distance and summed.

**It is not wired into scoring, because it is not better than what is already
there.** Against pedestrian-involved Vision Zero crashes -- 6,900 records, the
only citywide pedestrian signal Boston publishes -- over the cells inside a
Boston tract:

    footfall index         rho 0.362
    residential density    rho 0.355      <- what the scorer already weights by

Those are the same number. The index does order the city (crashes per cell run
0.02 to 1.59 across its deciles, monotonically, which residential density does
not quite manage), but not well enough to justify restructuring the objective
around a proxy when the honest alternative is to keep the residence assumption
and say so. The component breakdown also contradicts the weights in
config/footfall.json: institutions and retail carry the signal, bus service
supply carries almost none (rho 0.069), so the weights would have to be refit --
against the same crashes that are supposed to validate them.

The module is kept because it is the evidence for that assumption, and because
one better dataset would change the answer: MBTA bus ridership by stop exists
but is published only as a web page, and the city's own pedestrian counts are
already collected and merely not machine-readable.

    python scripts/footfall.py --rebuild     # derive the generator cache
    python scripts/footfall.py --validate    # test it against crash density
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import warnings
import zipfile
from collections import Counter, defaultdict
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
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG = ROOT / "config"
CRS = "EPSG:26986"

BOSTON = DATA / "boston"
TRANSIT = DATA / "transit"
DERIVED = TRANSIT / "derived"
CACHE = DERIVED / "footfall_generators.gpkg"
SCALES = DERIVED / "footfall_scales.json"

GTFS = TRANSIT / "mbta_gtfs.zip"
RAIL_RIDERSHIP = TRANSIT / "mbta_rail_ridership.csv"
MAIN_STREETS = BOSTON / "main_streets_districts.geojson"
CRASHES = BOSTON / "vision_zero_crashes.csv"
INSTITUTIONS = (
    BOSTON / "public_schools.geojson",
    BOSTON / "non_public_schools.geojson",
    BOSTON / "colleges_and_universities.geojson",
    BOSTON / "public_libraries.geojson",
    BOSTON / "community_centers.geojson",
)

# The scoring window is a hot afternoon, so the transit day is trimmed to the
# periods a person would be walking through it.
AFTERNOON_PERIODS = ("MIDDAY_BASE", "MIDDAY_SCHOOL", "PM_PEAK")
COMPONENTS = ("transit_rail", "transit_bus", "retail", "institution")


def load_rules() -> dict:
    return json.loads((CONFIG / "footfall.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# The generator cache
# --------------------------------------------------------------------------- #
def _rail_weights() -> dict:
    """{parent station id: average weekday afternoon ons + offs}.

    Summed over both directions and the afternoon time periods. The file carries
    several seasons; the latest one wins, and which one that was goes into the
    cache so the vintage travels with the number.
    """
    rows = []
    with open(RAIL_RIDERSHIP, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["day_type_name"] != "weekday":
                continue
            if r["time_period_name"] not in AFTERNOON_PERIODS:
                continue
            rows.append(r)
    if not rows:
        return {}, None
    # "Fall 2019" sorts after "Fall 2018" lexically, which is all that is needed
    # while every season in the file shares a season name.
    season = max(r["season"] for r in rows)
    weights: dict[str, float] = defaultdict(float)
    for r in rows:
        if r["season"] != season:
            continue
        for key in ("average_ons", "average_offs"):
            try:
                weights[r["stop_id"]] += float(r[key] or 0.0)
            except ValueError:
                pass
    return dict(weights), season


def _gtfs_stops_and_service():
    """Stop coordinates, and weekday bus trips serving each stop.

    Bus ridership by stop is not published in a machine-readable form, so trips
    per weekday stands in for it: service supply rather than demand. Rail stops
    are excluded here because they are carried by real boardings instead.
    """
    z = zipfile.ZipFile(GTFS)

    def read(name):
        with z.open(name) as fh:
            yield from csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig"))

    stops = {}
    for r in read("stops.txt"):
        try:
            stops[r["stop_id"]] = (
                float(r["stop_lon"]), float(r["stop_lat"]),
                r.get("parent_station") or "", r.get("vehicle_type") or "",
            )
        except (ValueError, KeyError):
            continue

    weekday = {r["service_id"] for r in read("calendar.txt")
               if all(r.get(d) == "1" for d in ("monday", "tuesday", "wednesday",
                                                "thursday", "friday"))}
    bus_routes = {r["route_id"] for r in read("routes.txt") if r.get("route_type") == "3"}
    bus_trips = {r["trip_id"] for r in read("trips.txt")
                 if r["route_id"] in bus_routes and r["service_id"] in weekday}

    trips_at_stop: Counter = Counter()
    for r in read("stop_times.txt"):
        if r["trip_id"] in bus_trips:
            trips_at_stop[r["stop_id"]] += 1
    return stops, trips_at_stop


def ensure_derived(force: bool = False, quiet: bool = False):
    """Build the generator point/polygon cache and the citywide normalisers."""
    if CACHE.exists() and SCALES.exists() and not force:
        return CACHE
    if not (GTFS.exists() and RAIL_RIDERSHIP.exists()):
        return None

    import geopandas as gpd
    import pandas as pd

    def say(msg: str) -> None:
        if not quiet:
            print(msg, flush=True)

    DERIVED.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".part.gpkg")
    if tmp.exists():
        tmp.unlink()

    stops, bus_trips = _gtfs_stops_and_service()
    rail, season = _rail_weights()
    say(f"rail: {len(rail)} stations, season {season}")
    say(f"bus: {len(bus_trips)} stops with weekday service")

    def points(mapping, kind):
        rows = []
        for stop_id, weight in mapping.items():
            place = stops.get(stop_id)
            if place is None or weight <= 0:
                continue
            rows.append((place[0], place[1], float(weight)))
        if not rows:
            return None
        lon, lat, w = zip(*rows)
        gdf = gpd.GeoDataFrame(
            {"kind": kind, "weight": list(w)},
            geometry=gpd.points_from_xy(lon, lat), crs="EPSG:4326",
        ).to_crs(CRS)
        return gdf

    frames = []
    rail_gdf = points(rail, "transit_rail")
    if rail_gdf is not None:
        frames.append(rail_gdf)
    bus_gdf = points({k: float(v) for k, v in bus_trips.items()}, "transit_bus")
    if bus_gdf is not None:
        frames.append(bus_gdf)

    inst = []
    for path in INSTITUTIONS:
        if not path.exists():
            continue
        g = gpd.read_file(path).to_crs(CRS)
        g = g[~g.geometry.is_empty & g.geometry.notna()]
        pts = g.geometry.representative_point()
        inst.append(gpd.GeoDataFrame(
            {"kind": ["institution"] * len(pts), "weight": [1.0] * len(pts)},
            geometry=pts.reset_index(drop=True), crs=CRS,
        ))
    if inst:
        merged = gpd.GeoDataFrame(pd.concat(inst, ignore_index=True), crs=CRS)
        say(f"institutions: {len(merged)} points")
        frames.append(merged)

    gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=CRS).to_file(
        tmp, layer="generators", driver="GPKG"
    )
    if MAIN_STREETS.exists():
        streets = gpd.read_file(MAIN_STREETS).to_crs(CRS)
        streets = streets[["geometry"]]
        say(f"retail: {len(streets)} Main Streets districts")
        streets.to_file(tmp, layer="retail", driver="GPKG")

    tmp.replace(CACHE)
    scales = _citywide_scales(quiet=quiet)
    scales["rail_season"] = season
    SCALES.write_text(json.dumps(scales, indent=2), encoding="utf-8")
    say(f"wrote {CACHE} and {SCALES.name}")
    return CACHE


def _citywide_scales(cell: float = 100.0, quiet: bool = False) -> dict:
    """Each component's citywide percentile, so the components are comparable.

    Computed once on a coarse grid over the whole city. Without it the weights in
    config/footfall.json would be multiplying quantities in different units --
    boardings against bus trips against a boolean -- and would mean nothing.
    """
    rules = load_rules()
    pct = float(rules["normalisation"]["percentile"])
    grids, transform, shape = _citywide_components(cell)
    out = {}
    for name, grid in grids.items():
        positive = grid[grid > 0]
        out[name] = float(np.percentile(positive, pct)) if positive.size else 1.0
        if not quiet:
            print(f"  {name}: citywide p{pct:.0f} = {out[name]:.4g}")
    return {"percentile": pct, "cell_m": cell, "scales": out}


def _citywide_components(cell: float):
    """Undecayed... decayed component grids over the whole city, coarse."""
    import geopandas as gpd

    gen = gpd.read_file(CACHE, layer="generators")
    minx, miny, maxx, maxy = gen.total_bounds
    pad = 1000.0
    minx, miny, maxx, maxy = minx - pad, miny - pad, maxx + pad, maxy + pad
    cols = int(np.ceil((maxx - minx) / cell))
    rows = int(np.ceil((maxy - miny) / cell))
    transform = from_origin(minx, maxy, cell, cell)
    retail = None
    try:
        retail = gpd.read_file(CACHE, layer="retail")
    except Exception:
        pass
    grids = _components((rows, cols), transform, cell, gen, retail)
    return grids, transform, (rows, cols)


def _components(shape, transform, res: float, gen, retail) -> dict:
    """One decayed grid per component, in the component's own raw units."""
    rules = load_rules()["components"]
    out = {}
    for name in COMPONENTS:
        decay = float(rules[name]["decay_m"])
        if name == "retail":
            if retail is None or retail.empty:
                out[name] = np.zeros(shape, dtype="float64")
                continue
            shapes = [(g, 1.0) for g in retail.geometry if g is not None and not g.is_empty]
            raw = rasterize(shapes, out_shape=shape, transform=transform,
                            fill=0.0, dtype="float64", all_touched=True) if shapes \
                else np.zeros(shape, dtype="float64")
        else:
            sel = gen[gen["kind"] == name]
            shapes = [(g, float(w)) for g, w in zip(sel.geometry, sel["weight"])
                      if g is not None and not g.is_empty and w > 0]
            raw = rasterize(shapes, out_shape=shape, transform=transform,
                            fill=0.0, dtype="float64", merge_alg=_ADD) if shapes \
                else np.zeros(shape, dtype="float64")
        # A Gaussian blur is exactly "sum of every generator, decayed with
        # distance"; doing it as a filter rather than a point-by-point sum is
        # what keeps this affordable on a 1 m grid.
        out[name] = gaussian_filter(raw, sigma=decay / res, mode="constant")
    return out


try:  # rasterio >= 1.2
    from rasterio.enums import MergeAlg as _MergeAlg

    _ADD = _MergeAlg.add
except Exception:  # pragma: no cover - older rasterio overwrites instead
    _ADD = None


# --------------------------------------------------------------------------- #
# One AOI
# --------------------------------------------------------------------------- #
@dataclass
class Footfall:
    """A relative pedestrian-activity index on the AOI grid, and its parts."""

    index: np.ndarray
    parts: dict
    available: bool
    rail_season: str | None = None
    scales: dict = field(repr=False, default_factory=dict)

    def summary(self) -> dict:
        return {
            "available": self.available,
            "rail_season": self.rail_season,
            "index_max": round(float(self.index.max()), 4) if self.index.size else None,
            "component_share": {
                name: round(float(part.sum() / total), 4)
                for name, part in self.parts.items()
                for total in [sum(float(p.sum()) for p in self.parts.values()) or 1.0]
            },
        }


def build(bbox: tuple, res: float, shape: tuple) -> Footfall:
    """The footfall index for one AOI, on its own grid.

    Generators are read with a wide pad -- a bus stop just outside the AOI still
    puts people on its streets -- and each component is divided by its citywide
    normaliser before the configured weights are applied.
    """
    zero = np.zeros(shape, dtype="float64")
    rules = load_rules()
    gpkg = ensure_derived(quiet=True)
    if gpkg is None or not SCALES.exists():
        warnings.warn(
            "footfall: no generator cache; run python scripts/footfall.py --rebuild. "
            "The index is flat and footfall_relief_c will not be reported"
        )
        return Footfall(zero, {}, False)

    import geopandas as gpd

    scales = json.loads(SCALES.read_text(encoding="utf-8"))
    minx, miny, maxx, maxy = bbox
    pad = 3.0 * max(float(c["decay_m"]) for c in rules["components"].values())
    box = (minx - pad, miny - pad, maxx + pad, maxy + pad)
    transform = from_origin(minx, maxy, res, res)

    gen = gpd.read_file(gpkg, layer="generators", bbox=box)
    try:
        retail = gpd.read_file(gpkg, layer="retail", bbox=box)
    except Exception:
        retail = None

    parts = _components(shape, transform, res, gen, retail)
    index = zero.copy()
    weighted = {}
    for name, grid in parts.items():
        scale = float(scales["scales"].get(name, 1.0)) or 1.0
        w = float(rules["components"][name]["weight"])
        weighted[name] = w * grid / scale
        index += weighted[name]
    return Footfall(index, weighted, True, scales.get("rail_season"), scales)


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Rank correlation, as Pearson over tie-averaged ranks.

    Written out rather than called from scipy or numpy. Both `spearmanr` and
    `np.corrcoef` route through the BLAS, and in this environment a BLAS call
    made after GDAL has been loaded kills the interpreter outright -- Windows
    exception 0xc06d007f, an OpenMP runtime clash, with no Python traceback.
    The elementwise form below touches no matrix routine and is exact.
    """
    import pandas as pd

    ra = np.array(pd.Series(a).rank(method="average").to_numpy(), dtype="float64")
    rb = np.array(pd.Series(b).rank(method="average").to_numpy(), dtype="float64")
    ra -= ra.mean()
    rb -= rb.mean()
    denom = np.sqrt(float((ra * ra).sum()) * float((rb * rb).sum()))
    if denom == 0:
        return float("nan")
    return float((ra * rb).sum() / denom)


def validate(cell: float = 100.0) -> None:
    """Rank-correlate the index against pedestrian crash density citywide.

    Pedestrian crashes are not pedestrian volume -- they carry road danger as
    well as exposure -- but crash counts scale with exposure, and 6,900 of them
    are the only citywide pedestrian signal Boston publishes. A proxy that
    cannot even order the city the way crashes do is not measuring footfall.
    """
    if not (CACHE.exists() and SCALES.exists()):
        raise SystemExit("no cache; run python scripts/footfall.py --rebuild")
    if not CRASHES.exists():
        raise SystemExit(f"missing {CRASHES}; run scripts/fetch_boston_open_data.sh")

    import geopandas as gpd
    from pyproj import Transformer

    grids, transform, shape = _citywide_components(cell)
    rules = load_rules()
    scales = json.loads(SCALES.read_text(encoding="utf-8"))["scales"]
    index = np.zeros(shape, dtype="float64")
    for name, grid in grids.items():
        index += float(rules["components"][name]["weight"]) * grid / (scales.get(name, 1.0) or 1.0)

    lon, lat = [], []
    with open(CRASHES, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("mode_type") != "ped":
                continue
            try:
                lon.append(float(r["long"])); lat.append(float(r["lat"]))
            except (ValueError, KeyError, TypeError):
                continue
    tx = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    x, y = tx.transform(np.array(lon), np.array(lat))
    minx, maxy = transform.c, transform.f
    col = ((x - minx) / cell).astype(int)
    row = ((maxy - y) / cell).astype(int)
    keep = (row >= 0) & (row < shape[0]) & (col >= 0) & (col < shape[1])
    counts = np.zeros(shape, dtype="float64")
    np.add.at(counts, (row[keep], col[keep]), 1.0)

    # Only cells that are plausibly in the city at all; empty ocean and the
    # padding ring would otherwise manufacture a correlation out of zeros.
    live = index > 0
    rho_all = _spearman(index[live], counts[live])
    hot = live & (counts > 0)
    rho_hot = _spearman(index[hot], counts[hot])
    print(f"{int(keep.sum())} pedestrian crashes on a {cell:g} m grid, "
          f"{int(live.sum())} live cells")
    print(f"Spearman rho, all live cells      {rho_all:.3f}")
    print(f"Spearman rho, cells with a crash  {rho_hot:.3f}  (n={int(hot.sum())})")

    order = np.argsort(index[live])
    dec = np.array_split(counts[live][order], 10)
    print("\ncrashes per cell by footfall decile (low to high):")
    print("  " + "  ".join(f"{d.mean():.2f}" for d in dec))
    for name in COMPONENTS:
        g = grids[name][live] / (scales.get(name, 1.0) or 1.0)
        print(f"  {name:<14} alone: rho {_spearman(g, counts[live]):.3f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--rebuild", action="store_true", help="rebuild the generator cache")
    ap.add_argument("--validate", action="store_true",
                    help="rank-correlate the index against pedestrian crash density")
    args = ap.parse_args()
    if args.validate:
        validate()
        return
    path = ensure_derived(force=args.rebuild)
    if path is None:
        raise SystemExit(
            "footfall: need data/transit/mbta_gtfs.zip and mbta_rail_ridership.csv -- "
            "run scripts/fetch_boston_open_data.sh"
        )
    print(f"\n{path}")
    print(SCALES.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
