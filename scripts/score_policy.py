"""Score one SHADE policy: plan, audit, simulate, and emit the objective vector.

    python scripts/score_policy.py --policy policies/baseline_policy.py \
        --aoi dudley_square --budget 500000

    python scripts/score_policy.py --policy policies/my_policy.py \
        --aois train --scenarios baseline,warm_2c --budget 2000000

This is the half of the autoresearch loop that does not talk to the LLM. It takes a
policy module, runs it on every requested AOI, checks that what it asked for is
legal and affordable, edits the raster stack accordingly, runs SOLWEIG twice
(baseline and intervention), and writes `score.json` -- the multi-objective
feedback the next prompt is built from.

The objective vector, all "higher is better":

    heat_relief_c        population-weighted drop in daytime UTCI on pedestrian space
    access_gain_pp       share of exposed residents moved below the UTCI threshold
    equity_ratio         relief in the top-vulnerability quartile / relief overall
    cobenefit_greened_pct   new green and canopy as a share of walkable ground
    cost_efficiency      person-degC of relief bought per $100k
    worst_aoi_*          the same relief at the AOI that gained least
    worst_scenario_*     ... and at the climate scenario that held up worst

plus `tmrt_relief_c` as a *diagnostic*, not a score. Tmrt and UTCI diverge exactly
where the albedo trap lives: reflective pavement moves surface temperature and
barely moves what a person feels. Reporting both makes a policy that chases the
wrong metric visible instead of merely unrewarded.

Feasibility is all-or-nothing and is settled before any simulation runs. A policy
that overspends, places an action on land cover it is not allowed on, double-books
a pixel, indexes outside the grid, or takes longer than `--plan-timeout` to decide
scores nothing; `score.json` carries the violations instead of the objectives, so
the next prompt can be told exactly what was wrong.
"""

from __future__ import annotations

import argparse
import copy
import csv
import importlib.util
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

# conda's GDAL data files are not found when the interpreter is invoked directly
# rather than through `conda activate`. Must precede the rasterio import.
_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
# SOLWEIG logs arrows and check marks; the Windows console is cp1252 by default.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import rasterio

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import solweig
from policy_api import (
    AppliedStack,
    PlanningContext,
    apply_placements,
    load_context,
    normalise_placements,
    price,
)

ROOT = SCRIPTS.parent
AOI_DIR = ROOT / "data" / "aoi"
SCENARIO_DIR = ROOT / "data" / "weather" / "scenarios"
RUNS = ROOT / "runs"
# Persistent, policy-independent caches. The SVF/wall cache is keyed by AOI and
# survives across policies; the baseline summary cache is keyed by the weather
# window as well, because it is a full SOLWEIG run.
SVF_CACHE = RUNS / "_svf_cache"
BASELINE_CACHE = RUNS / "_baseline_cache"
SCORE_LOG = RUNS / "score_log.csv"

# UTCI (degC) above which a pedestrian is in strong heat stress. The access
# objective counts residents whose daytime mean crosses back below it.
ACCESS_THRESHOLD_C = 32.0

KNOWN_BIASES = [
    "Shade cloth and PV canopies are carried in the CDSM and shaded with SOLWEIG's "
    "single global vegetation transmissivity (0.08). A cloth canopy's 0.5 solar "
    "transmission cannot be expressed per pixel, so built shade is modelled slightly "
    "too dark relative to config/interventions.json.",
    "Unit costs in config/interventions.json are order-of-magnitude figures from other "
    "cities, not Boston capital-budget numbers. cost_efficiency ranks policies against "
    "each other; its absolute value means little.",
    "Climate scenarios are uniform dry-bulb shifts of the baseline EPW, not downscaled "
    "projections. They answer 'does this hold up when it gets hotter' and nothing more.",
    "Population is a tract-share proxy spread over pedestrian pixels, not a claim about "
    "where anyone lives or stands.",
    "Scores are only comparable at a fixed resolution: coarsening biases mean Tmrt warm.",
    "access_gain_pp is measured against a fixed UTCI threshold, so it saturates in the "
    "warmer scenarios: when almost nobody can be moved below it, the objective goes "
    "quiet even though the relief is real. Read it next to unshaded_pct_before.",
]


# --------------------------------------------------------------------------- #
# Per-pixel albedo and emissivity
# --------------------------------------------------------------------------- #
_ORIG_LC_PROPS = solweig.SurfaceData.get_land_cover_properties


def _override(grid: np.ndarray, values) -> np.ndarray:
    """Replace `grid` where `values` is finite, leaving land-cover values elsewhere."""
    if values is None:
        return grid
    ov = np.asarray(values, dtype="float32")
    if ov.shape != grid.shape:
        return grid
    keep = np.isfinite(ov)
    if not keep.any():
        return grid
    out = np.array(grid, copy=True)
    out[keep] = ov[keep].astype(out.dtype)
    return out


def _lc_props_with_overrides(self, params=None):
    """`get_land_cover_properties`, honouring per-pixel albedo and emissivity.

    SOLWEIG derives both from the land-cover grid whenever one is present, so
    there is no supported way to say "this roof is reflective" without changing
    its land-cover code -- and code 2 is what marks a pixel as a building, so
    recoding a cool roof would drop it to ground level in the ground-view-factor
    mask. Patching here instead keeps the geometry honest.

    The patch is on the *class*, not the instance: `calculate` copies SurfaceData
    for tiling and per-timestep state, and a copy carries the array attributes
    (`albedo`, `emissivity`, `land_cover`) but not an instance-level method.
    """
    alb, emis, tgk, tstart, tmaxlst = _ORIG_LC_PROPS(self, params)
    if getattr(self, "land_cover", None) is None:
        return alb, emis, tgk, tstart, tmaxlst
    alb = _override(alb, getattr(self, "albedo", None))
    emis = _override(emis, getattr(self, "emissivity", None))
    return alb, emis, tgk, tstart, tmaxlst


solweig.SurfaceData.get_land_cover_properties = _lc_props_with_overrides


# --------------------------------------------------------------------------- #
# Loading the policy
# --------------------------------------------------------------------------- #
class PolicyTimeout(RuntimeError):
    pass


def load_policy(path: Path):
    """Import a policy module from a file path, with `scripts/` importable."""
    path = Path(path).resolve()
    spec = importlib.util.spec_from_file_location(f"shade_policy_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import a policy from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "plan"):
        raise SystemExit(f"{path.name} defines no plan(ctx, budget_usd)")
    return module


def call_plan(policy, ctx: PlanningContext, budget: float, timeout: float):
    """Run `plan` under a wall-clock limit; a policy that hangs is infeasible.

    The worker is a daemon thread rather than a process: the context is large and
    would have to be pickled, and a policy that never returns costs us the thread
    but not the run.
    """
    box: dict = {}

    def target():
        try:
            box["out"] = policy.plan(ctx, budget)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            box["err"] = exc

    thread = threading.Thread(target=target, daemon=True, name=f"plan-{ctx.name}")
    t0 = time.time()
    thread.start()
    thread.join(timeout)
    elapsed = time.time() - t0
    if thread.is_alive():
        raise PolicyTimeout(f"plan() exceeded {timeout:.0f}s on {ctx.name}")
    if "err" in box:
        raise box["err"]
    return box.get("out"), elapsed


# --------------------------------------------------------------------------- #
# The feasibility audit
# --------------------------------------------------------------------------- #
def audit(ctx: PlanningContext, placements, budget_usd: float) -> tuple[list[str], dict]:
    """Check a solution before a single second of SOLWEIG is spent.

    Every rule here is one the LLM can read off the violation string and fix, so
    the messages carry counts and the offending land-cover codes rather than just
    saying no.
    """
    problems: list[str] = []
    rows_n, cols_n = ctx.shape
    claimed = np.zeros(ctx.shape, dtype=bool)
    priceable = []  # an unknown action has no price, so it cannot be billed

    for i, p in enumerate(placements):
        if p.action not in ctx.interventions:
            problems.append(
                f"placement {i}: unknown action {p.action!r}; "
                f"choose from {sorted(ctx.interventions)}"
            )
            continue
        priceable.append(p)
        if len(p) == 0:
            continue

        oob = (p.rows < 0) | (p.rows >= rows_n) | (p.cols < 0) | (p.cols >= cols_n)
        if oob.any():
            problems.append(
                f"{p.action}: {int(oob.sum())} of {len(p)} pixels fall outside the "
                f"{rows_n}x{cols_n} grid"
            )
            continue

        eligible = ctx.eligible(p.action)
        bad = ~eligible[p.rows, p.cols]
        if bad.any():
            codes = sorted(int(c) for c in np.unique(ctx.landcover[p.rows[bad], p.cols[bad]]))
            allowed = ctx.spec(p.action).get("applies_to_landcover") or "any ground"
            problems.append(
                f"{p.action}: {int(bad.sum())} pixels on land cover {codes}, "
                f"but the action applies to {allowed}"
            )

        flat = p.rows.astype(np.int64) * cols_n + p.cols.astype(np.int64)
        repeats = len(flat) - len(np.unique(flat))
        if repeats:
            problems.append(f"{p.action}: {repeats} pixels listed more than once")
        overlap = int(claimed[p.rows, p.cols].sum())
        if overlap:
            problems.append(f"{p.action}: {overlap} pixels already taken by an earlier action")
        claimed[p.rows, p.cols] = True

    total, by_action, counts = price(ctx, priceable)
    # A cent of float slop on a million-dollar budget is not an overspend.
    if total > budget_usd + 1e-6:
        problems.append(
            f"budget: spends ${total:,.0f} of ${budget_usd:,.0f} "
            f"(${total - budget_usd:,.0f} over)"
        )

    spend = {
        "total_usd": round(total, 2),
        "by_action_usd": {k: round(v, 2) for k, v in by_action.items()},
        "by_action_units": counts,
        "budget_usd": budget_usd,
        "share_of_budget": round(total / budget_usd, 4) if budget_usd > 0 else None,
    }
    return problems, spend


# --------------------------------------------------------------------------- #
# Running SOLWEIG
# --------------------------------------------------------------------------- #
def _window(surface, ctx: PlanningContext) -> tuple[slice, slice]:
    """Map the prepared surface back onto the AOI grid.

    `prepare` crops to the valid bounding box when the edges are nodata, so the
    surface can be smaller than the AOI. Every mask the objectives use lives on
    the AOI grid and has to be sliced to match, or population would be read from
    the wrong pixels.
    """
    shape = surface.dsm.shape
    gt = surface.geotransform
    if gt is None:
        return slice(0, shape[0]), slice(0, shape[1])
    minx, _, _, maxy = ctx.bbox
    c0 = int(round((gt[0] - minx) / ctx.res_m))
    r0 = int(round((maxy - gt[3]) / ctx.res_m))
    return slice(r0, r0 + shape[0]), slice(c0, c0 + shape[1])


def _day_grid(summary, day_attr: str, all_attr: str) -> np.ndarray:
    """The daytime grid when there were daytime timesteps, else the all-hours one."""
    day = np.asarray(getattr(summary, day_attr), dtype="float64")
    if np.isfinite(day).any():
        return day
    return np.asarray(getattr(summary, all_attr), dtype="float64")


def _weather(epw: Path, date: str, hours: list[int]):
    # from_epw defaults to the file's FIRST day only, so the window is explicit.
    picked = solweig.Weather.from_epw(str(epw), start=date, end=date, hours=hours)
    if not picked:
        raise SystemExit(f"no EPW rows in {epw.name} for {date} hours {hours}")
    return picked


def _simulate(surface, epw: Path, date: str, hours: list[int], out_dir: Path) -> dict:
    location = solweig.Location.from_epw(str(epw))
    summary = solweig.calculate(
        surface=surface,
        weather=_weather(epw, date, hours),
        location=location,
        output_dir=str(out_dir),
    )
    return {
        "utci": _day_grid(summary, "utci_day_mean", "utci_mean"),
        "tmrt": _day_grid(summary, "tmrt_day_mean", "tmrt_mean"),
        "shade_hours": np.asarray(summary.shade_hours, dtype="float64"),
        "n_timesteps": int(summary.n_timesteps),
    }


def baseline_surface(ctx: PlanningContext, aoi_dir: Path, force: bool = False):
    """Prepare the untouched AOI, reusing the SVF/wall cache across policies."""
    cache = SVF_CACHE / f"{ctx.name}_{ctx.res_m:g}m"
    cache.mkdir(parents=True, exist_ok=True)
    return solweig.SurfaceData.prepare(
        dsm=str(aoi_dir / "dsm.tif"),
        cdsm=str(aoi_dir / "cdsm.tif"),
        dem=str(aoi_dir / "dem.tif"),
        land_cover=str(aoi_dir / "landcover.tif"),
        working_dir=str(cache),
        force_recompute=force,
    )


def baseline_result(ctx, surface, win, epw, scenario, date, hours, out_dir):
    """The untouched AOI's summary grids, cached per weather window on disk.

    The baseline does not depend on the policy, so every policy the loop ever
    proposes reads this from disk instead of paying for it.
    """
    BASELINE_CACHE.mkdir(parents=True, exist_ok=True)
    tag = f"{ctx.name}_{ctx.res_m:g}m__{scenario}__{date}__{'-'.join(str(h) for h in hours)}"
    path = BASELINE_CACHE / f"{tag}.npz"
    if path.exists():
        with np.load(path) as z:
            cached = {k: z[k] for k in z.files}
        if cached["row0"] == win[0].start and cached["col0"] == win[1].start:
            return {
                "utci": cached["utci"],
                "tmrt": cached["tmrt"],
                "shade_hours": cached["shade_hours"],
                "n_timesteps": int(cached["n_timesteps"]),
            }, True
        print(f"  baseline cache for {tag} is on a different window; recomputing")

    result = _simulate(surface, epw, date, hours, out_dir / "baseline")
    np.savez_compressed(
        path,
        utci=result["utci"].astype("float32"),
        tmrt=result["tmrt"].astype("float32"),
        shade_hours=result["shade_hours"].astype("float32"),
        n_timesteps=result["n_timesteps"],
        row0=win[0].start,
        col0=win[1].start,
    )
    return result, False


def _write_edited(aoi_dir: Path, out_dir: Path, ctx: PlanningContext,
                  applied: AppliedStack) -> tuple[Path, Path]:
    """Write the edited CDSM and land cover, keeping each source's nodata intact.

    The edits are applied as a *delta* on the file on disk rather than by writing
    `ctx`'s NaN-filled arrays: a nodata pixel written out as 0 m would be valid
    ground to `prepare`, which would change the valid mask and crop the
    intervention to a different window than the baseline.
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    with rasterio.open(aoi_dir / "cdsm.tif") as src:
        profile = src.profile
        orig = src.read(1)
        nod = src.nodata
    delta = (applied.cdsm - ctx.cdsm).astype(orig.dtype, copy=False)
    edited = orig + delta
    if nod is not None:
        edited = np.where(orig == nod, orig, edited)
    cdsm_path = out_dir / "cdsm.tif"
    with rasterio.open(cdsm_path, "w", **profile) as dst:
        dst.write(edited, 1)

    with rasterio.open(aoi_dir / "landcover.tif") as src:
        profile = src.profile
        orig_lc = src.read(1)
        nod = src.nodata
    changed = applied.landcover != ctx.landcover
    edited_lc = np.where(changed, applied.landcover.astype(orig_lc.dtype), orig_lc)
    if nod is not None:
        edited_lc = np.where(orig_lc == nod, orig_lc, edited_lc)
    lc_path = out_dir / "landcover.tif"
    with rasterio.open(lc_path, "w", **profile) as dst:
        dst.write(edited_lc, 1)

    return cdsm_path, lc_path


def intervention_surface(ctx, aoi_dir, base_surface, win, applied, out_dir, force=False):
    """The edited AOI, recomputing sky-view factors only when geometry moved.

    This is the caching boundary that governs the cost of a search: trees and
    canopies change the shadow geometry and force a fresh `prepare` (~21 s at
    2 m); albedo and land-cover edits do not, and reuse the baseline's SVF and
    wall geometry outright.
    """
    lc = applied.landcover[win].astype("uint8")
    base_lc = base_surface.land_cover
    if base_lc is not None:
        lc = np.where(base_lc == 255, 255, lc).astype("uint8")
    alb = applied.albedo_override[win].astype("float32")
    emis = applied.emissivity_override[win].astype("float32")

    if not applied.geometry_changed:
        surface = copy.copy(base_surface)
        surface.land_cover = lc
        surface.albedo = alb
        surface.emissivity = emis
        return surface, False

    stack = out_dir / "stack"
    cdsm_path, lc_path = _write_edited(aoi_dir, stack, ctx, applied)
    surface = solweig.SurfaceData.prepare(
        dsm=str(aoi_dir / "dsm.tif"),
        cdsm=str(cdsm_path),
        dem=str(aoi_dir / "dem.tif"),
        land_cover=str(lc_path),
        working_dir=str(out_dir / "cache"),
        force_recompute=force,
    )
    new_win = _window(surface, ctx)
    if (new_win[0].start, new_win[1].start) != (win[0].start, win[1].start) \
            or surface.dsm.shape != base_surface.dsm.shape:
        raise RuntimeError(
            f"{ctx.name}: the edited stack cropped to a different window than the "
            f"baseline ({new_win} vs {win}); the two runs are not comparable"
        )
    surface.albedo = alb
    surface.emissivity = emis
    return surface, True


# --------------------------------------------------------------------------- #
# The objectives
# --------------------------------------------------------------------------- #
def _wmean(values: np.ndarray, weights: np.ndarray) -> float | None:
    total = float(weights.sum())
    if total <= 0:
        return None
    return float((values * weights).sum() / total)


def objectives(ctx, win, base, interv, applied, spend, threshold_c) -> dict:
    """One AOI, one scenario: what the intervention bought and for whom."""
    exposure = ctx.exposure[win]
    pop = np.where(exposure, ctx.population[win], 0.0)
    priority = ctx.priority[win] & exposure

    finite = np.isfinite(base["utci"]) & np.isfinite(interv["utci"])
    weight = np.where(finite, pop, 0.0)
    relief = np.where(finite, base["utci"] - interv["utci"], 0.0)

    tmrt_finite = np.isfinite(base["tmrt"]) & np.isfinite(interv["tmrt"])
    tmrt_relief = np.where(tmrt_finite, base["tmrt"] - interv["tmrt"], 0.0)

    heat_relief = _wmean(relief, weight)
    priority_weight = np.where(priority, weight, 0.0)
    equity_relief = _wmean(relief, priority_weight)
    pop_total = float(weight.sum())

    # Access: residents whose daytime mean crosses back under the stress
    # threshold, net of any pushed the other way.
    was_over = base["utci"] > threshold_c
    now_under = interv["utci"] <= threshold_c
    gained = float(weight[finite & was_over & now_under].sum())
    lost = float(weight[finite & ~was_over & ~now_under].sum())
    access_pp = 100.0 * (gained - lost) / pop_total if pop_total > 0 else None

    stats = applied.stats
    ground_m2 = float(ctx.walkable.sum()) * ctx.pixel_area_m2
    greened = stats["green_added_m2"] + stats["canopy_added_m2"]
    person_degc = float((relief * weight).sum())
    total_cost = spend["total_usd"]

    return {
        "heat_relief_c": _round(heat_relief),
        "access_gain_pp": _round(access_pp),
        # A ratio of two negatives reads as "concentrated on the vulnerable" when
        # it actually means they were hurt most, so the ratio is only defined
        # when the policy cooled anyone at all. `equity_relief_c` keeps the sign.
        "equity_ratio": _round(equity_relief / heat_relief)
        if heat_relief is not None and equity_relief is not None
        and heat_relief > 0.01 else None,
        "equity_relief_c": _round(equity_relief),
        # How much of the AOI's exposed population the equity terms speak for. A
        # ratio computed off a hundred people in a sliver of one tract is noise,
        # and there is no way to tell that from the ratio alone.
        "equity_pop_share": _round(
            float(priority_weight.sum()) / pop_total if pop_total > 0 else None
        ),
        "cobenefit_greened_pct": _round(100.0 * greened / ground_m2 if ground_m2 else None),
        "pv_mwh_per_yr": stats["pv_mwh_per_yr"],
        "cost_efficiency_person_c_per_100k": _round(
            person_degc / (total_cost / 1e5) if total_cost > 0 else None
        ),
        "tmrt_relief_c": _round(_wmean(tmrt_relief, weight)),
        "shade_hours_gain": _round(
            _wmean(interv["shade_hours"] - base["shade_hours"], weight)
        ),
        "person_degc": _round(person_degc, 1),
        "pop_exposed": _round(pop_total, 1),
        "unshaded_pct_before": _round(
            100.0 * float(weight[finite & was_over].sum()) / pop_total
            if pop_total > 0 else None
        ),
    }


def _round(value, digits: int = 3):
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return None
    return round(float(value), digits)


def aggregate(runs: list[dict]) -> dict:
    """Roll per-AOI, per-scenario results into the vector the LLM sees.

    Means answer "how well does this do"; the two `worst_*` terms answer "where
    does it fall over", which is the question a policy that only works on one
    kind of street will fail. Cost efficiency is pooled rather than averaged so
    a cheap AOI cannot carry an expensive one.
    """
    def mean_of(key: str, rows) -> float | None:
        vals = [r["metrics"][key] for r in rows if r["metrics"].get(key) is not None]
        return _round(float(np.mean(vals))) if vals else None

    by_aoi: dict[str, list] = {}
    by_scenario: dict[str, list] = {}
    for r in runs:
        by_aoi.setdefault(r["aoi"], []).append(r)
        by_scenario.setdefault(r["scenario"], []).append(r)

    aoi_relief = {a: mean_of("heat_relief_c", rows) for a, rows in by_aoi.items()}
    scen_relief = {s: mean_of("heat_relief_c", rows) for s, rows in by_scenario.items()}
    worst_aoi = min(
        ((v, a) for a, v in aoi_relief.items() if v is not None), default=(None, None)
    )
    worst_scen = min(
        ((v, s) for s, v in scen_relief.items() if v is not None), default=(None, None)
    )

    person_degc = sum(r["metrics"]["person_degc"] or 0.0 for r in runs)
    # One AOI's spend is the same in every scenario, so pool over AOIs only.
    spend = sum(rows[0]["spend_usd"] for rows in by_aoi.values())
    scenarios = max(len(by_scenario), 1)

    return {
        "heat_relief_c": mean_of("heat_relief_c", runs),
        "access_gain_pp": mean_of("access_gain_pp", runs),
        "equity_ratio": mean_of("equity_ratio", runs),
        "cobenefit_greened_pct": mean_of("cobenefit_greened_pct", runs),
        "cost_efficiency_person_c_per_100k": _round(
            (person_degc / scenarios) / (spend / 1e5) if spend > 0 else None
        ),
        "worst_aoi_heat_relief_c": worst_aoi[0],
        "worst_aoi": worst_aoi[1],
        "worst_scenario_heat_relief_c": worst_scen[0],
        "worst_scenario": worst_scen[1],
        "tmrt_relief_c": mean_of("tmrt_relief_c", runs),
        "pv_mwh_per_yr": _round(
            sum(rows[0]["metrics"]["pv_mwh_per_yr"] or 0.0 for rows in by_aoi.values()), 1
        ),
        "spend_usd": _round(spend, 2),
        "per_aoi_heat_relief_c": aoi_relief,
        "per_scenario_heat_relief_c": scen_relief,
    }


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #
def resolve_aois(args) -> list[str]:
    aois = json.loads((ROOT / "config" / "aois.json").read_text())["aois"]
    if args.aoi:
        names = [a.strip() for a in args.aoi.split(",") if a.strip()]
    elif args.aois in ("train", "held_out"):
        names = [n for n, meta in aois.items() if meta.get("split") == args.aois]
    elif args.aois == "all":
        names = list(aois)
    else:
        raise SystemExit(f"unknown --aois {args.aois!r}")
    if not names:
        raise SystemExit("no AOIs selected")

    held = [n for n in names if aois.get(n, {}).get("split") == "held_out"]
    if held and not args.allow_held_out:
        raise SystemExit(
            f"{held} are held out. Tuning against them invalidates the split; "
            f"pass --allow-held-out for a final evaluation."
        )
    return names


def aoi_path(name: str, res: float) -> Path:
    path = AOI_DIR / (name if abs(res - 2.0) < 1e-9 else f"{name}_{res:g}m")
    if not (path / "aoi.json").exists():
        raise SystemExit(f"{path} is not built; run scripts/build_aoi.py --aoi {name}")
    return path


def write_log(row: dict) -> None:
    """Append one run to the cross-policy log, honouring the header already there.

    The log outlives any one version of this script, so the columns are taken from
    the existing header when there is one. Writing `row`'s own keys instead would
    silently shift every column the day a metric is added or renamed.
    """
    RUNS.mkdir(parents=True, exist_ok=True)
    fields = list(row)
    if SCORE_LOG.exists():
        with open(SCORE_LOG, newline="", encoding="utf-8") as fh:
            header = next(csv.reader(fh), None)
        if header:
            fields = header
            missing = [k for k in row if k not in header]
            if missing:
                print(f"  note: {SCORE_LOG.name} has no column for {missing}; "
                      f"delete or rename it to log them")
    with open(SCORE_LOG, "a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, restval="", extrasaction="ignore")
        if fh.tell() == 0:
            writer.writeheader()
        writer.writerow(row)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--policy", default="policies/baseline_policy.py")
    ap.add_argument("--aoi", help="comma-separated AOI names; overrides --aois")
    ap.add_argument("--aois", default="train", choices=["train", "held_out", "all"])
    ap.add_argument("--allow-held-out", action="store_true")
    ap.add_argument("--scenarios", default="baseline",
                    help="comma-separated scenario names from data/weather/scenarios")
    ap.add_argument("--budget", type=float, default=500_000.0, help="USD per AOI")
    ap.add_argument("--res", type=float, default=2.0)
    ap.add_argument("--date", default="07-27", help="MM-DD to simulate")
    ap.add_argument("--hours", default="10,13,16")
    ap.add_argument("--access-threshold", type=float, default=ACCESS_THRESHOLD_C)
    ap.add_argument("--plan-timeout", type=float, default=120.0,
                    help="seconds a policy may spend deciding, per AOI")
    ap.add_argument("--out", help="run directory (default runs/score_<policy>_<stamp>)")
    ap.add_argument("--force-prepare", action="store_true",
                    help="recompute sky-view factors even when cached")
    ap.add_argument("--gpu", action="store_true",
                    help="leave the GPU enabled. Off by default: an integrated GPU "
                         "reporting little VRAM collapses SVF tiling and never "
                         "finishes. See DATA_MANIFEST.md section 8.")
    args = ap.parse_args()

    if not args.gpu:
        # Must precede every other solweig call: max_tile_side is cached.
        solweig.disable_gpu()

    policy_path = (ROOT / args.policy) if not Path(args.policy).is_absolute() else Path(args.policy)
    policy = load_policy(policy_path)
    hours = sorted(int(h) for h in args.hours.split(","))
    scenarios = [s.strip() for s in args.scenarios.split(",") if s.strip()]
    names = resolve_aois(args)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_root = Path(args.out) if args.out else RUNS / f"score_{policy_path.stem}_{stamp}"
    out_root.mkdir(parents=True, exist_ok=True)

    report = {
        "policy": {
            "module": str(policy_path.relative_to(ROOT)) if policy_path.is_relative_to(ROOT)
            else str(policy_path),
            "name": getattr(policy, "POLICY_NAME", policy_path.stem),
            "description": getattr(policy, "DESCRIPTION", ""),
        },
        "run": {
            "timestamp_utc": stamp,
            "aois": names,
            "scenarios": scenarios,
            "budget_usd_per_aoi": args.budget,
            "resolution_m": args.res,
            "date": args.date,
            "hours": hours,
            "access_threshold_c": args.access_threshold,
            "output_dir": str(out_root),
        },
        "known_biases": KNOWN_BIASES,
    }

    # -- Phase 1: plan and audit every AOI before spending a second on SOLWEIG - #
    print(f"policy   {report['policy']['name']}")
    print(f"AOIs     {', '.join(names)}")
    print(f"budget   ${args.budget:,.0f} per AOI over {len(scenarios)} scenario(s)\n")

    plans: dict[str, dict] = {}
    violations: dict[str, list[str]] = {}
    for name in names:
        aoi_dir = aoi_path(name, args.res)
        ctx = load_context(aoi_dir)
        try:
            raw, elapsed = call_plan(policy, ctx, args.budget, args.plan_timeout)
            placements = normalise_placements(raw)
        except PolicyTimeout as exc:
            violations[name] = [str(exc)]
            continue
        except Exception as exc:  # noqa: BLE001 - the policy is LLM-written
            violations[name] = [f"plan() raised {type(exc).__name__}: {exc}"]
            continue

        problems, spend = audit(ctx, placements, args.budget)
        if problems:
            violations[name] = problems
        plans[name] = {
            "split": ctx.split,
            "spend": spend,
            "plan_seconds": round(elapsed, 2),
            "placements": [
                {"action": p.action, "rows": p.rows, "cols": p.cols} for p in placements
            ],
        }
        units = ", ".join(f"{k} x{v}" for k, v in spend["by_action_units"].items()) or "nothing"
        print(f"  {name:22s} {units}  ${spend['total_usd']:,.0f}  ({elapsed:.1f}s)")
        # Placements are the solution; keep them next to the score.
        np.savez_compressed(
            out_root / f"solution_{name}.npz",
            **{f"{i}_{p.action}": np.stack([p.rows, p.cols]) for i, p in enumerate(placements)},
        )
        del ctx

    if violations:
        report["verdict"] = "infeasible"
        report["violations"] = violations
        report["objectives"] = None
        (out_root / "score.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("\nINFEASIBLE -- nothing was simulated:")
        for name, problems in violations.items():
            for problem in problems:
                print(f"  {name}: {problem}")
        print(f"\n-> {out_root / 'score.json'}")
        return

    # -- Phase 2: simulate -------------------------------------------------- #
    runs: list[dict] = []
    for name in names:
        aoi_dir = aoi_path(name, args.res)
        ctx = load_context(aoi_dir)
        placements = normalise_placements(plans[name]["placements"])
        applied = apply_placements(ctx, placements)
        spend = plans[name]["spend"]

        t0 = time.time()
        base_surface = baseline_surface(ctx, aoi_dir, force=args.force_prepare)
        win = _window(base_surface, ctx)
        # Both surfaces are weather-independent, so they are built once per AOI
        # and reused across every scenario. Rebuilding inside the scenario loop
        # would pay for the same sky-view factors once per EPW.
        surface, rebuilt = intervention_surface(
            ctx, aoi_dir, base_surface, win, applied, out_root / name,
            force=args.force_prepare,
        )
        print(f"\n{name}: surfaces ready in {time.time() - t0:.1f}s"
              f"{'' if rebuilt else '  (geometry unchanged, SVF reused)'}")

        for scenario in scenarios:
            epw = SCENARIO_DIR / f"boston_{scenario}.epw"
            if not epw.exists():
                raise SystemExit(f"no weather scenario {scenario!r} at {epw}")
            run_dir = out_root / name / scenario

            t0 = time.time()
            base, cached = baseline_result(
                ctx, base_surface, win, epw, scenario, args.date, hours, run_dir
            )
            interv = _simulate(surface, epw, args.date, hours, run_dir / "intervention")
            seconds = time.time() - t0

            metrics = objectives(ctx, win, base, interv, applied, spend, args.access_threshold)
            runs.append({
                "aoi": name,
                "split": ctx.split,
                "scenario": scenario,
                "spend_usd": spend["total_usd"],
                "n_timesteps": interv["n_timesteps"],
                "baseline_cached": cached,
                "svf_recomputed": rebuilt,
                "seconds": round(seconds, 1),
                "metrics": metrics,
            })
            print(f"  {scenario:12s} relief {metrics['heat_relief_c']} degC UTCI  "
                  f"(Tmrt {metrics['tmrt_relief_c']})  access {metrics['access_gain_pp']} pp  "
                  f"equity {metrics['equity_ratio']}  [{seconds:.0f}s]")

            write_log({
                "timestamp_utc": stamp,
                "policy": report["policy"]["name"],
                "module": report["policy"]["module"],
                "aoi": name,
                "split": ctx.split,
                "scenario": scenario,
                "res_m": args.res,
                "budget_usd": args.budget,
                "spend_usd": spend["total_usd"],
                **{k: v for k, v in metrics.items()},
            })
        del ctx

    report["verdict"] = "feasible"
    report["violations"] = {}
    report["objectives"] = aggregate(runs)
    report["runs"] = runs
    report["spend"] = {name: plans[name]["spend"] for name in names}
    (out_root / "score.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    obj = report["objectives"]
    print("\nobjectives")
    for key in ("heat_relief_c", "access_gain_pp", "equity_ratio",
                "cobenefit_greened_pct", "cost_efficiency_person_c_per_100k",
                "worst_aoi_heat_relief_c", "worst_scenario_heat_relief_c",
                "tmrt_relief_c"):
        print(f"  {key:36s} {obj[key]}")
    print(f"\n-> {out_root / 'score.json'}")
    print(f"-> {SCORE_LOG}")


if __name__ == "__main__":
    main()
