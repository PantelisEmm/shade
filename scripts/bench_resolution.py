"""Measure how SOLWEIG cost scales with pixel size on one AOI.

    python scripts/bench_resolution.py --aoi dudley_square --res 4,2,1

Times `SurfaceData.prepare` (sky-view factors and wall geometry, cached per AOI
geometry) separately from `calculate` (per timestep), because the loop pays them
at different rates. Writes runs/bench_resolution.csv.
"""
from __future__ import annotations

import argparse
import csv
import os
import shutil
import sys
import time
from pathlib import Path

_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)
# SOLWEIG logs a Unicode check mark that the Windows cp1252 console cannot encode.
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import numpy as np
import solweig

solweig.disable_gpu()  # before any tiling call — see DATA_MANIFEST.md section 8
ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="dudley_square")
    ap.add_argument("--res", default="4,2,1")
    ap.add_argument("--date", default="07-27")
    ap.add_argument("--hours", default="9,12,15,18")
    args = ap.parse_args()

    epw = ROOT / "data" / "weather" / "scenarios" / "boston_baseline.epw"
    location = solweig.Location.from_epw(str(epw))
    hours = sorted(int(h) for h in args.hours.split(","))
    weather = solweig.Weather.from_epw(str(epw), start=args.date, end=args.date, hours=hours)
    print(f"{len(weather)} timesteps on {args.date}: {[w.datetime.hour for w in weather]}", flush=True)

    rows = []
    for res in [float(r) for r in args.res.split(",")]:
        suffix = "" if abs(res - 1.0) < 1e-9 else f"_{res:g}m"
        aoi = ROOT / "data" / "aoi" / f"{args.aoi}{suffix}"
        if not aoi.exists():
            print(f"skip {aoi.name}: not built", flush=True)
            continue
        out = ROOT / "runs" / f"bench_{aoi.name}"
        shutil.rmtree(out, ignore_errors=True)  # force a cold SVF computation

        import rasterio
        with rasterio.open(aoi / "dsm.tif") as s:
            npx = s.width * s.height
        print(f"\n=== {aoi.name}: {res} m, {npx:,} px", flush=True)

        t0 = time.time()
        surface = solweig.SurfaceData.prepare(
            dsm=str(aoi / "dsm.tif"), cdsm=str(aoi / "cdsm.tif"),
            dem=str(aoi / "dem.tif"), land_cover=str(aoi / "landcover.tif"),
            working_dir=str(out / "cache"),
        )
        t_prep = time.time() - t0
        print(f"  prepare  {t_prep:8.1f}s", flush=True)

        t0 = time.time()
        summary = solweig.calculate(surface=surface, weather=weather, location=location,
                                    output_dir=str(out), outputs=["tmrt", "shadow"])
        t_calc = time.time() - t0
        cache_mb = sum(f.stat().st_size for f in (out / "cache").rglob("*") if f.is_file()) / 1e6
        tmrt = np.asarray(summary.tmrt_mean, dtype="float64")
        tmrt = tmrt[np.isfinite(tmrt)]
        print(f"  calc     {t_calc:8.1f}s  ({t_calc/len(weather):.2f}s/step)   cache {cache_mb:.0f} MB", flush=True)
        print(f"  tmrt_mean mean {tmrt.mean():.1f}C  max {tmrt.max():.1f}C", flush=True)

        rows.append({
            "aoi": aoi.name, "res_m": res, "pixels": npx,
            "prepare_s": round(t_prep, 1), "calc_s": round(t_calc, 1),
            "calc_s_per_step": round(t_calc / len(weather), 2),
            "timesteps": len(weather), "cache_mb": round(cache_mb),
            "tmrt_mean_c": round(float(tmrt.mean()), 2), "tmrt_max_c": round(float(tmrt.max()), 2),
        })

    if rows:
        out_csv = ROOT / "runs" / "bench_resolution.csv"
        out_csv.parent.mkdir(exist_ok=True)
        with open(out_csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
        print(f"\n{'res':>5} {'pixels':>10} {'prepare':>9} {'calc/step':>10} {'cache':>7} {'tmrt mean':>10}")
        for r in rows:
            print(f"{r['res_m']:>5} {r['pixels']:>10,} {r['prepare_s']:>8.1f}s {r['calc_s_per_step']:>9.2f}s "
                  f"{r['cache_mb']:>6}MB {r['tmrt_mean_c']:>9.1f}C")
        print(f"\n-> {out_csv}")


if __name__ == "__main__":
    main()
