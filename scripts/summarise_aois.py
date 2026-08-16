"""Profile every built AOI: morphology, heat and the population behind it.

    python scripts/summarise_aois.py

Writes data/aoi/summary.csv. This is the context the policy prompt needs (what
kind of place is this?) and the denominator the auditor needs (who benefits?).
Population comes from Climate Ready Boston's tract-level social vulnerability
layer, apportioned to each AOI by area of overlap.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from pathlib import Path

_PREFIX = Path(sys.executable).parent
for _var, _sub in (("GDAL_DATA", "Library/share/gdal"), ("PROJ_LIB", "Library/share/proj")):
    if _var not in os.environ and (_PREFIX / _sub).is_dir():
        os.environ[_var] = str(_PREFIX / _sub)

import geopandas as gpd
import numpy as np
import rasterio
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[1]
AOI_DIR = ROOT / "data" / "aoi"
SVI = ROOT / "data" / "heat" / "climate_ready_social_vulnerability.geojson"

# Counts in the vulnerability layer that we apportion by area.
SVI_COUNTS = ["POP100_RE", "OlderAdult", "TotChild", "POC2", "LEP", "Low_to_No", "TotDis"]


def raster(path: Path) -> np.ndarray:
    with rasterio.open(path) as src:
        a = src.read(1).astype("float64")
        if src.nodata is not None:
            a = np.where(a == src.nodata, np.nan, a)
    return a


def main() -> None:
    svi = gpd.read_file(SVI).to_crs("EPSG:26986")
    svi["_area"] = svi.geometry.area
    aois = json.loads((ROOT / "config" / "aois.json").read_text())["aois"]

    rows = []
    for name in sorted(p.name for p in AOI_DIR.iterdir() if p.is_dir()):
        d = AOI_DIR / name
        if not (d / "aoi.json").exists():
            continue
        meta = json.loads((d / "aoi.json").read_text())
        lc = rasterio.open(d / "landcover.tif").read(1)
        cdsm = raster(d / "cdsm.tif")
        dsm, dem = raster(d / "dsm.tif"), raster(d / "dem.tif")
        n = lc.size

        bh = (dsm - dem)[lc == 2]
        bh = bh[np.isfinite(bh)]

        # Apportion tract populations by the share of each tract inside the AOI.
        aoi_box = gpd.GeoDataFrame(geometry=[box(*meta["bbox_26986"])], crs="EPSG:26986")
        hit = gpd.overlay(svi, aoi_box, how="intersection")
        pop = {}
        if len(hit):
            share = hit.geometry.area / hit["_area"]
            for col in SVI_COUNTS:
                pop[col] = float((hit[col].astype(float) * share).sum())
        else:
            pop = {col: 0.0 for col in SVI_COUNTS}

        total = pop["POP100_RE"] or 1.0
        rows.append({
            "aoi": name,
            "split": aois.get(name, {}).get("split", "?"),
            "label": aois.get(name, {}).get("label", ""),
            "canopy_pct": round(100 * (lc == 4).mean(), 1),
            "building_pct": round(100 * (lc == 2).mean(), 1),
            "paved_pct": round(100 * (lc == 1).mean(), 1),
            "grass_pct": round(100 * (lc == 5).mean(), 1),
            "water_pct": round(100 * (lc == 7).mean(), 1),
            "canopy_h_median_m": round(float(np.median(cdsm[cdsm > 0])) if (cdsm > 0).any() else 0.0, 1),
            "bldg_h_median_m": round(float(np.median(bh)) if bh.size else 0.0, 1),
            "bldg_h_p95_m": round(float(np.percentile(bh, 95)) if bh.size else 0.0, 1),
            "ta3pm_mean_c": round(float(np.nanmean(raster(d / "heat_ta3pm.tif"))), 2),
            "ta3am_mean_c": round(float(np.nanmean(raster(d / "heat_ta3am.tif"))), 2),
            "uhii_mean_c": round(float(np.nanmean(raster(d / "heat_uhii.tif"))), 2),
            "heat_hours_mean": round(float(np.nanmean(raster(d / "heat_hours.tif"))), 1),
            "population": round(pop["POP100_RE"]),
            "pct_poc": round(100 * pop["POC2"] / total, 1),
            "pct_older_adult": round(100 * pop["OlderAdult"] / total, 1),
            "pct_children": round(100 * pop["TotChild"] / total, 1),
            "pct_low_no_income": round(100 * pop["Low_to_No"] / total, 1),
            "pct_limited_english": round(100 * pop["LEP"] / total, 1),
            "crowns": meta.get("cdsm_build", {}).get("crowns_painted", 0),
        })
        print(f"  {name:24s} canopy {rows[-1]['canopy_pct']:4.1f}%  "
              f"UHII {rows[-1]['uhii_mean_c']:4.2f}C  pop {rows[-1]['population']:5d}")

    out = AOI_DIR / "summary.csv"
    with open(out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n{len(rows)} AOIs -> {out}")


if __name__ == "__main__":
    main()
