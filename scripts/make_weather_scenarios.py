"""Build the SHADE climate-scenario set: EPW files SOLWEIG can read directly.

Starts from the Boston Logan TMYx (2011-2025) EPW and writes one EPW per
scenario into data/weather/scenarios/, plus scenarios.json describing them.

    python scripts/make_weather_scenarios.py
    python scripts/make_weather_scenarios.py --list

Scenarios
---------
baseline        Typical meteorological year, unmodified.
hot_day         Same year, but the run window is the hottest summer day in it.
warm_2c         Dry-bulb + 2.0 C  -- ~2050s, in the middle of the BRAG range.
warm_4c         Dry-bulb + 4.0 C  -- ~2070s under a high-emissions pathway.
humid_warm_2c   +2.0 C with dew point raised to hold relative humidity fixed,
                which is the harsher case for heat stress than warming alone.

Warming deltas come from the Boston Research Advisory Group climate
projections consensus (Climate Ready Boston, 2016): roughly +3-5 F by
mid-century and +4-10 F by late century, higher under RCP 8.5.

Morphing here is a uniform shift, which is deliberately simple and
conservative. It is enough to ask "does this policy still hold up when it gets
hotter?", which is what the auditor needs. It is not a downscaled projection,
and the manifest says so.
"""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEATHER = ROOT / "data" / "weather"
SOURCE_ZIP = WEATHER / "USA_MA_Boston-Logan.Intl.AP.725090_TMYx.2011-2025.zip"
OUT = WEATHER / "scenarios"

# EPW hourly data columns (0-indexed) we touch.
C_MONTH, C_DAY, C_HOUR = 1, 2, 3
C_TDB, C_TDEW, C_RH = 6, 7, 8

SCENARIOS = {
    "baseline": {"dt": 0.0, "hold_rh": False, "label": "TMYx 2011-2025, unmodified"},
    "warm_2c": {"dt": 2.0, "hold_rh": False, "label": "+2.0 C dry-bulb (~2050s)"},
    "warm_4c": {"dt": 4.0, "hold_rh": False, "label": "+4.0 C dry-bulb (~2070s, high emissions)"},
    "humid_warm_2c": {"dt": 2.0, "hold_rh": True, "label": "+2.0 C at constant relative humidity"},
}


def unpack_epw() -> Path:
    """Return the path to the extracted source EPW, extracting it on first use."""
    epw = next(WEATHER.glob("*.epw"), None)
    if epw:
        return epw
    if not SOURCE_ZIP.exists():
        raise SystemExit(f"missing {SOURCE_ZIP} -- run scripts/fetch_boston_open_data.sh first")
    with zipfile.ZipFile(SOURCE_ZIP) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".epw"))
        with z.open(name) as src, open(WEATHER / Path(name).name, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return WEATHER / Path(name).name


def sat_vapour_pressure(t_c: float) -> float:
    """Magnus formula, hPa. Used only to re-derive dew point at fixed RH."""
    return 6.112 * pow(10.0, (7.5 * t_c) / (237.7 + t_c))


def dew_point(t_c: float, rh_pct: float) -> float:
    e = max(sat_vapour_pressure(t_c) * rh_pct / 100.0, 1e-6)
    import math

    lg = math.log10(e / 6.112)
    return (237.7 * lg) / (7.5 - lg)


def morph(lines: list[str], dt: float, hold_rh: bool) -> list[str]:
    out = list(lines[:8])  # EPW header is 8 lines
    for line in lines[8:]:
        if not line.strip():
            continue
        f = line.rstrip("\n").split(",")
        try:
            tdb = float(f[C_TDB])
        except (ValueError, IndexError):
            out.append(line)
            continue
        new_tdb = tdb + dt
        f[C_TDB] = f"{new_tdb:.1f}"
        if dt:
            if hold_rh:
                rh = float(f[C_RH])
                f[C_TDEW] = f"{dew_point(new_tdb, rh):.1f}"
            else:
                # Dew point unchanged -> relative humidity falls out of it.
                tdew = float(f[C_TDEW])
                rh = 100.0 * sat_vapour_pressure(tdew) / sat_vapour_pressure(new_tdb)
                f[C_RH] = f"{min(max(rh, 1.0), 100.0):.0f}"
        out.append(",".join(f) + "\n")
    return out


def hottest_day(lines: list[str]) -> tuple[str, float]:
    """Return (YYYY-MM-DD placeholder as MM-DD, mean dry-bulb) for the hottest day."""
    days: dict[tuple[int, int], list[float]] = {}
    for line in lines[8:]:
        f = line.split(",")
        try:
            key = (int(f[C_MONTH]), int(f[C_DAY]))
            days.setdefault(key, []).append(float(f[C_TDB]))
        except (ValueError, IndexError):
            continue
    (m, d), temps = max(days.items(), key=lambda kv: sum(kv[1]) / len(kv[1]))
    return f"{m:02d}-{d:02d}", sum(temps) / len(temps)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for key, spec in SCENARIOS.items():
            print(f"{key:16s} {spec['label']}")
        return

    src = unpack_epw()
    lines = open(src, encoding="latin-1").readlines()
    peak_md, peak_t = hottest_day(lines)
    print(f"source EPW: {src.name}")
    print(f"hottest day in the TMY: {peak_md} (daily mean {peak_t:.1f} C)")

    OUT.mkdir(parents=True, exist_ok=True)
    written = {}
    for key, spec in SCENARIOS.items():
        path = OUT / f"boston_{key}.epw"
        morphed = morph(lines, spec["dt"], spec["hold_rh"])
        path.write_text("".join(morphed), encoding="latin-1")
        written[key] = {
            "file": str(path.relative_to(ROOT)).replace("\\", "/"),
            "delta_tdb_c": spec["dt"],
            "constant_rh": spec["hold_rh"],
            "label": spec["label"],
        }
        print(f"  wrote {path.name}")

    meta = {
        "source_epw": src.name,
        "source": "climate.onebuilding.org, ISD station 725090 Boston Logan Intl AP",
        "peak_day_md": peak_md,
        "peak_day_mean_tdb_c": round(peak_t, 2),
        "suggested_run_window": {
            "start": f"1999-{peak_md}",
            "end": f"1999-{peak_md}",
            "note": "EPW years are synthetic; pass the month-day to solweig.Weather.from_epw "
                    "using whatever year the file carries in that row.",
        },
        "warming_deltas_source": "Boston Research Advisory Group projections, Climate Ready Boston (2016)",
        "caveat": "Uniform dry-bulb shift, not a downscaled climate projection.",
        "scenarios": written,
    }
    (OUT / "scenarios.json").write_text(json.dumps(meta, indent=2))
    print(f"\n{len(written)} scenarios -> {OUT}")


if __name__ == "__main__":
    main()
