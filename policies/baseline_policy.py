"""Seed policy for the SHADE autoresearch loop.

This is the file the LLM rewrites. It is deliberately simple and legible: a
weighted priority surface, a greedy spend, and one explicit budget split. Every
number in `WEIGHTS` and `SPLIT` is a knob a later policy may move, remove, or
replace with a different decision structure entirely.

The contract (see `scripts/policy_api.py` for the full context object):

    plan(ctx, budget_usd) -> list[Placement]

    * `ctx` holds the AOI's grids -- land cover, terrain, canopy, the city heat
      model, population, vulnerability, and the masks that say where a person
      can actually stand.
    * A `Placement` is one action from `config/interventions.json` plus the
      pixels it lands on. Per-tree actions bill per placement; per-m2 actions
      bill per pixel.
    * Spending more than `budget_usd`, or placing an action on land cover it is
      not allowed on, makes the whole policy infeasible -- the auditor scores
      nothing and reports the violation.

The policy is scored on population-weighted UTCI relief, gain in access to
relief, equity of that relief, co-benefits, and cost efficiency. Note the trap
recorded in `DATA_MANIFEST.md`: in Boston's own study, albedo moves *surface*
temperature and barely moves *perceived* temperature, while shade moves
perceived temperature a lot. A policy that buys reflective pavement to look busy
will score worse than one that buys shade.
"""

from __future__ import annotations

import numpy as np

from policy_api import Placement, PlanningContext

POLICY_NAME = "hot-corridor trees, then canopies"
DESCRIPTION = (
    "Rank pedestrian space by heat, vulnerability and footfall; plant medium "
    "street trees greedily down that ranking at one tree per 8 m; spend the "
    "last quarter of the budget on shade canopies over the hottest pixels that "
    "are still unshaded."
)

# Priority surface: how much each factor counts when ranking pedestrian pixels.
WEIGHTS = {
    "heat": 0.40,        # modelled 3 PM air temperature
    "uhii": 0.15,        # urban heat island intensity
    "vulnerability": 0.30,
    "population": 0.15,
}

# Fraction of the budget spent on trees before anything else is bought.
SPLIT = {"tree_medium": 0.75, "shade_canopy": 0.25}

# Metres between planted trees. Below the crown diameter, crowns overlap and the
# second tree buys shade that the first already cast.
TREE_SPACING_M = 8.0


def _norm(arr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Rescale to 0-1 across `mask`, flat if the field is constant there."""
    vals = arr[mask]
    if vals.size == 0:
        return np.zeros_like(arr, dtype="float64")
    lo, hi = float(np.min(vals)), float(np.max(vals))
    if hi - lo < 1e-9:
        return np.where(mask, 0.5, 0.0).astype("float64")
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0)


def priority_surface(ctx: PlanningContext) -> np.ndarray:
    """Where relief is worth the most, before any cost is considered."""
    mask = ctx.exposure
    score = (
        WEIGHTS["heat"] * _norm(ctx.heat_ta3pm, mask)
        + WEIGHTS["uhii"] * _norm(ctx.heat_uhii, mask)
        + WEIGHTS["vulnerability"] * ctx.vulnerability
        + WEIGHTS["population"] * _norm(ctx.population, mask)
    )
    return np.where(mask, score, -np.inf)


def _greedy_spaced(score: np.ndarray, candidates: np.ndarray, spacing_px: int, limit: int):
    """Take the best `limit` candidate pixels, keeping them `spacing_px` apart."""
    rows, cols = np.nonzero(candidates)
    if rows.size == 0 or limit <= 0:
        return np.array([], dtype=int), np.array([], dtype=int)
    order = np.argsort(-score[rows, cols])
    rows, cols = rows[order], cols[order]

    taken = np.zeros(score.shape, dtype=bool)
    span = max(int(spacing_px), 1)
    pick_r, pick_c = [], []
    for r, c in zip(rows, cols):
        if taken[r, c]:
            continue
        pick_r.append(int(r))
        pick_c.append(int(c))
        r0, r1 = max(0, r - span), min(score.shape[0], r + span + 1)
        c0, c1 = max(0, c - span), min(score.shape[1], c + span + 1)
        taken[r0:r1, c0:c1] = True
        if len(pick_r) >= limit:
            break
    return np.array(pick_r, dtype=int), np.array(pick_c, dtype=int)


def _top_pixels(score: np.ndarray, candidates: np.ndarray, limit: int):
    """The best `limit` candidate pixels, no spacing rule."""
    rows, cols = np.nonzero(candidates)
    if rows.size == 0 or limit <= 0:
        return np.array([], dtype=int), np.array([], dtype=int)
    order = np.argsort(-score[rows, cols])[:limit]
    return rows[order], cols[order]


def plan(ctx: PlanningContext, budget_usd: float) -> list[Placement]:
    score = priority_surface(ctx)
    placements: list[Placement] = []
    spent = 0.0

    # 1. Trees, spaced, down the priority ranking. `plantable` is already
    #    pedestrian ground with no canopy over it, so this never plants a tree
    #    into an existing crown.
    tree_budget = budget_usd * SPLIT["tree_medium"]
    n_trees = min(
        ctx.affordable("tree_medium", tree_budget),
        int(ctx.plantable.sum()),
    )
    spacing_px = max(int(round(TREE_SPACING_M / ctx.res_m)), 1)
    rows, cols = _greedy_spaced(score, ctx.plantable, spacing_px, n_trees)
    if rows.size:
        placements.append(Placement("tree_medium", rows, cols))
        spent += ctx.cost("tree_medium", rows.size)

    # 2. Canopies over the hottest pedestrian pixels the trees did not reach.
    #    Trees are the better buy per dollar of shade, so this only gets what is
    #    left -- including whatever the tree pass could not spend for want of
    #    plantable ground.
    remaining = budget_usd - spent
    covered = np.zeros(ctx.shape, dtype=bool)
    if rows.size:
        crown_px = max(int(round(2.5 / ctx.res_m)), 1)
        for r, c in zip(rows, cols):
            covered[max(0, r - crown_px):r + crown_px + 1,
                    max(0, c - crown_px):c + crown_px + 1] = True
    open_ground = ctx.exposure & (ctx.cdsm <= 0.0) & ~covered
    n_canopy = min(ctx.affordable("shade_canopy", remaining), int(open_ground.sum()))
    crows, ccols = _top_pixels(score, open_ground, n_canopy)
    if crows.size:
        placements.append(Placement("shade_canopy", crows, ccols))

    return placements
