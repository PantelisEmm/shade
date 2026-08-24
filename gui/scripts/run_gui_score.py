"""Run the authoritative policy scorer for one saved GUI layout.

This wrapper only adds job progress/status around ``scripts/score_policy.py``;
the audit, raster edits, SOLWEIG calls, and objective calculations remain in the
repository scorer itself.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GUI_ROOT = Path(__file__).resolve().parents[1]
ROOT = GUI_ROOT.parent
SCORER = ROOT / "scripts" / "score_policy.py"
POLICY = GUI_ROOT / "scripts" / "gui_policy.py"


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


class Status:
    def __init__(self, path: Path, run_id: str) -> None:
        self.path = path
        self.run_id = run_id
        self.started = time.time()

    def update(self, state: str, stage: str, progress: int, **extra: Any) -> None:
        atomic_json(self.path, {
            "id": self.run_id,
            "state": state,
            "stage": stage,
            "progress": max(0, min(100, int(progress))),
            "elapsed_seconds": round(time.time() - self.started, 1),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            **extra,
        })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    run_dir = request_path.parent
    status = Status(run_dir / "status.json", str(request["id"]))
    score_dir = run_dir / "score"
    score_dir.mkdir(parents=True, exist_ok=True)
    configured = json.loads((ROOT / "config" / "aois.json").read_text(encoding="utf-8"))["aois"]
    aoi = str(request.get("aoi", "chinatown"))
    if aoi not in configured:
        raise ValueError(f"Unknown study area: {aoi}")
    gui_manifest_path = GUI_ROOT / "public" / "data" / aoi / "manifest.json"
    gui_manifest = json.loads(gui_manifest_path.read_text(encoding="utf-8"))
    source_directory = ROOT / str(gui_manifest.get("source_directory", f"data/aoi/{aoi}"))
    metadata = json.loads((source_directory / "aoi.json").read_text(encoding="utf-8"))
    resolution = float(metadata["resolution_m"])
    scenario = str(request.get("scenario", "baseline"))
    budget = float(request.get("budget_usd", 500_000))

    command = [
        sys.executable,
        str(SCORER),
        "--policy", str(POLICY),
        "--aoi", aoi,
        "--scenarios", scenario,
        "--budget", str(budget),
        "--res", f"{resolution:g}",
        "--date", "07-27",
        "--hours", "10,13,16",
        "--out", str(score_dir),
    ]
    if configured[aoi].get("split") == "held_out":
        command.append("--allow-held-out")
    env = {**os.environ, "SHADE_GUI_POLICY_REQUEST": str(request_path), "PYTHONUNBUFFERED": "1"}
    status.update("running", "Auditing layout and siting", 5)

    log_path = run_dir / "runner.log"
    child: subprocess.Popen[str] | None = None

    def stop_child(signum, _frame):
        if child is not None and child.poll() is None:
            child.terminate()
        status.update("cancelled", "Cancelled by user", 100)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop_child)
    signal.signal(signal.SIGINT, stop_child)

    try:
        with log_path.open("a", encoding="utf-8") as log:
            child = subprocess.Popen(
                command,
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert child.stdout is not None
            for line in child.stdout:
                log.write(line)
                log.flush()
                stripped = line.strip()
                if "INFEASIBLE" in stripped:
                    status.update("running", "Preparing audit report", 92)
                elif "surfaces ready" in stripped:
                    status.update("running", "Running intervention SOLWEIG", 52)
                elif "relief" in stripped and "degC UTCI" in stripped:
                    status.update("running", "Calculating policy objectives", 90)
                elif stripped.startswith(aoi) and "$" in stripped:
                    status.update("running", "Layout passed audit; preparing surfaces", 22)
            code = child.wait()
        if code != 0:
            raise RuntimeError(f"Policy scorer exited with code {code}; see runner.log")
        score_path = score_dir / "score.json"
        if not score_path.exists():
            raise RuntimeError("Policy scorer did not write score.json")
        report = json.loads(score_path.read_text(encoding="utf-8"))
        report["gui"] = {
            "layout_signature": request.get("layout_signature"),
            "aoi": aoi,
            "scenario": scenario,
            "budget_usd": budget,
        }
        atomic_json(score_path, report)
        verdict = str(report.get("verdict", "unknown"))
        stage = "Policy score complete" if verdict == "feasible" else "Layout audit complete"
        status.update("complete", stage, 100, result=report)
    except BaseException as exc:
        if isinstance(exc, SystemExit):
            raise
        status.update("failed", "Policy scoring stopped", 100, error=str(exc))
        raise


if __name__ == "__main__":
    main()
