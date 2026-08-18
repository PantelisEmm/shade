"""Evolve heat-resilience policies with an LLM-in-the-loop.

Minimal autoresearch harness: prompt an LLM to write a policy, score it
against SOLWEIG, store the result, and repeat.  Inspired by AlphaEvolve's
evolutionary code search, but synchronous and single-machine.

    # score the seed, then run 2 LLM generations on chinatown
    python scripts/evolve.py --generations 2 --aoi chinatown

    # different budget and model
    python scripts/evolve.py --generations 5 --budget 1000000 --model gemini-2.0-flash

The seed policy (default: policies/baseline_policy.py) is scored first as
generation 0.  Each subsequent generation picks the best-scoring candidate
as parent, samples up to two other feasible candidates as "inspirations",
and asks the LLM to write a new policy that improves on the parent.

Every candidate -- feasible, infeasible, or crashed -- is stored as a JSON
file in the run directory so the evolutionary history is fully reproducible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config"
RUNS = ROOT / "runs"


# ── LLM interface ──────────────────────────────────────────────────────── #

_genai_configured = False


def generate(prompt: str, system: str, *, model: str = "gemini-3.6-flash") -> str:
    """Call the LLM and return the response text.

    Lazy-imports google.generativeai so the rest of the file can be used
    without the SDK installed.  To swap to Anthropic later, change only
    this function body.
    """
    global _genai_configured
    import google.generativeai as genai  # noqa: E402

    if not _genai_configured:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise SystemExit(
                "set GEMINI_API_KEY in your environment "
                "(see https://console.cloud.google.com/apis/credentials)"
            )
        genai.configure(api_key=key)
        _genai_configured = True

    llm = genai.GenerativeModel(model, system_instruction=system)

    last_err = None
    for attempt in range(4):
        try:
            response = llm.generate_content(prompt)
            return response.text
        except Exception as exc:
            last_err = exc
            err_name = type(exc).__name__
            if "ResourceExhausted" in err_name or "ServiceUnavailable" in err_name:
                wait = 2 ** (attempt + 1)
                print(f"  LLM rate-limited ({err_name}), retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise
    raise last_err  # type: ignore[misc]


# ── code extraction ────────────────────────────────────────────────────── #

def extract_policy_code(response: str) -> str | None:
    """Pull the Python policy module out of a fenced code block."""
    # Try ```python ... ```  (take last match -- the final version)
    matches = re.findall(r"```python\s*\n(.*?)```", response, re.DOTALL)
    if matches:
        code = matches[-1].strip()
    else:
        # Try unfenced ``` ... ```
        matches = re.findall(r"```\s*\n(.*?)```", response, re.DOTALL)
        if matches:
            code = matches[-1].strip()
        elif "def plan(" in response:
            code = response.strip()
        else:
            return None

    if "def plan(" not in code:
        return None

    # Ensure POLICY_NAME and DESCRIPTION exist
    if "POLICY_NAME" not in code:
        code = ('POLICY_NAME = "evolved"\n'
                'DESCRIPTION = "LLM-generated policy"\n\n' + code)

    return code


# ── prompt construction ────────────────────────────────────────────────── #

def build_system_prompt() -> str:
    """The constant system prompt, built from config/interventions.json."""
    interventions = json.loads(
        (CONFIG / "interventions.json").read_text(encoding="utf-8")
    )["interventions"]

    rows = []
    for name, spec in interventions.items():
        cost = spec["cost_usd_per_unit"]
        unit = spec["unit"]
        lc = spec.get("applies_to_landcover", "ground")
        label = spec["label"]
        rows.append(f"  {name:<18s} ${cost:>7.0f}/{unit:<4s}  lc={lc!s:<12s}  {label}")
    actions_table = "\n".join(rows)

    return f"""\
You are an autoresearch agent improving urban heat-resilience policies for Boston.

## The policy contract

A policy is a Python module with:

    POLICY_NAME = "short name"
    DESCRIPTION = "what the policy does and why"

    def plan(ctx: PlanningContext, budget_usd: float) -> list[Placement]

It must start with these imports:
    from __future__ import annotations
    import numpy as np
    from policy_api import Placement, PlanningContext

No other external libraries may be imported. The module is loaded with
importlib so it must be self-contained.

## What ctx provides

Grids (all numpy arrays on the same shape):
  ctx.shape             tuple (rows, cols) of the AOI grid
  ctx.res_m             pixel size in metres (2.0)
  ctx.landcover         uint8, UMEP codes: 1=paved 2=building 3=evergreen 4=deciduous 5=grass 6=bare 7=water
  ctx.dsm               ground + buildings, metres above sea level
  ctx.dem               bare earth, metres above sea level
  ctx.cdsm              canopy height above ground in metres (0 where no canopy)
  ctx.building_height   building height above terrain in metres, 0 off buildings
  ctx.heat_ta3pm        modelled 3 PM air temperature, degC -- hotter = more need
  ctx.heat_ta3am        modelled 3 AM air temperature, degC
  ctx.heat_uhii         urban heat island intensity, degC
  ctx.heat_hours        annual heat-event hours
  ctx.population        people per pixel on pedestrian space
  ctx.vulnerability     0-1 citywide percentile of tract social vulnerability
  ctx.priority          bool: tract is in the top vulnerability quartile

Masks (all bool):
  ctx.exposure          where scores are measured (sidewalk + crosswalk corridor)
  ctx.walkable          ground a person can stand on
  ctx.plantable         every siting rule for a tree satisfied (roadbed, hydrants, width, canopy, etc.)
  ctx.buildable         every siting rule for a canopy/awning satisfied
  ctx.roadbed           paved travel lane -- NOTHING may go here

Methods:
  ctx.placeable(action) -> bool mask: eligible land cover AND siting rules pass
  ctx.affordable(action, budget) -> int: how many pixels (or trees) fit in the budget
  ctx.cost(action, n) -> float: USD for n pixels of that action
  ctx.unit_cost(action) -> float: USD per pixel or per tree
  ctx.eligible(action) -> bool mask: land cover allows this action
  ctx.spec(action) -> dict: the intervention spec from config

## Available actions

{actions_table}

Notes:
- tree_small and tree_medium bill per TREE, not per pixel. One Placement with
  N row/col pairs = N trees.
- All other actions bill per PIXEL (unit = m2, cost = cost_per_m2 * pixel_area_m2).
- tree actions go on ctx.plantable; canopy actions go on ctx.buildable;
  roof actions go on building pixels; road/grass on paved pixels.

## Scoring -- THIS IS CRITICAL

heat_relief_c: population-weighted UTCI drop on pedestrian space. THIS IS THE FITNESS.
  Higher is better. This is what you are trying to maximise.

THE ALBEDO TRAP: shade moves perceived temperature (UTCI) strongly.
  Reflective pavement (light_road) moves SURFACE temperature but barely
  moves UTCI -- it even raises Tmrt by reflecting more shortwave onto
  pedestrians. A policy that buys albedo to look busy will score WORSE
  than one that buys shade. Trees and canopies dominate for UTCI relief.

Other reported scores (not the fitness, but important):
  equity_ratio: relief in top-vulnerability areas / overall. >1 = helping the vulnerable more.
  access_gain_pp: share of exposed residents moved below the 32C UTCI heat-stress threshold.
  cost_efficiency_person_c_per_100k: person-degC of relief per $100k spent.
  cobenefit_greened_pct: new canopy or green area as % of walkable ground.

## Rules that make a policy infeasible (ALL must hold)

- Total spend must not exceed budget_usd.
- Every pixel must pass ctx.placeable(action). Use ctx.plantable for trees,
  ctx.buildable for canopies. Placing on roadbed, near hydrants, on wrong
  land cover, or under existing canopy is a violation.
- No pixel may appear in two Placements.
- plan() must return within 120 seconds wall-clock.

A single violation makes the ENTIRE policy infeasible: zero score, no
simulation. The auditor reports the violation strings.

## Common mistakes to avoid

- Placing trees on ANY paved pixel instead of ctx.plantable (roadbed is paved too).
- Using ctx.eligible() alone without ctx.sitable() -- eligible checks land cover,
  sitable checks physical rules. Use ctx.placeable() or ctx.plantable/ctx.buildable.
- Indexing rows/cols outside ctx.shape.
- Returning duplicate pixels across Placements (double-booking).
- Overspending the budget by even $1 (use ctx.affordable() to compute limits).
- Forgetting the imports (from policy_api import Placement, PlanningContext).

## Output format

Write the COMPLETE Python module. Start with imports, then POLICY_NAME,
DESCRIPTION, helper functions if needed, then def plan(). The module must
be fully self-contained and runnable.
"""


def build_user_prompt(parent: dict, inspirations: list[dict]) -> str:
    """Build the per-generation prompt from parent + inspirations."""
    parts = []

    # Parent
    parts.append("## Parent policy (the current best -- improve on this)\n")
    parts.append(f"Name: {parent.get('policy_name', 'unknown')}")
    parts.append(f"Description: {parent.get('description', 'none')}")
    if parent.get("fitness") is not None:
        parts.append(f"Fitness (heat_relief_c): {parent['fitness']}")
    if parent.get("objectives"):
        obj = parent["objectives"]
        score_lines = []
        for k in ("heat_relief_c", "access_gain_pp", "equity_ratio",
                   "cobenefit_greened_pct", "cost_efficiency_person_c_per_100k"):
            if obj.get(k) is not None:
                score_lines.append(f"  {k}: {obj[k]}")
        if score_lines:
            parts.append("Scores:\n" + "\n".join(score_lines))
    if parent.get("violations"):
        parts.append(f"Violations: {json.dumps(parent['violations'], indent=2)}")
    parts.append(f"\n```python\n{parent['code']}\n```\n")

    # Inspirations
    for i, insp in enumerate(inspirations, 1):
        parts.append(f"## Inspiration {i} (another approach from the database)\n")
        parts.append(f"Name: {insp.get('policy_name', 'unknown')}")
        if insp.get("fitness") is not None:
            parts.append(f"Fitness (heat_relief_c): {insp['fitness']}")
        if insp.get("objectives"):
            obj = insp["objectives"]
            for k in ("heat_relief_c", "equity_ratio", "cost_efficiency_person_c_per_100k"):
                if obj.get(k) is not None:
                    parts.append(f"  {k}: {obj[k]}")
        parts.append(f"\n```python\n{insp['code']}\n```\n")

    # Task
    fitness_str = ""
    if parent.get("fitness") is not None:
        fitness_str = f" of {parent['fitness']}"
    parts.append(f"""## Your task

Write a new policy that improves on the parent's heat_relief_c{fitness_str}.

Think about:
- Different budget splits between actions (trees vs canopies vs other)
- Different priority surfaces or ranking strategies
- Better spatial strategies (spacing, clustering, corridor coverage)
- Targeting different populations, heat patterns, or vulnerability
- Creative use of all 8 available actions

Write the COMPLETE Python module. It must be standalone and runnable.""")

    return "\n".join(parts)


# ── candidate database ─────────────────────────────────────────────────── #

def _candidate_id(generation: int, code: str | None) -> str:
    if generation == 0:
        return "gen00_seed"
    tag = hashlib.sha256((code or "").encode()).hexdigest()[:8]
    return f"gen{generation:02d}_{tag}"


def save_candidate(run_dir: Path, candidate: dict) -> Path:
    cand_dir = run_dir / "candidates"
    cand_dir.mkdir(parents=True, exist_ok=True)
    path = cand_dir / f"{candidate['id']}.json"
    path.write_text(json.dumps(candidate, indent=2), encoding="utf-8")
    return path


def load_candidates(run_dir: Path) -> list[dict]:
    cand_dir = run_dir / "candidates"
    if not cand_dir.exists():
        return []
    candidates = []
    for path in sorted(cand_dir.glob("*.json")):
        candidates.append(json.loads(path.read_text(encoding="utf-8")))
    return candidates


def best_candidate(candidates: list[dict]) -> dict | None:
    feasible = [c for c in candidates if c.get("fitness") is not None]
    if not feasible:
        return None
    return max(feasible, key=lambda c: c["fitness"])


def sample_inspirations(candidates: list[dict], exclude_id: str, n: int = 2) -> list[dict]:
    pool = [c for c in candidates
            if c.get("fitness") is not None and c["id"] != exclude_id]
    if not pool:
        return []
    return random.sample(pool, min(n, len(pool)))


# ── scoring ────────────────────────────────────────────────────────────── #

def score_candidate(
    policy_path: Path,
    aoi: str,
    budget: float,
    out_dir: Path,
    scenarios: str = "baseline",
    plan_timeout: float = 120.0,
    score_timeout: float = 600.0,
) -> dict | None:
    """Run score_policy.py as a subprocess, return parsed score.json or None."""
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "score_policy.py"),
        "--policy", str(policy_path.resolve()),
        "--aoi", aoi,
        "--budget", str(budget),
        "--out", str(out_dir),
        "--scenarios", scenarios,
        "--plan-timeout", str(plan_timeout),
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=score_timeout,
            cwd=str(ROOT),
        )
    except subprocess.TimeoutExpired:
        print(f"  scoring timed out after {score_timeout}s")
        return None

    if result.returncode != 0:
        print(f"  scorer exited with code {result.returncode}")
        if result.stderr:
            # Print last 5 lines of stderr for diagnostics
            for line in result.stderr.strip().splitlines()[-5:]:
                print(f"    {line}")

    score_path = out_dir / "score.json"
    if not score_path.exists():
        print(f"  no score.json produced")
        return None

    return json.loads(score_path.read_text(encoding="utf-8"))


# ── main loop ──────────────────────────────────────────────────────────── #

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Evolve heat-resilience policies with an LLM-in-the-loop.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--generations", type=int, default=10,
                     help="number of LLM evolution iterations (default 10)")
    ap.add_argument("--budget", type=float, default=500_000.0,
                     help="USD per AOI (default 500000)")
    ap.add_argument("--aoi", default="chinatown",
                     help="AOI name (default chinatown)")
    ap.add_argument("--model", default="gemini-3.6-flash",
                     help="LLM model identifier (default gemini-3.6-flash)")
    ap.add_argument("--seed-policy", default="policies/baseline_policy.py",
                     help="path to the seed policy (default policies/baseline_policy.py)")
    ap.add_argument("--scenarios", default="baseline",
                     help="weather scenarios, comma-separated (default baseline)")
    ap.add_argument("--plan-timeout", type=float, default=120.0,
                     help="seconds for plan() to run (default 120)")
    ap.add_argument("--score-timeout", type=float, default=600.0,
                     help="wall-clock timeout for the scoring subprocess (default 600)")
    ap.add_argument("--out", help="output directory (default runs/evolve_<timestamp>)")
    args = ap.parse_args()

    # -- setup ------------------------------------------------------------ #
    seed_path = Path(args.seed_policy)
    if not seed_path.is_absolute():
        seed_path = ROOT / seed_path
    if not seed_path.exists():
        raise SystemExit(f"seed policy not found: {seed_path}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out) if args.out else RUNS / f"evolve_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "candidates").mkdir(exist_ok=True)
    (run_dir / "policies").mkdir(exist_ok=True)

    seed_code = seed_path.read_text(encoding="utf-8")

    print(f"SHADE evolution harness")
    print(f"  run dir:      {run_dir}")
    print(f"  aoi:          {args.aoi}")
    print(f"  budget:       ${args.budget:,.0f}")
    print(f"  generations:  {args.generations}")
    print(f"  model:        {args.model}")
    print(f"  seed:         {seed_path.name}")
    print()

    # -- generation 0: score the seed ------------------------------------- #
    print("gen 0  scoring seed policy...")
    score_dir = run_dir / "score_gen00_seed"
    result = score_candidate(
        seed_path, args.aoi, args.budget, score_dir,
        scenarios=args.scenarios,
        plan_timeout=args.plan_timeout,
        score_timeout=args.score_timeout,
    )

    if result is None:
        raise SystemExit("seed policy failed to score -- fix it before evolving")

    seed_objectives = result.get("objectives")
    seed_fitness = seed_objectives.get("heat_relief_c") if seed_objectives else None

    # Extract POLICY_NAME and DESCRIPTION from seed code
    seed_name = "baseline"
    seed_desc = ""
    name_match = re.search(r'POLICY_NAME\s*=\s*["\'](.+?)["\']', seed_code)
    if name_match:
        seed_name = name_match.group(1)
    desc_match = re.search(r'DESCRIPTION\s*=\s*\(\s*["\'](.+?)["\']', seed_code, re.DOTALL)
    if desc_match:
        seed_desc = desc_match.group(1)
    else:
        desc_match = re.search(r'DESCRIPTION\s*=\s*["\'](.+?)["\']', seed_code)
        if desc_match:
            seed_desc = desc_match.group(1)

    seed_candidate = {
        "id": "gen00_seed",
        "generation": 0,
        "parent_id": None,
        "inspiration_ids": [],
        "policy_name": seed_name,
        "description": seed_desc,
        "code": seed_code,
        "verdict": result.get("verdict", "unknown"),
        "objectives": seed_objectives,
        "violations": result.get("violations"),
        "fitness": seed_fitness,
        "timestamp_utc": stamp,
        "model": "seed",
    }
    save_candidate(run_dir, seed_candidate)

    verdict = result.get("verdict", "unknown")
    print(f"gen 0  {verdict}  fitness={seed_fitness}")
    if seed_fitness is None:
        print("  WARNING: seed is infeasible, evolution will proceed but has no parent to improve on")
    print()

    # -- build system prompt ---------------------------------------------- #
    system_prompt = build_system_prompt()

    # -- evolution loop --------------------------------------------------- #
    for gen in range(1, args.generations + 1):
        print(f"gen {gen}  ", end="", flush=True)
        candidates = load_candidates(run_dir)

        # Select parent (best feasible so far)
        parent = best_candidate(candidates)
        if parent is None:
            # No feasible candidate yet -- use seed anyway
            parent = candidates[0]
            print("(no feasible parent, using seed)  ", end="", flush=True)

        # Select inspirations
        inspirations = sample_inspirations(candidates, parent["id"], n=2)

        # Build prompt and call LLM
        user_prompt = build_user_prompt(parent, inspirations)
        print("calling LLM...", end="", flush=True)

        cand_id = None
        try:
            t0 = time.time()
            response = generate(user_prompt, system_prompt, model=args.model)
            llm_seconds = time.time() - t0
            print(f"  ({llm_seconds:.1f}s)  ", end="", flush=True)
        except Exception as exc:
            print(f"  LLM error: {exc}")
            cand_id = _candidate_id(gen, None)
            save_candidate(run_dir, {
                "id": cand_id,
                "generation": gen,
                "parent_id": parent["id"],
                "inspiration_ids": [i["id"] for i in inspirations],
                "policy_name": "llm_error",
                "description": str(exc),
                "code": None,
                "verdict": "llm_error",
                "objectives": None,
                "violations": None,
                "fitness": None,
                "timestamp_utc": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                "model": args.model,
            })
            print()
            continue

        # Extract code
        code = extract_policy_code(response)
        if code is None:
            print("  code extraction failed")
            cand_id = _candidate_id(gen, response)
            save_candidate(run_dir, {
                "id": cand_id,
                "generation": gen,
                "parent_id": parent["id"],
                "inspiration_ids": [i["id"] for i in inspirations],
                "policy_name": "extraction_failed",
                "description": "could not extract a plan() function from LLM response",
                "code": response[:5000],  # store truncated response for debugging
                "verdict": "extraction_failed",
                "objectives": None,
                "violations": None,
                "fitness": None,
                "timestamp_utc": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                "model": args.model,
            })
            print()
            continue

        cand_id = _candidate_id(gen, code)

        # Write policy file
        policy_path = run_dir / "policies" / f"{cand_id}.py"
        policy_path.write_text(code, encoding="utf-8")

        # Score
        print("scoring...", end="", flush=True)
        score_dir = run_dir / f"score_{cand_id}"
        t0 = time.time()
        result = score_candidate(
            policy_path, args.aoi, args.budget, score_dir,
            scenarios=args.scenarios,
            plan_timeout=args.plan_timeout,
            score_timeout=args.score_timeout,
        )
        score_seconds = time.time() - t0

        if result is None:
            print(f"  score error ({score_seconds:.0f}s)")
            save_candidate(run_dir, {
                "id": cand_id,
                "generation": gen,
                "parent_id": parent["id"],
                "inspiration_ids": [i["id"] for i in inspirations],
                "policy_name": "score_error",
                "description": "score_policy.py produced no score.json",
                "code": code,
                "verdict": "score_error",
                "objectives": None,
                "violations": None,
                "fitness": None,
                "timestamp_utc": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                "model": args.model,
            })
            print()
            continue

        # Parse results
        verdict = result.get("verdict", "unknown")
        objectives = result.get("objectives")
        fitness = objectives.get("heat_relief_c") if objectives else None

        # Extract name/description from generated code
        policy_name = "evolved"
        desc = ""
        m = re.search(r'POLICY_NAME\s*=\s*["\'](.+?)["\']', code)
        if m:
            policy_name = m.group(1)
        m = re.search(r'DESCRIPTION\s*=\s*["\'](.+?)["\']', code)
        if m:
            desc = m.group(1)
        elif re.search(r'DESCRIPTION\s*=\s*\(', code):
            m = re.search(r'DESCRIPTION\s*=\s*\(\s*["\'](.+?)["\']', code, re.DOTALL)
            if m:
                desc = m.group(1)

        candidate = {
            "id": cand_id,
            "generation": gen,
            "parent_id": parent["id"],
            "inspiration_ids": [i["id"] for i in inspirations],
            "policy_name": policy_name,
            "description": desc,
            "code": code,
            "verdict": verdict,
            "objectives": objectives,
            "violations": result.get("violations"),
            "fitness": fitness,
            "timestamp_utc": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            "model": args.model,
            "score_json_path": str(score_dir / "score.json"),
        }
        save_candidate(run_dir, candidate)

        # Report
        delta = ""
        if fitness is not None and parent.get("fitness") is not None:
            diff = fitness - parent["fitness"]
            delta = f"  ({'+' if diff >= 0 else ''}{diff:.4f})"
        print(f"  {verdict}  fitness={fitness}{delta}  ({score_seconds:.0f}s)")

    # -- summary ---------------------------------------------------------- #
    print()
    candidates = load_candidates(run_dir)
    best = best_candidate(candidates)

    summary = {
        "run_dir": str(run_dir),
        "aoi": args.aoi,
        "budget_usd": args.budget,
        "model": args.model,
        "generations": args.generations,
        "total_candidates": len(candidates),
        "feasible_count": sum(1 for c in candidates if c.get("fitness") is not None),
        "best_id": best["id"] if best else None,
        "best_fitness": best["fitness"] if best else None,
        "best_policy_name": best["policy_name"] if best else None,
        "all_fitness": [
            {"id": c["id"], "gen": c["generation"], "fitness": c.get("fitness"),
             "verdict": c["verdict"], "policy_name": c.get("policy_name")}
            for c in candidates
        ],
    }
    (run_dir / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    if best:
        print(f"best policy: {best['policy_name']} (gen {best['generation']})")
        print(f"  fitness (heat_relief_c): {best['fitness']}")
        if best.get("objectives"):
            for k in ("access_gain_pp", "equity_ratio",
                       "cobenefit_greened_pct", "cost_efficiency_person_c_per_100k"):
                v = best["objectives"].get(k)
                if v is not None:
                    print(f"  {k}: {v}")
        # Copy best policy to a convenient location
        best_path = run_dir / "best_policy.py"
        best_path.write_text(best["code"], encoding="utf-8")
        print(f"\n-> {best_path}")
    else:
        print("no feasible policy found")

    print(f"-> {run_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
