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

import numpy as np
import solweig

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="dudley_square")
    ap.add_argument("--scenario", default="baseline")
    ap.add_argument("--date", default="07-27", help="MM-DD to simulate")
    ap.add_argument("--hours", default="15", help="comma-separated hours of day")
    args = ap.parse_args()

    aoi = ROOT / "data" / "aoi" / args.aoi
    epw = ROOT / "data" / "weather" / "scenarios" / f"boston_{args.scenario}.epw"
    out = ROOT / "runs" / f"smoke_{args.aoi}_{args.scenario}"
    print(f"AOI      {aoi}")
    print(f"weather  {epw.name}")

    t0 = time.time()
    surface = solweig.SurfaceData.prepare(
        dsm=str(aoi / "dsm.tif"),
        cdsm=str(aoi / "cdsm.tif"),
        dem=str(aoi / "dem.tif"),
        land_cover=str(aoi / "landcover.tif"),
        working_dir=str(out / "cache"),
    )
    print(f"surface prepared in {time.time() - t0:.1f}s")

    location = solweig.Location.from_epw(str(epw))
    weather = solweig.Weather.from_epw(str(epw))
    hours = {int(h) for h in args.hours.split(",")}
    month, day = (int(v) for v in args.date.split("-"))
    picked = [w for w in weather
              if w.datetime.month == month and w.datetime.day == day and w.datetime.hour in hours]
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
    print(f"solweig ran in {time.time() - t0:.1f}s")

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
