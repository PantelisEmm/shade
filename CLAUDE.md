# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A data pipeline that assembles SOLWEIG-ready raster stacks for 20 Boston study areas
(AOIs), so that shade/cooling interventions can be simulated and scored. There is no
application and no library — `scripts/` are standalone entry points run by hand, and the
output of the pipeline is rasters plus a summary CSV.

Full data provenance, per-source caveats, and known gaps live in `DATA_MANIFEST.md`.
Read it before touching anything involving units, CRS, or data vintage.

## Commands

```bash
bash scripts/env_setup.sh                        # create/update the `shade` conda env
conda activate shade

bash scripts/fetch_boston_open_data.sh           # bulk download; idempotent, skips existing
python scripts/make_weather_scenarios.py         # EPW per climate scenario (--list to inspect)
python scripts/build_aoi.py --list               # show configured AOIs and their split
python scripts/build_aoi.py --aoi dudley_square  # one AOI, ~13 s at 1 m (network-bound)
python scripts/build_aoi.py --all                # all 20
python scripts/summarise_aois.py                 # -> data/aoi/summary.csv (needs built AOIs)

python scripts/smoke_test_solweig.py --aoi dudley_square   # end-to-end SOLWEIG check
```

`build_aoi.py` also takes `--neighborhood <BPDA name>`, `--bbox MINX MINY MAXX MAXY`
(EPSG:26986), and `--res` (default 1.0 m).

There is **no test suite, linter, or CI**. `smoke_test_solweig.py` is the only end-to-end
verification: it runs SOLWEIG on one AOI for one hot afternoon hour and prints Tmrt/UTCI
ranges. Run it after any change to the raster build — a stack that is silently wrong
(bad units, misaligned grid) still produces plausible-looking GeoTIFFs.

`env_setup.sh` discovers conda from PATH, then `$CONDA_EXE`, then common install roots;
override with `$SHADE_CONDA` / `$SHADE_ENV_NAME`. Do not hardcode interpreter paths.

## Architecture

Pipeline, in dependency order:

```
fetch_boston_open_data.sh   → data/{boston,canopy,heat,landcover,weather}/   (public sources)
make_weather_scenarios.py   → data/weather/scenarios/*.epw                   (baseline + 3 morphed)
build_aoi.py                → data/aoi/<name>/*.tif + aoi.json               (per-AOI stack)
smoke_test_solweig.py       → runs/<run>/                                    (SOLWEIG outputs + cache)
summarise_aois.py           → data/aoi/summary.csv                           (profiles all built AOIs)
```

`build_aoi.py` is where nearly all the domain logic lives. It pulls from live ArcGIS
ImageServers (Boston Nearmap DSM, USGS 3DEP, four city heat models) plus the local
land-cover raster and tree-crown inventory, and resamples everything onto one shared grid.

### The grid contract

Every raster in an AOI is written on the **same 1 m grid in EPSG:26986** (NAD83 / MA State
Plane Mainland, metres), origin `from_origin(minx, maxy, res, res)`, bbox snapped to the
resolution. SOLWEIG's shadow geometry requires metric x/y. Anything new that joins the
stack must land on that exact grid, or shadows and the rasters they fall on will disagree
without erroring.

### Unit and CRS traps

These are the errors most likely to be introduced, and none of them fail loudly:

- **Nearmap DSM**: horizontally EPSG:2249 (**feet**), but its *values* are **metres**.
  Verified against 3DEP over paved ground (agree to ~0.3 m).
- **`TreeCentroids2024`**: EPSG:2249 and `Height`/`Radius` in **feet** — both converted via
  `FT_TO_M`. `gpd.read_file(bbox=...)` filters in the *file's* CRS, so the AOI box is
  projected to 2249 before use.
- **Heat rasters**: served in °F. `heat_ta3pm`/`heat_ta3am` get the full `(F-32)*5/9`;
  `heat_uhii` is an intensity *difference*, so it gets `*5/9` with **no 32 offset**.
- **Land cover**: the source uses Boston's own codes; `BOSTON_TO_UMEP` remaps to UMEP
  codes on write. Files on disk are UMEP (1 paved, 2 building, 3 evergreen, 4 deciduous,
  5 grass, 6 bare soil, 7 water). `build_aoi.py` masks against *Boston* codes internally,
  everything downstream reads *UMEP* codes.

### Why the CDSM is synthetic

The Nearmap DSM contains no trees — only ~11 % of land-cover canopy pixels sit >2 m above
terrain in it, so a naive `DSM − DEM` canopy model comes out empty and every shade policy
scores as useless. `build_cdsm()` therefore paints flat-topped discs from the 2024 crown
inventory (real heights and radii), trims them to the land-cover canopy mask, and fills
uncovered canopy pixels at the AOI median height. Correspondingly, `dsm.tif` has canopy
pixels **replaced by bare earth** — SOLWEIG's `dsm` is ground + buildings only, and the
CDSM carries all vegetation. Do not "fix" the DSM by restoring vegetation to it.

DEM and DSM come from different vertical references, so the DEM is shifted by the median
`DSM − DEM` over paved pixels before use. The applied offset is recorded in `aoi.json`
alongside CDSM build stats and source URLs — check it there when a build looks off.

### The caching boundary that governs cost

`solweig.SurfaceData.prepare()` computes sky-view factors and wall geometry — **minutes of
CPU**, cached in `working_dir` and independent of weather. Interventions that change
geometry (trees, canopies) invalidate that cache; interventions that only change albedo or
land cover do not. Any search loop should be designed around that split. 2 m resolution is
a 4× cut in cost per evaluation versus 1 m.

### Config

- `config/aois.json` — 20 AOIs, **15 `train` / 5 `held_out`**. Respect the split; do not
  tune against held-out AOIs.
- `config/interventions.json` — 8 cooling actions. Physical parameters come from Klimaat's
  Appendix A to Boston's own heat study, so policies are scored against the city's
  assumptions. **Unit costs are not Boston figures** — order-of-magnitude numbers from
  other cities, the weakest link in the stack, flagged in the JSON's `cost_caveat`.

Note the pattern in the city's own numbers: albedo changes move *surface* temperature a lot
and *perceived* temperature barely; shade moves perceived temperature. A result that chases
cool pavement is probably optimizing the wrong metric.

## Conventions and gotchas

- **GDAL shim**: each script sets `GDAL_DATA`/`PROJ_LIB` from `sys.executable`'s prefix
  *before* importing rasterio/geopandas, because conda's GDAL data files are not found when
  the interpreter is invoked directly rather than through `conda activate`. New scripts that
  import the geo stack need the same block, in the same position.
- **`data/` and `runs/` are gitignored** (~2.2 GB; individual files exceed GitHub's 100 MB
  limit). The repo is public under MIT. Never commit data — add new sources to
  `fetch_boston_open_data.sh` and document them in `DATA_MANIFEST.md` instead.
- ImageServer requests are tiled at `MAX_PX = 4000` per axis and retried with backoff; the
  services flake under load, so a failed build is often worth simply re-running.
- `landcover_2016_bostoncity.zip` uses Deflate64 and **cannot be opened by Python's
  `zipfile`** — needs 7-Zip. It is superseded by the 2024 GeoTIFF for modelling.
- `data/heat/crb_heat_plan/*.lpk` are metadata only, no pixels. The live ImageServers
  `build_aoi.py` uses are the same model, 2024 vintage, with real values.
- Weather scenarios are a **uniform temperature shift**, not downscaled projections. They
  answer "does this hold up when it gets hotter" and nothing more; say so in any writeup.
