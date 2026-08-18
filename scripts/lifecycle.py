"""What an intervention is, some years after it was built.

`config/interventions.json` describes a finished asset. This module answers the
question that makes shade comparable with albedo honestly: *when*. A planted
tree is not a 2.5 m crown on day one, a shade sail is gone by year 15, and about
four street trees in ten are dead by year 20.

Three things it provides, all driven by `config/lifecycle.json`:

* `size_at(action, years)` -- crown radius and height from the Boston-weighted
  growth curve, so the scorer can paint the tree that is actually standing at
  the horizon instead of the one the config describes.
* `alive_at(action, years)` -- whether the asset has outlived its service life.
  A dead asset is absent from the geometry and still counted as spent, because
  the money went out of the door either way.
* `survival(action, years)` -- the share of planted trees expected to still be
  there, from the Roman & Scatena meta-analytic mortality rate.

Growth changes the geometry, so it is applied to the raster stack and simulated.
Survival does not: half a tree cannot be planted. It is reported as an explicit
multiplier next to the simulated relief rather than folded into it silently.

    python scripts/lifecycle.py --years 0,5,10,15,20,30
"""

from __future__ import annotations

import argparse
import copy
import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config"
CURVE = ROOT / "data" / "canopy" / "derived" / "boston_growth_curve.json"


@dataclass
class Lifecycle:
    """The lifecycle rules plus the growth curve they are read against."""

    rules: dict
    curve: dict | None

    # -- growth ------------------------------------------------------------- #
    def _interp(self, series: str, years: float) -> float | None:
        if self.curve is None:
            return None
        ages = self.curve["ages_years"]
        values = self.curve[series]
        if years <= ages[0]:
            return float(values[0])
        if years >= ages[-1]:
            return float(values[-1])
        i = int(years)
        frac = years - i
        return float(values[i] + frac * (values[i + 1] - values[i]))

    def spec(self, action: str) -> dict:
        return self.rules.get("actions", {}).get(action, {})

    def size_at(self, action: str, years: float) -> tuple[float, float] | None:
        """(crown radius m, height m) for a tree `years` after planting.

        None for anything that is not a tree, or when the growth curve has not
        been built -- in both cases the caller keeps the configured geometry.
        """
        spec = self.spec(action)
        if spec.get("kind") != "tree" or self.curve is None:
            return None
        radius = self._interp("crown_radius_m", years) * float(spec.get("crown_radius_scale", 1.0))
        height = self._interp("height_m", years)
        cap = spec.get("max_height_m")
        if cap:
            height = min(height, float(cap))
        return round(radius, 3), round(height, 3)

    # -- attrition ---------------------------------------------------------- #
    def alive_at(self, action: str, years: float) -> bool:
        life = self.spec(action).get("asset_life_years")
        return True if life is None else years <= float(life)

    def survival(self, action: str, years: float) -> float:
        """Share of the placements expected to still be standing.

        Only trees die on their own; a surface or a structure is either inside
        its service life or past it, which `alive_at` already answers.
        """
        if not self.alive_at(action, years):
            return 0.0
        if self.spec(action).get("kind") != "tree":
            return 1.0
        rate = float(self.rules.get("appraisal", {}).get("annual_mortality_rate", 0.0))
        return round((1.0 - rate) ** max(years, 0.0), 4)

    def establishing(self, action: str, years: float) -> bool:
        est = self.spec(action).get("establishment_years")
        return bool(est) and years < float(est)

    # -- what the scorer needs --------------------------------------------- #
    def horizon_menu(self, interventions: dict, years: float) -> tuple[dict, dict]:
        """(intervention menu as it stands at `years`, per-action notes).

        The menu is a copy with tree crowns resized to the horizon; actions past
        their service life are marked dead and the caller drops their
        placements. Prices are untouched -- the money was spent at year zero.
        """
        menu = copy.deepcopy(interventions)
        notes: dict[str, dict] = {}
        for action, spec in menu.items():
            note = {
                "kind": self.spec(action).get("kind", "unspecified"),
                "alive": self.alive_at(action, years),
                "survival": self.survival(action, years),
                "asset_life_years": self.spec(action).get("asset_life_years"),
            }
            if self.establishing(action, years):
                note["establishing"] = True
            size = self.size_at(action, years)
            if size is not None:
                edit = spec.setdefault("raster_edit", {})
                note["configured"] = {
                    "crown_radius_m": edit.get("crown_radius_m"),
                    "cdsm_height_m": edit.get("cdsm_height_m"),
                }
                edit["crown_radius_m"], edit["cdsm_height_m"] = size
                note["at_horizon"] = {"crown_radius_m": size[0], "cdsm_height_m": size[1]}
            notes[action] = note
        return menu, notes

    def plan_survival(self, shade_area_by_action: dict, years: float) -> float | None:
        """Survival of the plan's shade, weighted by the area each action casts.

        A plan that is all trees carries the tree survival curve; one that is
        half awnings carries half of it. Weighting by shade area rather than by
        spend keeps a cheap action from dominating a physical average.
        """
        total = sum(shade_area_by_action.values())
        if total <= 0:
            return None
        weighted = sum(
            area * self.survival(action, years)
            for action, area in shade_area_by_action.items()
        )
        return round(weighted / total, 4)


def load() -> Lifecycle:
    rules = json.loads((CONFIG / "lifecycle.json").read_text(encoding="utf-8"))
    curve = None
    if CURVE.exists():
        curve = json.loads(CURVE.read_text(encoding="utf-8"))["curve"]
    return Lifecycle(rules, curve)


def default_horizon() -> float | None:
    value = load().rules.get("appraisal", {}).get("default_horizon_years")
    return None if value is None else float(value)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--years", default="0,2,5,10,15,20,30,40")
    args = ap.parse_args()
    lc = load()
    if lc.curve is None:
        raise SystemExit(
            "no growth curve at data/canopy/derived/boston_growth_curve.json -- "
            "run python scripts/build_growth_curve.py"
        )
    years = [float(y) for y in args.years.split(",")]
    actions = sorted(lc.rules.get("actions", {}))
    print(f"{'action':<18}" + "".join(f"{y:>16.0f}" for y in years))
    for action in actions:
        cells = []
        for y in years:
            if not lc.alive_at(action, y):
                cells.append("gone")
            else:
                size = lc.size_at(action, y)
                surv = lc.survival(action, y)
                cells.append(f"r{size[0]:.1f} h{size[1]:.1f} {surv:.0%}" if size
                             else f"{surv:.0%}")
        print(f"{action:<18}" + "".join(f"{c:>16}" for c in cells))
    print("\nr = crown radius m, h = height m, % = expected survival")


if __name__ == "__main__":
    main()
