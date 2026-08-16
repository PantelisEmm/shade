"""End-to-end check: run SOLWEIG on one AOI for one hot afternoon hour.

    python scripts/smoke_test_solweig.py --aoi dudley_square

Confirms the raster stack, the EPW scenarios and the installed SOLWEIG build
actually fit together before the autoresearch loop depends on them.
"""
from __future__ import annotations

import argparse
import os
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

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="dudley_square")
    ap.add_argument("--scenario", default="baseline")
    ap.add_argument("--date", default="07-27", help="MM-DD to simulate")
    ap.add_argument("--hours", default="15", help="comma-separated hours of day")
    ap.add_argument("--gpu", action="store_true",
                    help="leave the GPU enabled. Off by default: an integrated GPU "
                         "reporting little VRAM caps SOLWEIG's tile side below the "
                         "shadow buffer, which collapses SVF tiling to one tile per "
                         "pixel and never finishes. See DATA_MANIFEST.md section 8.")
    args = ap.parse_args()

    if not args.gpu:
        # Must happen before any tiling call: max_tile_side is cached per context.
        solweig.disable_gpu()

    aoi = ROOT / "data" / "aoi" / args.aoi
    epw = ROOT / "data" / "weather" / "scenarios" / f"boston_{args.scenario}.epw"
    out = ROOT / "runs" / f"smoke_{args.aoi}_{args.scenario}"
    print(f"AOI      {aoi}", flush=True)
    print(f"weather  {epw.name}", flush=True)

    t0 = time.time()
    surface = solweig.SurfaceData.prepare(
        dsm=str(aoi / "dsm.tif"),
        cdsm=str(aoi / "cdsm.tif"),
        dem=str(aoi / "dem.tif"),
        land_cover=str(aoi / "landcover.tif"),
        working_dir=str(out / "cache"),
    )
    t_prepare = time.time() - t0
    print(f"surface prepared in {t_prepare:.1f}s", flush=True)

    location = solweig.Location.from_epw(str(epw))
    hours = sorted(int(h) for h in args.hours.split(","))
    # from_epw defaults to the file's FIRST day only, so the window is explicit.
    picked = solweig.Weather.from_epw(str(epw), start=args.date, end=args.date, hours=hours)
    if not picked:
        raise SystemExit(f"no EPW rows for {args.date} hours {sorted(hours)}")
    for w in picked:
        print(f"  {w.datetime}  Ta={w.ta:.1f}C  RH={w.rh:.0f}%  Kglobal={w.global_rad:.0f} W/m2")

    t0 = time.time()
    summary = solweig.calculate(
        surface=surface,
        weather=picked,
        location=location,
        output_dir=str(out),
        outputs=["tmrt", "shadow", "utci"],
    )
    t_calc = time.time() - t0
    print(f"solweig ran in {t_calc:.1f}s "
          f"({t_calc / max(len(picked), 1):.1f}s per timestep)", flush=True)

    for name in ("tmrt_mean", "utci_max", "tmrt_max"):
        arr = getattr(summary, name, None)
        if arr is not None:
            a = np.asarray(arr, dtype="float64")
            a = a[np.isfinite(a)]
            if a.size:
                print(f"  {name:10s} min {a.min():6.1f}  mean {a.mean():6.1f}  max {a.max():6.1f}")
    print(f"outputs -> {out}")


if __name__ == "__main__":
    main()
