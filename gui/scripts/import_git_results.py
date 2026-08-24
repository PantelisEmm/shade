"""Convert the tracked ``results/`` export into a GUI Autoresearch archive.

The published results branch intentionally omits bulky scorer outputs under
``runs/``.  Candidate JSON still contains the exact policy source, so this tool
replays each stored policy against the local AOI planning context and exports
the compact packed-mask layouts used by the browser.  It does not evolve,
score, or simulate policies.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from policy_api import load_context, normalise_placements  # noqa: E402
from score_policy import audit  # noqa: E402


GUI_MASK_ACTIONS = {
    "light_road": "reflective_pavement",
    "cool_roof": "cool_roof",
    "green_roof": "green_roof",
    "grass_conversion": "depaved_pavement",
    "shade_canopy": "shade_canopy",
    "solar_canopy": "solar_canopy",
}


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def packed_mask(mask: np.ndarray) -> dict[str, int | str]:
    packed = np.packbits(mask.reshape(-1), bitorder="little")
    return {
        "width": int(mask.shape[1]),
        "height": int(mask.shape[0]),
        "count": int(mask.sum()),
        "data": base64.b64encode(packed.tobytes()).decode("ascii"),
    }


def load_policy(candidate: dict) -> types.ModuleType:
    candidate_id = str(candidate["id"])
    source = candidate.get("code")
    if not isinstance(source, str) or not source.strip():
        raise ValueError(f"{candidate_id} has no stored policy source")
    module = types.ModuleType(f"shade_imported_{candidate_id}")
    module.__file__ = f"<results/evolution/candidates/{candidate_id}.json>"
    exec(compile(source, module.__file__, "exec"), module.__dict__)  # noqa: S102 - trusted Git artifact
    if not callable(getattr(module, "plan", None)):
        raise ValueError(f"{candidate_id} does not define plan(ctx, budget_usd)")
    return module


def build_layout(candidate_id: str, aoi: str, ctx, placements: list) -> dict:
    masks = {
        request_key: np.zeros(ctx.shape, dtype=bool)
        for request_key in GUI_MASK_ACTIONS.values()
    }
    trees: list[dict] = []
    tree_index = 0
    for placement in placements:
        if placement.action in ("tree_small", "tree_medium"):
            spec = ctx.interventions[placement.action]["raster_edit"]
            size = "small" if placement.action == "tree_small" else "medium"
            for row, col in zip(placement.rows, placement.cols):
                trees.append({
                    "id": f"{candidate_id}-{aoi}-{placement.action}-{tree_index}",
                    "x": float(col) + 0.5,
                    "y": float(row) + 0.5,
                    "size": size,
                    "heightM": float(spec["cdsm_height_m"]),
                    "crownDiameterM": float(spec["crown_radius_m"]) * 2.0,
                })
                tree_index += 1
        elif placement.action in GUI_MASK_ACTIONS:
            masks[GUI_MASK_ACTIONS[placement.action]][placement.rows, placement.cols] = True
        else:
            raise ValueError(f"{candidate_id} uses unsupported action {placement.action!r}")
    return {
        "schema_version": 1,
        "candidate_id": candidate_id,
        "aoi": aoi,
        "resolution_m": float(ctx.res_m),
        "width": int(ctx.shape[1]),
        "height": int(ctx.shape[0]),
        "trees": trees,
        "interventions": {
            request_key: packed_mask(mask) for request_key, mask in masks.items()
        },
    }


def import_results(source: Path, output: Path, *, limit: int | None = None) -> dict:
    summary = json.loads((source / "summary.json").read_text(encoding="utf-8"))
    candidate_paths = sorted(
        (source / "candidates").glob("*.json"),
        key=lambda path: int(json.loads(path.read_text(encoding="utf-8"))["generation"]),
    )
    candidates = [json.loads(path.read_text(encoding="utf-8")) for path in candidate_paths]
    candidates = [candidate for candidate in candidates if candidate.get("verdict") == "feasible"]
    if limit is not None:
        candidates = candidates[:limit]
    aois = [str(aoi) for aoi in summary["aois"]]
    budget = float(summary["budget_usd"])
    layout_files: dict[str, dict[str, str]] = {str(candidate["id"]): {} for candidate in candidates}
    policy_metadata: dict[str, tuple[str | None, str | None]] = {}

    for aoi in aois:
        print(f"Loading {aoi} planning context...", flush=True)
        ctx = load_context(ROOT / "data" / "aoi" / aoi)
        for index, candidate in enumerate(candidates, start=1):
            candidate_id = str(candidate["id"])
            module = load_policy(candidate)
            placements = normalise_placements(module.plan(ctx, budget))
            problems, _ = audit(ctx, placements, budget)
            if problems:
                joined = "; ".join(problems)
                raise RuntimeError(f"{candidate_id} is no longer feasible on {aoi}: {joined}")
            layout = build_layout(candidate_id, aoi, ctx, placements)
            relative = Path("layouts") / candidate_id / f"{aoi}.json"
            atomic_json(output / relative, layout)
            layout_files[candidate_id][aoi] = relative.as_posix()
            policy_metadata[candidate_id] = (
                getattr(module, "POLICY_NAME", None),
                getattr(module, "DESCRIPTION", None),
            )
            if index == 1 or index % 10 == 0 or index == len(candidates):
                print(f"  {aoi}: {index}/{len(candidates)} layouts", flush=True)

    public_fields = (
        "id", "generation", "parent_id", "inspiration_ids", "policy_name",
        "description", "verdict", "fitness", "objectives", "violations",
        "cell", "aois_scored", "timestamp_utc", "model",
    )
    iterations = []
    for candidate in candidates:
        candidate_id = str(candidate["id"])
        iteration = {key: candidate[key] for key in public_fields if key in candidate}
        name, description = policy_metadata[candidate_id]
        if name:
            iteration["policy_name"] = name
        if description:
            iteration["description"] = description
        iteration["layout_files"] = layout_files[candidate_id]
        iteration["score_files"] = {}
        iterations.append(iteration)

    timestamps = [str(candidate.get("timestamp_utc", "")) for candidate in candidates]
    run_id = output.name
    archive = {
        "schema_version": 1,
        "state": "complete",
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "run": {
            "id": run_id,
            "started_utc": min((value for value in timestamps if value), default=None),
            "aois": aois,
            "scenarios": ["baseline"],
            "budget_usd_per_aoi": budget,
            "budget_usd": budget,
            "resolution_m": 1.0,
            "model": summary.get("model"),
            "source": "tracked results/evolution export",
        },
        "iterations": iterations,
        "summary": {
            **summary,
            "best_id": summary.get("best_id"),
            "imported_candidate_count": len(iterations),
        },
    }
    atomic_json(output / "archive.json", archive)
    print(f"Imported {len(iterations)} feasible iterations into {output}", flush=True)
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=ROOT / "results" / "evolution",
        help="Tracked evolution-results directory",
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "runs" / "evolve_20260823T045409Z",
        help="GUI archive directory to create (must not already exist)",
    )
    parser.add_argument("--limit", type=int, help="Import only the first N candidates for a smoke test")
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_dir():
        parser.error(f"source directory does not exist: {source}")
    if output.exists():
        parser.error(f"output already exists: {output}")
    import_results(source, output, limit=args.limit)


if __name__ == "__main__":
    main()
