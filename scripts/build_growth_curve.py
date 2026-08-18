"""Derive how fast a Boston street tree actually grows.

`config/interventions.json` gives a planted tree a 5 m stem and a 2.5 m crown
radius the moment it is placed, and the scorer simulates that. A real tree takes
a decade or two to get there, which is the single largest way the pipeline
flatters shade over albedo. This script produces the curve that lets the scorer
say what a tree is at year N instead.

Two real datasets, joined:

* **Urban Tree Database** (McPherson, van Doorn & Peper 2016, RDS-2016-0005) --
  365 sets of allometric equations fitted to 14 000 measured urban trees. The
  `NoEast` region is Queens, New York, the closest of its 16 climate regions to
  Boston. It gives age -> dbh, dbh -> crown diameter and dbh -> tree height per
  species.
* **Boston's own street tree inventory** (`data/canopy/bprd_trees.csv`) -- what
  is actually planted here. Its species counts weight the regional equations, so
  the curve describes a Boston street tree rather than a generic one.

Species are matched exactly where the database has them and by genus otherwise;
about four fifths of Boston's inventoried street trees match one way or the
other, and the rest are dropped and the weights renormalised. The share that
matched is written into the output so nobody has to take that on trust.

    python scripts/build_growth_curve.py            # -> data/canopy/derived/
    python scripts/build_growth_curve.py --show     # ... and print the curve
"""

from __future__ import annotations

import argparse
import collections
import csv
import io
import json
import math
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANOPY = ROOT / "data" / "canopy"
UTD = CANOPY / "urban_tree_database.zip"
BPRD = CANOPY / "bprd_trees.csv"
OUT = CANOPY / "derived" / "boston_growth_curve.json"

# Queens, NY -- the Urban Tree Database climate region covering the northeast.
REGION = "NoEast"
MAX_AGE = 60

# Rows in the Boston inventory that name a site rather than a tree.
NOT_A_SPECIES = ("empty pit", "planting site", "stump", "vacant", "unknown", "other")


# --------------------------------------------------------------------------- #
# The Urban Tree Database equation forms (TS4)
# --------------------------------------------------------------------------- #
def _evaluate(eq: str, x: float, a: float, b: float, c: float, d: float) -> float:
    """One UTD growth equation at `x`.

    `c` carries the mean squared error for the log-log and exponential forms and
    the quadratic term for the polynomial ones -- the database packs both into
    the same column, which is why the form name has to be consulted first.

    TS4 prints `loglogw1` with the `mse/2` term inside the inner logarithm; the
    other three log-log forms put it outside, and outside is what reproduces the
    published curves. Implemented as `exp(a + b*ln(ln(x+1)) + mse/2)`.
    """
    if x <= 0:
        x = 1e-6
    if eq == "lin":
        return a + b * x
    if eq == "quad":
        return a + b * x + c * x * x
    if eq == "cub":
        return a + b * x + c * x**2 + d * x**3
    if eq.startswith("loglog"):
        inner = math.log(math.log(x + 1.0))
        extra = {"loglogw1": c / 2.0,
                 "loglogw2": math.sqrt(x) * c / 2.0,
                 "loglogw3": x * c / 2.0,
                 "loglogw4": x * x * c / 2.0}[eq]
        return math.exp(a + b * inner + extra)
    if eq.startswith("expow"):
        extra = {"expow1": c / 2.0,
                 "expow2": math.sqrt(x) * c / 2.0,
                 "expow3": x * c / 2.0,
                 "expow4": x * x * c / 2.0}[eq]
        return math.exp(a + b * x + extra)
    raise ValueError(f"unknown equation form {eq!r}")


def _num(value: str) -> float:
    value = (value or "").strip()
    return float(value) if value else 0.0


def load_equations() -> dict:
    """{species: {relation: (eqname, a, b, c, d)}} for the northeast region.

    Relations kept: `age -> dbh` (cm), `dbh -> crown dia` (m), `dbh -> tree ht`
    (m). The database also predicts dbh *from* crown diameter, which is the same
    two columns in the other direction -- hence the filter on the independent
    variable rather than on the predicted component alone.
    """
    wanted = {
        ("age", "dbh"): "age_to_dbh",
        ("dbh", "crown dia"): "dbh_to_crown_dia",
        ("dbh", "tree ht"): "dbh_to_height",
    }
    out: dict[str, dict] = collections.defaultdict(dict)
    with zipfile.ZipFile(UTD) as z, z.open("Data/TS6_Growth_coefficients.csv") as fh:
        for row in csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")):
            if row["Region"] != REGION:
                continue
            key = (row["Independent variable"].strip(), row["Predicts component "].strip())
            name = wanted.get(key)
            if name is None:
                continue
            out[row["Scientific Name"].strip()][name] = (
                row["EqName"].strip(),
                _num(row["a"]), _num(row["b"]), _num(row["c"]), _num(row["d"]),
            )
    return {sp: rel for sp, rel in out.items() if len(rel) == 3}


# --------------------------------------------------------------------------- #
# Boston's species mix
# --------------------------------------------------------------------------- #
def boston_species() -> collections.Counter:
    counts: collections.Counter = collections.Counter()
    with open(BPRD, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("spp_bot") or "").strip()
            if not name or any(bad in name.lower() for bad in NOT_A_SPECIES):
                continue
            counts[name] += 1
    return counts


def match_species(counts: collections.Counter, equations: dict) -> tuple[dict, dict]:
    """Weight the regional equations by what Boston actually plants.

    An exact scientific name wins. Otherwise the genus is matched and the count
    is split evenly across that genus's species in the database -- Boston plants
    several elms and cultivars the database does not carry individually, and
    dropping them would bias the mix toward the handful it names exactly.
    """
    by_genus: dict[str, list[str]] = collections.defaultdict(list)
    for sp in equations:
        by_genus[sp.split()[0]].append(sp)

    weights: collections.Counter = collections.Counter()
    stats = {"exact": 0, "genus": 0, "unmatched": 0, "total": int(sum(counts.values()))}
    for name, n in counts.items():
        if name in equations:
            weights[name] += n
            stats["exact"] += n
        elif (peers := by_genus.get(name.split()[0])):
            for sp in peers:
                weights[sp] += n / len(peers)
            stats["genus"] += n
        else:
            stats["unmatched"] += n
    total = sum(weights.values())
    return {sp: w / total for sp, w in weights.items()}, stats


# --------------------------------------------------------------------------- #
# The curve
# --------------------------------------------------------------------------- #
def build_curve(weights: dict, equations: dict) -> dict:
    """Weighted mean dbh, crown radius and height at every age to `MAX_AGE`."""
    ages = list(range(0, MAX_AGE + 1))
    dbh, radius, height = [], [], []
    for age in ages:
        d_sum = r_sum = h_sum = 0.0
        for sp, w in weights.items():
            eq = equations[sp]

            def at(relation: str, x: float) -> float:
                name, a, b, c, d = eq[relation]
                return max(_evaluate(name, x, a, b, c, d), 0.0)

            d = at("age_to_dbh", age)
            cd = at("dbh_to_crown_dia", d)
            ht = at("dbh_to_height", d)
            d_sum += w * d
            r_sum += w * cd / 2.0
            h_sum += w * ht
        dbh.append(round(d_sum, 2))
        radius.append(round(r_sum, 3))
        height.append(round(h_sum, 3))
    # Crown radius and height must not shrink: the polynomial fits turn over
    # past the age range they were fitted on, and a tree that un-grows would
    # make a later horizon score better than an earlier one.
    for series in (dbh, radius, height):
        for i in range(1, len(series)):
            series[i] = max(series[i], series[i - 1])
    return {"ages_years": ages, "dbh_cm": dbh, "crown_radius_m": radius, "height_m": height}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--show", action="store_true", help="print the curve as a table")
    args = ap.parse_args()

    for path in (UTD, BPRD):
        if not path.exists():
            raise SystemExit(f"missing {path} -- run scripts/fetch_boston_open_data.sh")

    equations = load_equations()
    counts = boston_species()
    weights, stats = match_species(counts, equations)
    curve = build_curve(weights, equations)

    top = sorted(weights.items(), key=lambda kv: -kv[1])[:12]
    payload = {
        "description": (
            "Age-to-size curve for a Boston street tree: Urban Tree Database "
            "allometric equations for the NoEast region, weighted by the species "
            "mix in Boston's own street tree inventory."
        ),
        "sources": {
            "equations": "McPherson, van Doorn & Peper (2016), Urban Tree Database and "
                         "Allometric Equations, USDA Forest Service RDS-2016-0005 / "
                         "PSW-GTR-253. Region NoEast (reference city Queens, NY).",
            "species_mix": "City of Boston BPRD street and park tree inventory, "
                           "data/canopy/bprd_trees.csv.",
        },
        "region": REGION,
        "match": {
            "trees_in_inventory": stats["total"],
            "matched_exact_species": stats["exact"],
            "matched_by_genus": stats["genus"],
            "unmatched_dropped": stats["unmatched"],
            "share_matched": round((stats["exact"] + stats["genus"]) / stats["total"], 4),
            "species_in_curve": len(weights),
            "top_weights": {sp: round(w, 4) for sp, w in top},
        },
        "curve": curve,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"{stats['total']} inventoried trees; "
          f"{payload['match']['share_matched']:.1%} matched "
          f"({stats['exact']} exact, {stats['genus']} by genus) "
          f"across {len(weights)} species")
    print(f"-> {OUT}")
    if args.show:
        print(f"\n{'age':>4} {'dbh cm':>8} {'crown r m':>10} {'height m':>9}")
        for i, age in enumerate(curve["ages_years"]):
            if age % 5 == 0:
                print(f"{age:>4} {curve['dbh_cm'][i]:>8.1f} "
                      f"{curve['crown_radius_m'][i]:>10.2f} {curve['height_m'][i]:>9.2f}")


if __name__ == "__main__":
    main()
