"""Rescore an imported Autoresearch archive at 1 m and cache GUI map rasters.

This is a deterministic replay of fixed archived layouts.  It does not invoke
an LLM or evolve policies.  Each layout is simulated for the baseline weather
scenario at 10:00, 13:00, and 16:00; the per-hour browser maps are retained and
the three-hour fields are pooled into the repository scoring objectives.

The job is deliberately sequential and resumable.  Re-running the command
skips completed map files and completed 1 m candidate scores.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
GUI_ROOT = ROOT / "gui"
SCRIPTS = ROOT / "scripts"
GUI_SCRIPTS = GUI_ROOT / "scripts"
for directory in (SCRIPTS, GUI_SCRIPTS):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

import run_gui_solweig as gui_solweig  # noqa: E402
from policy_api import Placement, apply_placements, load_context, price  # noqa: E402
from score_policy import ACCESS_THRESHOLD_C, aggregate, objectives  # noqa: E402


MASK_TO_ACTION = {
    "reflective_pavement": "light_road",
    "cool_roof": "cool_roof",
    "green_roof": "green_roof",
    "depaved_pavement": "grass_conversion",
    "shade_canopy": "shade_canopy",
    "solar_canopy": "solar_canopy",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def decode_mask(value: dict, shape: tuple[int, int]) -> np.ndarray:
    rows, cols = shape
    if int(value["width"]) != cols or int(value["height"]) != rows:
        raise ValueError(f"Archived mask {value['width']}x{value['height']} does not match {cols}x{rows}")
    packed = np.frombuffer(base64.b64decode(value["data"]), dtype="uint8")
    return np.unpackbits(packed, bitorder="little")[: rows * cols].reshape(shape).astype(bool)


def placements_from_layout(layout: dict) -> list[Placement]:
    shape = (int(layout["height"]), int(layout["width"]))
    placements: list[Placement] = []
    for size in ("small", "medium"):
        trees = [tree for tree in layout.get("trees", []) if tree.get("size") == size]
        if trees:
            placements.append(Placement(
                f"tree_{size}",
                [int(np.floor(float(tree["y"]))) for tree in trees],
                [int(np.floor(float(tree["x"]))) for tree in trees],
            ))
    for request_key, action in MASK_TO_ACTION.items():
        value = layout.get("interventions", {}).get(request_key)
        if not value:
            continue
        rows, cols = np.nonzero(decode_mask(value, shape))
        if rows.size:
            placements.append(Placement(action, rows, cols))
    return placements


def request_for(layout: dict, run_id: str, aoi: str, scenario: str, hour: int) -> dict:
    interventions = layout.get("interventions", {})
    return {
        "id": run_id,
        "mode": "comparison",
        "aoi": aoi,
        "trees": layout.get("trees", []),
        "reflective_pavement": interventions.get("reflective_pavement"),
        "cool_roof": interventions.get("cool_roof"),
        "green_roof": interventions.get("green_roof"),
        "depaved_pavement": interventions.get("depaved_pavement"),
        "shade_canopy": interventions.get("shade_canopy"),
        "solar_canopy": interventions.get("solar_canopy"),
        "scenario": scenario,
        "date": "07-27",
        "hour": hour,
    }


def grid_hash(aoi: str) -> str:
    aoi_dir = ROOT / "data" / "aoi" / aoi
    metadata = json.loads((aoi_dir / "aoi.json").read_text(encoding="utf-8"))
    with __import__("rasterio").open(aoi_dir / "landcover.tif") as source:
        shape = (source.height, source.width)
        resolution = abs(float(source.transform.a))
    return gui_solweig.fingerprint({
        "aoi": aoi,
        "source_directory": f"data/aoi/{aoi}",
        "resolution_m": resolution,
        "shape": shape,
        "built_utc": metadata.get("built_utc"),
    })


def cached_arrays(aoi: str, result: dict, scenario: str, hour: int) -> tuple[dict, dict]:
    grid = grid_hash(aoi)
    forcing = gui_solweig.fingerprint({
        "physics_version": gui_solweig.PHYSICS_VERSION,
        "grid_hash": grid,
        "scenario": scenario,
        "date": "07-27",
        "hour": hour,
    })
    cache = ROOT / "runs" / "gui_solweig" / "cache" / aoi / grid
    baseline_path = cache / "baseline_results" / forcing / "gui_result.npz"
    intervention_path = cache / "layout_results" / result["layout_hash"] / forcing / "gui_result.npz"
    if not baseline_path.exists() or not intervention_path.exists():
        raise FileNotFoundError(f"SOLWEIG cache arrays are missing for {aoi} at {hour}:00")
    with np.load(baseline_path) as stored:
        baseline = {"tmrt": stored["tmrt"].astype("float64"), "utci": stored["utci"].astype("float64")}
    with np.load(intervention_path) as stored:
        intervention = {"tmrt": stored["tmrt"].astype("float64"), "utci": stored["utci"].astype("float64")}
    return baseline, intervention


def completed_result(job_dir: Path, request: dict) -> dict | None:
    result_path = job_dir / "result.json"
    if not result_path.exists():
        return None
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if (
        result.get("state") == "complete"
        and result.get("aoi") == request["aoi"]
        and result.get("scenario") == request["scenario"]
        and int(result.get("hour", -1)) == request["hour"]
        and result.get("physics_version") == gui_solweig.PHYSICS_VERSION
    ):
        return result
    return None


def simulate(layout: dict, candidate_id: str, aoi: str, scenario: str, hour: int, log) -> dict:
    run_id = f"autoresearch1m-{candidate_id}-{aoi}-{scenario}-{hour}"
    job_dir = ROOT / "runs" / "gui_solweig" / run_id
    job_dir.mkdir(parents=True, exist_ok=True)
    request = request_for(layout, run_id, aoi, scenario, hour)
    request_path = job_dir / "request.json"
    atomic_json(request_path, request)
    cached = completed_result(job_dir, request)
    if cached is not None:
        return cached
    command = [str(ROOT / ".venv" / "bin" / "python"), str(GUI_SCRIPTS / "run_gui_solweig.py"), "--request", str(request_path)]
    worker = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        returncode = worker.wait(timeout=1800)
    except BaseException:
        # Do not leave a costly SOLWEIG child running when the resumable batch
        # is interrupted or a single simulation exceeds its time allowance.
        os.killpg(worker.pid, signal.SIGTERM)
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait()
        raise
    if returncode != 0:
        status_path = job_dir / "status.json"
        detail = json.loads(status_path.read_text()).get("error") if status_path.exists() else None
        raise RuntimeError(f"{run_id} failed with code {returncode}: {detail or 'see batch log'}")
    result = completed_result(job_dir, request)
    if result is None:
        raise RuntimeError(f"{run_id} finished without a compatible result")
    return result


def update_summary(archive: dict) -> None:
    complete = [
        iteration for iteration in archive["iterations"]
        if iteration.get("score_resolution_m") == 1 and iteration.get("fitness") is not None
    ]
    best = max(complete, key=lambda iteration: iteration["fitness"], default=None)
    archive["summary"] = {
        "best_id": best.get("id") if best else None,
        "best_fitness": best.get("fitness") if best else None,
        "best_policy_name": best.get("policy_name") if best else None,
        "completed_1m": len(complete),
        "total_candidates": len(archive["iterations"]),
        "source": "Recomputed from fixed Git policies with GUI SOLWEIG physics",
    }


def prepare_archive(archive: dict) -> None:
    if "source_2m_summary" not in archive:
        archive["source_2m_summary"] = archive.get("summary")
    for iteration in archive["iterations"]:
        if "source_2m" not in iteration:
            iteration["source_2m"] = {
                "fitness": iteration.get("fitness"),
                "objectives": iteration.get("objectives"),
            }
        if (
            iteration.get("score_resolution_m") != 1
            or iteration.get("score_physics_version") != gui_solweig.PHYSICS_VERSION
        ):
            iteration["fitness"] = None
            iteration["objectives"] = None
            iteration.pop("score_resolution_m", None)
            iteration.pop("score_physics_version", None)
    archive["state"] = "running"
    archive["updated_utc"] = now()
    archive["run"].update({
        "resolution_m": 1.0,
        "score_resolution_m": 1.0,
        "layout_resolution_m": 1.0,
        "scenarios": ["baseline"],
        "hours": [10, 13, 16],
        "date": "07-27",
        "physics_version": gui_solweig.PHYSICS_VERSION,
    })
    update_summary(archive)


def score_candidate(archive_dir: Path, iteration: dict, aois: list[str], hours: list[int], scenario: str, log) -> dict:
    candidate_id = str(iteration["id"])
    simulation_files = iteration.setdefault("simulation_files", {})
    score_runs = []
    for aoi in aois:
        layout_path = archive_dir / iteration["layout_files"][aoi]
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        ctx = load_context(ROOT / "data" / "aoi" / aoi)
        placements = placements_from_layout(layout)
        applied = apply_placements(ctx, placements)
        total, by_action, counts = price(ctx, placements)
        spend = {"total_usd": total, "by_action_usd": by_action, "by_action_units": counts}
        hourly_baselines, hourly_interventions = [], []
        for hour in hours:
            result = simulate(layout, candidate_id, aoi, scenario, hour, log)
            relative = Path("simulations") / candidate_id / aoi / f"{scenario}_{hour}.json"
            atomic_json(archive_dir / relative, result)
            simulation_files.setdefault(aoi, {}).setdefault(scenario, {})[str(hour)] = relative.as_posix()
            baseline, intervention = cached_arrays(aoi, result, scenario, hour)
            hourly_baselines.append(baseline)
            hourly_interventions.append(intervention)
            print(f"    {aoi} {hour}:00 map ready", flush=True)
        shape = hourly_baselines[0]["utci"].shape
        base = {
            "utci": np.mean([item["utci"] for item in hourly_baselines], axis=0),
            "tmrt": np.mean([item["tmrt"] for item in hourly_baselines], axis=0),
            "shade_hours": np.zeros(shape, dtype="float64"),
            "n_timesteps": len(hours),
        }
        intervention = {
            "utci": np.mean([item["utci"] for item in hourly_interventions], axis=0),
            "tmrt": np.mean([item["tmrt"] for item in hourly_interventions], axis=0),
            "shade_hours": np.zeros(shape, dtype="float64"),
            "n_timesteps": len(hours),
        }
        metrics = objectives(
            ctx,
            (slice(0, ctx.shape[0]), slice(0, ctx.shape[1])),
            base,
            intervention,
            applied,
            spend,
            ACCESS_THRESHOLD_C,
        )
        score_runs.append({
            "aoi": aoi,
            "split": ctx.split,
            "scenario": scenario,
            "spend_usd": total,
            "n_timesteps": len(hours),
            "baseline_cached": True,
            "metrics": metrics,
        })
    combined = aggregate(score_runs)
    score = {
        "schema_version": 1,
        "candidate_id": candidate_id,
        "verdict": "feasible",
        "physics_version": gui_solweig.PHYSICS_VERSION,
        "resolution_m": 1.0,
        "scenario": scenario,
        "date": "07-27",
        "hours": hours,
        "objectives": combined,
        "runs": score_runs,
        "generated_utc": now(),
    }
    relative_score = Path("scores_1m") / f"{candidate_id}.json"
    atomic_json(archive_dir / relative_score, score)
    iteration["score_files"] = {"aggregate": relative_score.as_posix()}
    iteration["objectives"] = combined
    iteration["fitness"] = combined.get("heat_relief_c")
    iteration["score_resolution_m"] = 1.0
    iteration["score_physics_version"] = gui_solweig.PHYSICS_VERSION
    return score


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ROOT / "runs" / "evolve_20260823T045409Z")
    parser.add_argument("--scenario", default="baseline")
    parser.add_argument("--hours", default="10,13,16")
    parser.add_argument("--limit", type=int, help="Process at most N not-yet-scored candidates")
    parser.add_argument("--workers", type=int, default=1, help="Candidates to simulate concurrently (default: 1)")
    parser.add_argument("--rayon-threads", type=int, help="Rust ray-tracing threads available to each worker")
    args = parser.parse_args()
    if args.rayon_threads is not None:
        if args.rayon_threads < 1:
            parser.error("--rayon-threads must be at least 1")
        os.environ["RAYON_NUM_THREADS"] = str(args.rayon_threads)
    archive_dir = args.archive.resolve()
    archive_path = archive_dir / "archive.json"
    archive = json.loads(archive_path.read_text(encoding="utf-8"))
    hours = [int(value) for value in args.hours.split(",") if value.strip()]
    aois = [str(aoi) for aoi in archive["run"]["aois"]]
    prepare_archive(archive)
    atomic_json(archive_path, archive)
    pending = [
        iteration for iteration in archive["iterations"]
        if iteration.get("score_resolution_m") != 1
        or iteration.get("score_physics_version") != gui_solweig.PHYSICS_VERSION
    ]
    if args.limit is not None:
        pending = pending[:args.limit]
    log_path = archive_dir / "precompute_1m.log"
    try:
        with log_path.open("a", encoding="utf-8") as log:
            workers = max(1, args.workers)
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(score_candidate, archive_dir, iteration, aois, hours, args.scenario, log): (index, iteration)
                    for index, iteration in enumerate(pending, start=1)
                }
                for future in as_completed(futures):
                    index, iteration = futures[future]
                    print(f"[{index}/{len(pending)}] completed {iteration['id']} · {iteration.get('policy_name', 'policy')}", flush=True)
                    future.result()
                    archive["updated_utc"] = now()
                    update_summary(archive)
                    atomic_json(archive_path, archive)
                    print(f"  1 m score {iteration['fitness']:.4f}°C UTCI relief", flush=True)
    except Exception as error:
        archive["state"] = "failed"
        archive["error"] = str(error)
        archive["updated_utc"] = now()
        update_summary(archive)
        atomic_json(archive_path, archive)
        raise
    complete = all(iteration.get("score_resolution_m") == 1 for iteration in archive["iterations"])
    archive["state"] = "complete" if complete else "running"
    archive.pop("error", None)
    archive["updated_utc"] = now()
    update_summary(archive)
    atomic_json(archive_path, archive)
    print(f"Archive {archive['state']}: {archive['summary']['completed_1m']}/{archive['summary']['total_candidates']} 1 m scores", flush=True)


if __name__ == "__main__":
    main()
