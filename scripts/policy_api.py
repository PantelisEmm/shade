"""The contract between a SHADE policy and the auditor.

A *policy* is a rule; a *solution* is the concrete placement it produces on one
study area. A policy lives in its own module (see `policies/baseline_policy.py`)
and exposes:

    def plan(ctx: PlanningContext, budget_usd: float) -> list[Placement]

`ctx` carries every grid the policy is allowed to look at, all on the AOI's own
grid (same shape, same transform, EPSG:26986). A `Placement` names one action
from `config/interventions.json` and the pixels it is applied to. The auditor
(`scripts/score_policy.py`) prices the placements, checks them against the
eligibility rules, edits the raster stack, and runs SOLWEIG.

Nothing here imports solweig, so a policy can be written and checked without
paying for a simulation.

Two independent gates decide whether a pixel may be used. `eligible(action)`
is land cover -- a cool roof needs a building under it. `sitable(action)` is
physical siting -- a tree may not go in the travel lane, on a crosswalk, inside
a hydrant's clearance, or under a crown that is already there, and a roof or an
awning may not go inside a Boston Landmarks Commission district. The rules and
their sources are in `config/siting.json`, the masks in `scripts/siting.py`, and
`placeable(action)` is both gates at once.

Units, once, so a policy never has to guess:
    * every grid is metres or degC; the heat rasters were converted on build
    * `population` is people per pixel, `vulnerability` is a 0-1 percentile
    * costs are USD; `unit == "tree"` prices per placement, `"m2"` per pixel area
"""

from __future__ import annotations

import json
import os
import sys
import warnings
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
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import siting

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG = ROOT / "config"
CRS = "EPSG:26986"

# UMEP land-cover codes as written by build_aoi.py. Boston's own codes never
# leave build_aoi.py -- everything downstream, policies included, reads UMEP.
PAVED, BUILDING, EVERGREEN, DECIDUOUS, GRASS, BARE, WATER = 1, 2, 3, 4, 5, 6, 7
GROUND_CODES = (PAVED, EVERGREEN, DECIDUOUS, GRASS, BARE)

# Tract counts in the Climate Ready Boston social-vulnerability layer that the
# composite vulnerability index averages, each as a share of tract population.
SVI = DATA / "heat" / "climate_ready_social_vulnerability.geojson"
SVI_SHARES = ["OlderAdult", "TotChild", "POC2", "LEP", "Low_to_No", "TotDis"]

# Co-benefit conversion factor. An order-of-magnitude figure, the same weak link
# as the unit costs in config/interventions.json: ~1400 kWh/m2/yr of horizontal
# irradiance in Boston, ~15 % module efficiency, ~0.75 derate. Replace it before
# any result is presented as a recommendation.
PV_KWH_PER_M2_YR = 150.0


# --------------------------------------------------------------------------- #
# What a policy hands back
# --------------------------------------------------------------------------- #
@dataclass
class Placement:
    """One action applied to a set of pixels.

    `rows`/`cols` are pixel indices into the AOI grid. For a per-tree action one
    entry is one tree; for a per-m2 action one entry is one pixel of treated
    area. A policy may also return plain dicts with the same three keys --
    `normalise_placements` accepts either.
    """

    action: str
    rows: np.ndarray
    cols: np.ndarray

    def __post_init__(self) -> None:
        self.rows = np.asarray(self.rows, dtype=np.int64).ravel()
        self.cols = np.asarray(self.cols, dtype=np.int64).ravel()
        if self.rows.size != self.cols.size:
            raise ValueError(f"{self.action}: {self.rows.size} rows vs {self.cols.size} cols")

    def __len__(self) -> int:
        return int(self.rows.size)

    @classmethod
    def from_mask(cls, action: str, mask: np.ndarray) -> "Placement":
        rows, cols = np.nonzero(np.asarray(mask, dtype=bool))
        return cls(action, rows, cols)


def normalise_placements(raw) -> list[Placement]:
    """Coerce whatever `plan()` returned into a list of Placements.

    Policies are LLM-written, so the shapes they return vary. Anything that is
    neither a Placement nor a 3-key mapping raises, and the auditor turns that
    into an infeasible verdict rather than a crash.
    """
    if raw is None:
        return []
    if isinstance(raw, (Placement, dict)):
        raw = [raw]
    out: list[Placement] = []
    for i, item in enumerate(raw):
        if isinstance(item, Placement):
            out.append(item)
        elif isinstance(item, dict):
            missing = {"action", "rows", "cols"} - set(item)
            if missing:
                raise ValueError(f"placement {i} is missing {sorted(missing)}")
            out.append(Placement(str(item["action"]), item["rows"], item["cols"]))
        else:
            raise TypeError(
                f"placement {i} is a {type(item).__name__}, expected Placement or dict"
            )
    return out


# --------------------------------------------------------------------------- #
# What a policy gets to look at
# --------------------------------------------------------------------------- #
@dataclass
class PlanningContext:
    """Read-only view of one AOI, plus the intervention menu and its prices."""

    name: str
    split: str
    res_m: float
    bbox: tuple
    shape: tuple

    landcover: np.ndarray        # UMEP codes, uint8
    dsm: np.ndarray              # ground + buildings, m AMSL
    dem: np.ndarray              # bare earth, m AMSL
    cdsm: np.ndarray             # canopy height above ground, m (0 where none)
    building_height: np.ndarray  # m above terrain, 0 off buildings

    heat_ta3pm: np.ndarray       # modelled 3 PM air temperature, degC
    heat_ta3am: np.ndarray       # modelled 3 AM air temperature, degC
    heat_uhii: np.ndarray        # urban heat island intensity, degC
    heat_hours: np.ndarray       # annual heat-event hours

    population: np.ndarray       # people per pixel, spread over exposure pixels
    vulnerability: np.ndarray    # 0-1 citywide percentile of the tract's index
    priority: np.ndarray         # bool: tract in the citywide top vulnerability quartile

    walkable: np.ndarray         # bool: ground a person can stand on
    walkway: np.ndarray          # bool: sidewalk / path corridor, roadbed removed
    crossing: np.ndarray         # bool: marked or unmarked crosswalk
    roadbed: np.ndarray          # bool: paved travel way -- nothing may be built here
    design_review: np.ndarray    # bool: inside a Landmarks Commission district
    city_owned: np.ndarray       # bool: on a parcel the city owns (reported, never a rule)
    exposure: np.ndarray         # bool: walkway | crossing -- where scores are measured
    plantable: np.ndarray        # bool: every siting rule for a tree is satisfied
    buildable: np.ndarray        # bool: every siting rule for a canopy is satisfied
    sidewalk_width_m: np.ndarray # sidewalk width m: surveyed where the city measured it,
                                 # else a corridor-thickness proxy; NaN off the walkway

    interventions: dict = field(repr=False, default_factory=dict)
    siting: "siting.SitingMasks | None" = field(repr=False, default=None)

    # -- prices ------------------------------------------------------------- #
    @property
    def pixel_area_m2(self) -> float:
        return float(self.res_m * self.res_m)

    def spec(self, action: str) -> dict:
        try:
            return self.interventions[action]
        except KeyError:
            raise KeyError(
                f"unknown action {action!r}; have {sorted(self.interventions)}"
            ) from None

    def unit_cost(self, action: str) -> float:
        """USD per tree, or per pixel for a per-m2 action."""
        spec = self.spec(action)
        per_unit = float(spec["cost_usd_per_unit"])
        return per_unit if spec["unit"] == "tree" else per_unit * self.pixel_area_m2

    def cost(self, action: str, n_pixels: int) -> float:
        return self.unit_cost(action) * int(n_pixels)

    def affordable(self, action: str, budget_usd: float) -> int:
        """How many pixels of `action` fit inside `budget_usd`."""
        unit = self.unit_cost(action)
        return int(budget_usd // unit) if unit > 0 else 0

    def eligible(self, action: str) -> np.ndarray:
        """Pixels whose land cover the action is allowed on.

        Actions without `applies_to_landcover` (trees, canopies) are allowed on
        any ground pixel; the auditor still rejects placements on buildings and
        water. This is land cover only -- see `sitable` for where the pixel is
        allowed to be.
        """
        codes = self.spec(action).get("applies_to_landcover")
        if codes:
            return np.isin(self.landcover, list(codes))
        return np.isin(self.landcover, list(GROUND_CODES))

    def sitable(self, action: str) -> np.ndarray:
        """Pixels where `action` breaks no rule in `config/siting.json`.

        Land cover says a tree may go on any ground pixel; this says that pixel
        may not be the travel lane, a crosswalk, a hydrant's clearance or ground
        already under a crown. The two are independent, so a placement has to
        satisfy both.
        """
        if self.siting is None:
            return np.ones(self.shape, dtype=bool)
        return self.siting.allowed(action)

    def placeable(self, action: str) -> np.ndarray:
        """`eligible & sitable` -- everywhere the auditor will accept."""
        return self.eligible(action) & self.sitable(action)

    def siting_failures(self, action: str, rows, cols) -> tuple[int, dict]:
        """(pixels breaking at least one siting rule, {rule: pixels}).

        Broken out per rule so the violation string names what to fix -- a plan
        rejected for the roadbed needs a different repair from one rejected for
        a hydrant clearance.
        """
        if self.siting is None:
            return 0, {}
        bad = np.zeros(np.asarray(rows).shape, dtype=bool)
        by_rule: dict[str, int] = {}
        for name, want in self.siting.rule_terms(action):
            hit = self.siting[name][rows, cols]
            fails = ~hit if want else hit
            if fails.any():
                by_rule[name] = int(fails.sum())
                # Some evidence is inferred rather than observed -- a sidewalk
                # width imputed from the nearest surveyed block, say. Say so, so
                # the next policy knows which rejections rest on a measurement.
                inferred = self.siting.inferred_mask(name)
                if inferred is not None:
                    guessed = int((fails & inferred[rows, cols]).sum())
                    if guessed:
                        by_rule[f"{name} (inferred)"] = guessed
                bad |= fails
        return int(bad.sum()), by_rule


# --------------------------------------------------------------------------- #
# Building the context
# --------------------------------------------------------------------------- #
def _read(path: Path, dtype: str = "float64") -> np.ndarray:
    with rasterio.open(path) as src:
        arr = src.read(1).astype(dtype)
        nod = src.nodata
    if nod is not None and dtype != "uint8":
        arr = np.where(arr == nod, np.nan, arr)
    return arr


def _tract_table():
    """Per-tract population and a citywide vulnerability percentile.

    The index is the mean of six exposure shares (older adults, children, people
    of colour, limited-English, low-to-no income, disability) as a fraction of
    tract population, then percentile-ranked across all 180 tracts so a single
    AOI's numbers stay comparable with every other AOI's.
    """
    import geopandas as gpd

    svi = gpd.read_file(SVI).to_crs(CRS)
    pop = svi["POP100_RE"].astype(float).to_numpy()
    denom = np.where(pop > 0, pop, np.nan)
    shares = np.stack(
        [np.clip(svi[c].astype(float).to_numpy() / denom, 0, 1) for c in SVI_SHARES]
    )
    # Tracts with no residents divide to all-NaN; they carry no weight anyway.
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        index = np.nanmean(shares, axis=0)
    index = np.where(np.isfinite(index), index, 0.0)
    rank = index.argsort().argsort()
    svi["_pop"] = pop
    svi["_vuln"] = rank / max(len(index) - 1, 1)
    svi["_tract_area"] = svi.geometry.area
    return svi


_TRACTS = None


def tracts():
    """The vulnerability table, loaded once per process."""
    global _TRACTS
    if _TRACTS is None:
        _TRACTS = _tract_table()
    return _TRACTS


def load_context(aoi_dir: Path) -> PlanningContext:
    """Assemble every grid a policy is allowed to see for one built AOI."""
    aoi_dir = Path(aoi_dir)
    meta = json.loads((aoi_dir / "aoi.json").read_text())
    res = float(meta["resolution_m"])
    bbox = tuple(meta["bbox_26986"])
    minx, _, _, maxy = bbox

    lc = _read(aoi_dir / "landcover.tif", "uint8")
    dsm = _read(aoi_dir / "dsm.tif")
    dem = _read(aoi_dir / "dem.tif")
    cdsm = np.nan_to_num(_read(aoi_dir / "cdsm.tif"), nan=0.0)
    shape = lc.shape

    bh = np.clip(np.where(lc == BUILDING, np.nan_to_num(dsm - dem, nan=0.0), 0.0), 0.0, None)
    heat = {
        key: np.nan_to_num(_read(aoi_dir / f"{key}.tif"), nan=0.0)
        for key in ("heat_ta3pm", "heat_ta3am", "heat_uhii", "heat_hours")
    }

    # Where a person can stand, and where an intervention is allowed to go. The
    # siting masks come off the city's sidewalk, hydrant, streetlight and
    # historic-district layers; see scripts/siting.py.
    walkable = np.isin(lc, list(GROUND_CODES))
    sit = siting.build(bbox, res, shape, lc, cdsm)
    exposure = sit["pedestrian"]

    # -- population and vulnerability, apportioned onto exposure pixels ------ #
    svi = tracts()
    transform = from_origin(minx, maxy, res, res)
    tract_id = rasterize(
        [(geom, i + 1) for i, geom in enumerate(svi.geometry)],
        out_shape=shape, transform=transform, fill=0, dtype="int32",
    )
    population = np.zeros(shape, dtype="float64")
    vulnerability = np.zeros(shape, dtype="float64")
    priority = np.zeros(shape, dtype=bool)

    vuln = svi["_vuln"].to_numpy()
    pop = svi["_pop"].to_numpy()
    tract_area = svi["_tract_area"].to_numpy()
    vuln_cut = float(np.quantile(vuln, 0.75))
    px_area = res * res
    for i in range(len(svi)):
        sel = tract_id == (i + 1)
        n_sel = int(sel.sum())
        if n_sel == 0:
            continue
        vulnerability[sel] = vuln[i]
        priority[sel] = vuln[i] >= vuln_cut
        # The share of the tract inside this AOI, then that many residents spread
        # evenly over the tract's pedestrian space here. It is a proxy for "who is
        # exposed on this street", not a claim about where anyone lives.
        share = min((n_sel * px_area) / tract_area[i], 1.0) if tract_area[i] > 0 else 0.0
        inside = sel & exposure
        n_inside = int(inside.sum())
        if n_inside:
            population[inside] = pop[i] * share / n_inside

    interventions = json.loads((CONFIG / "interventions.json").read_text())["interventions"]
    aois = json.loads((CONFIG / "aois.json").read_text())["aois"]
    name = meta["name"]

    # `plantable` and `buildable` are just the siting rules for the two actions
    # that carry every rule between them, kept as named grids because that is
    # what a policy reaches for first. Land-cover eligibility is folded in so a
    # policy that trusts them cannot fail the audit on either count.
    plantable = np.isin(lc, (PAVED, GRASS, BARE)) & sit.allowed("tree_medium")
    buildable = np.isin(lc, list(GROUND_CODES)) & sit.allowed("shade_canopy")

    return PlanningContext(
        name=name,
        split=aois.get(name, {}).get("split", "unknown"),
        res_m=res,
        bbox=bbox,
        shape=shape,
        landcover=lc,
        dsm=np.nan_to_num(dsm, nan=0.0),
        dem=np.nan_to_num(dem, nan=0.0),
        cdsm=cdsm,
        building_height=bh,
        heat_ta3pm=heat["heat_ta3pm"],
        heat_ta3am=heat["heat_ta3am"],
        heat_uhii=heat["heat_uhii"],
        heat_hours=heat["heat_hours"],
        population=population,
        vulnerability=vulnerability,
        priority=priority,
        walkable=walkable,
        walkway=sit["walkway"],
        crossing=sit["crossing"],
        roadbed=sit["roadbed"],
        design_review=sit["design_review"],
        city_owned=sit["city_owned"],
        exposure=exposure,
        plantable=plantable,
        buildable=buildable,
        sidewalk_width_m=sit.sidewalk_width_m,
        interventions=interventions,
        siting=sit,
    )


# --------------------------------------------------------------------------- #
# Pricing and applying a solution
# --------------------------------------------------------------------------- #
def price(ctx: PlanningContext, placements: list[Placement]) -> tuple:
    """(total USD, {action: USD}, {action: pixel count})."""
    by_action: dict[str, float] = {}
    counts: dict[str, int] = {}
    for p in placements:
        by_action[p.action] = by_action.get(p.action, 0.0) + ctx.cost(p.action, len(p))
        counts[p.action] = counts.get(p.action, 0) + len(p)
    return float(sum(by_action.values())), by_action, counts


@dataclass
class AppliedStack:
    """The edited raster stack, plus what the edit did.

    `albedo_override` and `emissivity_override` are NaN where the pixel keeps
    its land-cover value. `geometry_changed` says whether the sky-view-factor
    cache is invalidated -- the difference between a ~20 s `prepare` at 2 m and
    reusing the baseline's.
    """

    dsm: np.ndarray
    cdsm: np.ndarray
    landcover: np.ndarray
    albedo_override: np.ndarray
    emissivity_override: np.ndarray
    geometry_changed: bool
    stats: dict


def apply_placements(ctx: PlanningContext, placements: list[Placement]) -> AppliedStack:
    """Edit the AOI stack the way `config/interventions.json` describes.

    Three rules that are not obvious from the JSON:

    * A roof intervention never changes the land-cover code. SOLWEIG reads code
      2 as "building" for the ground-view-factor mask, so re-coding a green roof
      to grass would turn the roof into ground. Green and cool roofs are applied
      as per-pixel albedo and emissivity instead.
    * Shade and solar canopies are carried in the CDSM, so they shade like
      vegetation. SOLWEIG's shortwave transmissivity is a single global number,
      so a cloth canopy's 0.5 transmission cannot be expressed per pixel; the
      auditor records that as a known bias rather than quietly fudging it.
    * Trees paint a flat-topped disc of the configured crown radius, matching how
      `build_aoi.py` painted the existing canopy from the 2024 crown inventory.
    """
    dsm = ctx.dsm.copy()
    cdsm = ctx.cdsm.copy()
    lc = ctx.landcover.copy()
    alb = np.full(ctx.shape, np.nan, dtype="float32")
    emis = np.full(ctx.shape, np.nan, dtype="float32")
    geometry_changed = False

    px = ctx.pixel_area_m2
    stats = {
        "canopy_added_m2": 0.0,
        "green_added_m2": 0.0,
        "albedo_treated_m2": 0.0,
        "built_shade_m2": 0.0,
        "pv_area_m2": 0.0,
        "trees_planted": 0,
        "by_action_units": {},
    }

    for p in placements:
        spec = ctx.spec(p.action)
        edit = spec.get("raster_edit", {})
        n = len(p)
        stats["by_action_units"][p.action] = stats["by_action_units"].get(p.action, 0) + n
        if n == 0:
            continue
        rows, cols = p.rows, p.cols

        height = edit.get("cdsm_height_m")
        radius = edit.get("crown_radius_m")
        if height is not None:
            geometry_changed = True
            if radius:
                before = cdsm > 0
                _paint_discs(cdsm, rows, cols, float(height), float(radius), ctx.res_m)
                stats["canopy_added_m2"] += float((~before & (cdsm > 0)).sum()) * px
                stats["trees_planted"] += n
            else:
                cdsm[rows, cols] = np.maximum(cdsm[rows, cols], float(height))
                stats["built_shade_m2"] += n * px
                if p.action == "solar_canopy":
                    stats["pv_area_m2"] += n * px

        new_lc = edit.get("landcover")
        if isinstance(new_lc, int):
            ground = lc[rows, cols] != BUILDING  # roof rule, see the docstring
            lc[rows[ground], cols[ground]] = new_lc
            if new_lc in (GRASS, DECIDUOUS, EVERGREEN):
                stats["green_added_m2"] += float(ground.sum()) * px

        new_alb = edit.get("albedo")
        if isinstance(new_alb, (int, float)):
            alb[rows, cols] = float(new_alb)
            stats["albedo_treated_m2"] += n * px
            if new_lc == GRASS:
                emis[rows, cols] = 0.94  # the grass class in solweig's materials

    stats["pv_mwh_per_yr"] = round(stats["pv_area_m2"] * PV_KWH_PER_M2_YR / 1000.0, 1)
    return AppliedStack(dsm, cdsm, lc, alb, emis, geometry_changed, stats)


def _paint_discs(cdsm: np.ndarray, rows, cols, height: float, radius: float, res: float) -> None:
    """Flat-topped crowns, taking the max so overlapping crowns do not stack."""
    h, w = cdsm.shape
    rp = max(radius / res, 0.5)
    span = int(np.ceil(rp))
    yy, xx = np.ogrid[-span:span + 1, -span:span + 1]
    disc = (xx ** 2 + yy ** 2) <= rp ** 2
    for r, c in zip(rows, cols):
        r0, r1 = max(0, r - span), min(h, r + span + 1)
        c0, c1 = max(0, c - span), min(w, c + span + 1)
        sub = disc[r0 - (r - span):r1 - (r - span), c0 - (c - span):c1 - (c - span)]
        patch = cdsm[r0:r1, c0:c1]
        np.maximum(patch, np.where(sub, height, 0.0).astype(patch.dtype), out=patch)
