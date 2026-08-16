# SHADE — data and simulation materials

Everything the autoresearch loop in *Project Proposal.docx* needs to run against real
Boston, assembled and checked. SOLWEIG (`UMEP-dev/solweig`) is the simulator.

**Status:** all sources downloaded and validated; all 20 AOI raster stacks built (386 MB)
and profiled in `data/aoi/summary.csv`; the four climate scenarios generated.

```
shade/
├── config/
│   ├── aois.json              20 study areas, split stratified on heat
│   └── interventions.json     cooling actions: physics + unit costs
├── data/                      ~2.0 GB, see inventory below
├── scripts/
│   ├── env_setup.sh           conda env `shade` (py3.12 + geo stack + solweig)
│   ├── fetch_boston_open_data.sh   re-runnable bulk download
│   ├── build_aoi.py           → SOLWEIG-ready raster stack for one AOI
│   ├── summarise_aois.py      → data/aoi/summary.csv, per-AOI profile
│   ├── make_weather_scenarios.py   → EPW files per climate scenario
│   └── smoke_test_solweig.py  end-to-end check
└── DATA_MANIFEST.md
```

## Quickstart

```bash
bash scripts/env_setup.sh                    # once (already done on this machine)
PY=~/anaconda3/envs/shade/python.exe

bash scripts/fetch_boston_open_data.sh       # idempotent; skips what exists
$PY scripts/make_weather_scenarios.py
$PY scripts/build_aoi.py --list
$PY scripts/build_aoi.py --all               # 20 AOIs at the 2 m default, ~4 min
$PY scripts/summarise_aois.py
$PY scripts/smoke_test_solweig.py --aoi dudley_square  # GPU is disabled by default; see §8
```

---

## 1. What SOLWEIG needs, and where each input comes from

SOLWEIG requires a DSM plus a location and weather; CDSM, DEM and land cover are
optional but all materially change the answer, so all five are built.

| SOLWEIG input | Source | Native res / CRS | Notes |
|---|---|---|---|
| `dsm` ground + buildings | [`dsm_geo_nearmap_2023` ImageServer](https://gisportal.boston.gov/image/rest/services/dsm_geo_nearmap_2023/ImageServer) | 0.15 m, EPSG:2249 | City-hosted photogrammetric surface model. **Values are metres** even though the horizontal CRS is feet — verified against 3DEP over paved ground (they agree to 0.29 m). |
| `dem` bare earth | [USGS 3DEP `3DEPElevation` ImageServer](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer) | 1 m, metres | Reprojected on request; `build_aoi.py` shifts it onto the DSM's vertical reference using the median offset over paved pixels. |
| `cdsm` canopy heights | `TreeCentroids2024.geojson` (Canopy Change Assessment) | points, EPSG:2249 | One record per detected crown with `Height` and `Radius` **in feet**. |
| `land_cover` | `landcover_2024_boston.tif` (Canopy Change Assessment) | 0.5 ft, EPSG:2249 | 7 classes, remapped to UMEP codes. |
| weather | Boston Logan TMYx 2011–2025 EPW | hourly | `solweig.Weather.from_epw()` reads it directly. |

### The one non-obvious finding

The Nearmap DSM **does not contain trees**. Only ~11 % of land-cover canopy pixels sit
more than 2 m above terrain in it, so a naive `DSM − DEM` canopy height model comes out
empty and every shade policy would score as useless. `build_aoi.py` therefore builds the
CDSM from the 2024 crown inventory instead — flat-topped discs at each crown's height and
radius, trimmed to the land-cover canopy mask, with uncovered canopy pixels filled at the
AOI median. For Dudley Square that is 3,543 real crowns covering 85 % of the canopy area,
median height 13.9 m.

Building heights from the same stack come out at median 9.0 m, p95 18.6 m, max 39.2 m for
Dudley Square — the right shape for Roxbury, which is the check that the units are right.

---

## 2. Study areas — `config/aois.json`

1 km × 1 km windows centred on the 20 **Boston Main Streets districts**. These are the
exact unit the Climate Action Plan's *Cool Main Streets* goal names, and the proposal's
target is the process for choosing among them.

- **held out (5):** Mission Hill, Fields Corner, East Boston, Centre/South, West Roxbury
- **train (15):** the rest

The split is **stratified on the heat gradient**, not chosen by hand: districts are sorted
by mean UHII and every 4th is held out, with the hottest (Chinatown, 5.87 °C) and coolest
(Mattapan, 1.32 °C) kept in training. Held-out spans UHII 1.60–4.43 °C and canopy
12.2–38.4 %, nested inside training's 1.32–5.87 °C and 8.4–32.0 %. So it tests
interpolation across the range rather than extrapolation past its edge. The one exception:
Centre/South at 38.4 % canopy is greener than anything in training, so a policy tuned to
scarce canopy is genuinely being extrapolated there — worth watching in the results.

`data/aoi/summary.csv` profiles all 20: land-cover shares, canopy and building heights,
the four heat metrics, and apportioned population with vulnerable-group percentages. That
is both the context a policy prompt should see and the denominator the auditor needs.

Build all 20 with `--all` (~4 min total), then `python scripts/summarise_aois.py`.

**Resolution convention.** The default is **2 m**, written to `data/aoi/<name>/`. Any
other pixel size goes to `data/aoi/<name>_<res>m/`. 2 m is used for search and final
scoring alike; 1 m is a spot-check only — section 8 has the measured cost and the reason
not to compare across resolutions.

Each build writes `dsm/dem/cdsm/landcover/dsm_raw` plus the four city heat rasters on one
grid in **EPSG:26986** (metres — SOLWEIG's shadow geometry needs a metric CRS), and an
`aoi.json` recording bbox, the vertical alignment offset, CDSM build statistics and every
source URL.

---

## 3. Climate scenarios — `data/weather/scenarios/`

| Scenario | Definition |
|---|---|
| `baseline` | Boston Logan TMYx 2011–2025, unmodified. Hottest day in it: **07-27**, daily mean 29.5 °C. |
| `warm_2c` | Dry-bulb +2.0 °C, dew point held (RH falls) — roughly 2050s. |
| `warm_4c` | Dry-bulb +4.0 °C — roughly 2070s, high emissions. |
| `humid_warm_2c` | +2.0 °C at constant RH — harsher for heat stress than warming alone. |

Deltas follow the Boston Research Advisory Group projections used by Climate Ready Boston
(+3–5 °F mid-century, +4–10 °F late century). **This is a uniform shift, not a downscaled
projection** — it answers "does this policy still hold when it gets hotter", which is what
the auditor needs, and nothing more. Say so in the writeup.

Cross-scenario robustness is the other axis the proposal asks for: score every policy on
{AOI × scenario} and keep the Pareto front over the mean *and* the worst case.

---

## 4. Scoring inputs (the objective vector)

The proposal lists population-weighted heat reduction, access to relief, equity of access,
co-benefits and cost efficiency. Each has a real dataset behind it:

| Objective | Dataset | Path |
|---|---|---|
| Perceived heat reduction | SOLWEIG Tmrt / UTCI output | model output |
| Population weighting | Climate Ready Boston Social Vulnerability — 180 tracts with `POP100_RE`, `OlderAdult`, `TotChild`, `POC2`, `LEP`, `Low_to_No`, `TotDis`, `MedIllnes` | `data/heat/climate_ready_social_vulnerability.geojson` |
| Equity of burden | Urban Forest Plan priority zones: EJ tracts, low-canopy tracts, **HOLC redlining boundaries**, heat-event hours | `data/heat/urban_forest_priority_*.geojson` |
| Independent heat check | City heat model 2024: 3 PM air temp, 3 AM air temp, heat-event hours, UHII | fetched per-AOI by `build_aoi.py` |
| Access to relief | Community centers, pools, libraries, open space | `data/boston/` |
| Pedestrian exposure | Sidewalk centerlines, SAM street segments | `data/boston/` |
| Existing canopy / plantable space | BPRD trees (~150 k), land cover, canopy change 2014→2019→2024 | `data/canopy/` |
| Cost efficiency | `config/interventions.json` | unit costs — **weakest link, see below** |

The city heat rasters matter for a second reason: they are an *independent* check on
SOLWEIG. If a policy improves Tmrt but the AOI's UHII and heat-event-hours context says it
targeted an already-cool block, the auditor should catch that.

---

## 5. Interventions — `config/interventions.json`

Physical parameters come from **Klimaat Consulting's Appendix A** to Boston's own Heat
Resilience Study (`data/heat/Appendix2_NeighborhoodClimateSimulationModeling.pdf`), so
policies are scored against the assumptions the city planned with:

| Action | Physics | Boston's reported effect |
|---|---|---|
| High-SRI road coating | albedo 0.12 → 0.45 | surface 104 °F → 93 °F; perceived only 90 → 88.6 °F |
| Cool roof | albedo 0.08 → 0.50 | — |
| Green roof / depave to grass | albedo 0.25, LAI 2.88 | — |
| Street trees (small/medium) | crown h 5 m, transmissivity 0.08 | surface 105 °F → 90 °F; **perceived 90 → 85 °F** |
| Shade canopy | h 3 m, solar transmission 0.5 | — |
| Solar canopy (PV) | h 3.5 m, transmission 0.0 | — |

Note the pattern in the city's own numbers: albedo moves *surface* temperature a lot and
*perceived* temperature barely; shade moves perceived temperature. A policy that chases
cool pavement will look good on the wrong metric — a useful trap for the auditor to have.

**Costs are the weakest numbers in the stack.** They are public order-of-magnitude figures
from other cities' programmes (Phoenix/Raleigh cool pavement at ~$5–14/sq yd applied,
shade sails at ~$12–35/sq ft installed), not Boston capital-budget figures. Every cost
carries its source in the JSON. Swap them before presenting any result as a recommendation.

---

## 6. Data inventory

### `data/aoi/` — built per study area (~5 MB per AOI at 2 m, ~20 MB at 1 m)
`dsm.tif` `dem.tif` `cdsm.tif` `landcover.tif` `dsm_raw.tif` `heat_ta3pm.tif`
`heat_ta3am.tif` `heat_hours.tif` `heat_uhii.tif` `aoi.json`

### `data/canopy/` (1.8 GB) — [Canopy Change Assessment](https://data.boston.gov/dataset/tree-canopy-change-assessment)
| File | Size | Use |
|---|---|---|
| `2019-2024Data/landcover_2024_boston.tif` | 389 MB | **land-cover input**, 0.5 ft, 7 classes |
| `2019-2024Data/TreeCentroids2024.geojson` | 92 MB | **CDSM input** — crown height + radius (feet) |
| `canopy_change_2019_2024.zip` | 988 MB | also holds `TreeTops2024` (crown polygons, 2.4 GB unpacked), `ForestPatches2024`, and land/tree metrics by block group, tract, parcel, neighbourhood, ward |
| `canopy_change_2014_2019.zip` | 259 MB | 2019 land cover + `CT19_Heat` / `HEX19_Heat` (extracted) — canopy-vs-heat by tract |
| `bprd_trees.geojson` / `.csv` | 31 / 12 MB | ~150 k park and street trees: species, DBH, address, planting date |

### `data/heat/`
| File | Use |
|---|---|
| `climate_ready_social_vulnerability.geojson` | 180 tracts × 7 vulnerable-population counts + total population |
| `urban_forest_priority_{zones,ej_tracts,low_canopy_tracts,holc_redlining,heat_event_hours}.geojson` | the city's own priority logic — a strong baseline policy to beat |
| `Appendix2_NeighborhoodClimateSimulationModeling.pdf` | Klimaat methodology + Appendix A surface specs |
| `crb_heat_plan/*.lpk` | ArcGIS layer packages from the proposal's Drive folder. **Metadata only, no pixels** — they point at hosted tile services. The live ImageServers used by `build_aoi.py` are the same model, 2024 vintage, with real values. |

### `data/boston/`
Neighborhoods, Main Streets districts, SAM street segments, sidewalk centerlines, open
space, building footprints with roof breaks (`GRND_ELEV_2010`, `ROOF_ELEV_2010`,
`BLDG_HGT_2010` — a fallback DSM source), community centers, pools, libraries.

### `data/landcover/`
`landcover_2016_bostoncity.zip` (140 MB) — the older 1 m ERDAS `.img`. Kept for the
2016→2024 comparison. **Needs 7-Zip to unpack**: it uses Deflate64, which Python's
`zipfile` cannot read. Superseded by the 2024 GeoTIFF for modelling.

### `data/weather/`
Boston Logan TMYx 2011–2025 and TMY3 EPW, plus the four generated scenarios.

---

## 7. Known gaps and judgement calls

1. **Costs are not Boston's.** Flagged above and in the JSON. Biggest single threat to the
   cost-efficiency objective meaning anything.
2. **CDSM is synthetic in shape.** Real crowns, real heights and radii, but flat-topped
   discs. Fine for shadow geometry, coarse for radiation through the canopy. The
   `TreeTops2024` crown polygons (2.4 GB) would improve this if it proves to matter.
3. **DSM/land-cover vintages differ** (2023 imagery, 2024 land cover, 2021 3DEP). Sub-metre
   registration noise; irrelevant at 1 m.
4. **Uniform warming, not downscaled projections.** See §3.
5. **`data/lidar/` is empty on purpose.** 3DEP point clouds for Boston are at
   `s3://usgs-lidar-public/MA_CentralEastern_1_2021/` (EPT, 187 G points) if a true
   LiDAR-derived CDSM ever becomes necessary. It should not be, given the crown inventory.
6. **Census ACS block-group data now needs a free API key.** Not fetched; the Climate Ready
   Boston vulnerability layer covers the same ground with the city's own definitions.
7. **Nearmap-derived DSM licensing.** Served publicly by the city, but it is a commercial
   product underneath. Fine for coursework; check before publishing derived rasters.
8. **Wicked Hot Boston (2019 NOAA/CAPA traverse campaign)** was not pulled — the 2024 city
   model supersedes it. Available from the Museum of Science if a ground-truth comparison
   is wanted.

---

## 8. Runtime, and the GPU trap

### Disable the GPU. This is not optional on a laptop.

```python
solweig.disable_gpu()   # BEFORE any other solweig call
```

SOLWEIG sizes its SVF tiles against the GPU memory budget. This machine's integrated
GPU reports **0.1 GiB of dedicated VRAM**, giving a 134 MB budget and capping
`max_tile_side` at **528 px**. The shadow buffer it needs is `max_height / tan(3 deg)` --
748 m for a 39 m building, so **748 px at 1 m resolution**. Since the buffer alone
exceeds the tile cap, `core_tile_size` collapses to 1 and the tiler emits **one tile per
pixel**: 1,002,001 tiles of 1497x1497 each, about 2.2e12 tile-pixels. It never finishes.
A first attempt sat for 50 minutes without writing a byte.

`disable_gpu()` moves the budget to RAM, lifting `max_tile_side` to 3429 px and removing
tiling entirely for a 1 km2 AOI. `SOLWEIG_MAX_TILE_SIDE` does **not** help -- it only caps
downward. Passing `tile_size=` explicitly does not help either; the validator clamps it
against the same cap. On a machine with a real discrete GPU, leave the GPU on and re-check.

The collapse threshold is `2 x ceil(748 / res) < 528`, i.e. **res > 2.8 m**. That is why
4 m appeared to work while 1 m and 2 m both hung -- the cliff is discontinuous, and
coarsening the grid was treating the symptom.

### Measured cost

Dudley Square, 1 km2, 4 timesteps, GPU disabled, 4-core i7-1065G7:

| res | pixels | `prepare` (SVF) | `calculate` per step | cache | Tmrt mean | Tmrt max |
|---|---|---|---|---|---|---|
| 4 m | 63,001 | 9.3 s | 0.83 s | 10 MB | 49.0 C | 62.4 C |
| 2 m | 251,001 | 21.1 s | 2.13 s | 40 MB | 48.2 C | 62.5 C |
| 1 m | 1,002,001 | 128.8 s | 11.96 s | 157 MB | 47.8 C | 63.8 C |

Reproduce with `python scripts/bench_resolution.py --aoi dudley_square --res 4,2,1`.

**Halving the pixel size does not cost a constant factor** -- it gets more expensive the
finer you go:

| step | prepare | calc | cache | pixels |
|---|---|---|---|---|
| 4 m -> 2 m | x2.3 | x2.6 | x4.0 | x4.0 |
| 2 m -> 1 m | x6.1 | x5.6 | x3.9 | x4.0 |

Three scalings are superimposed. Pixel count is quadratic. Shadow casting marches in
pixel-sized steps out to a fixed metre reach, so it adds another `1/res`, making the
compute asymptotically **cubic**. Memory stays quadratic -- and the cache column confirms
it, holding at x4.0 throughout. At 4 m the grid is small enough that fixed overheads
dominate and the observed factor is only 2.3x; by 1 m the cubic term has taken over at
6.1x. Extrapolating, 0.5 m would cost roughly 8x again: ~17 min of `prepare` per AOI.

### What it costs per policy evaluation

One evaluation = AOIs x scenarios x timesteps, serial:

| setup | 1 m | 2 m | 4 m |
|---|---|---|---|
| full: 20 AOI x 4 scenarios x 4 steps | 1.8 h | 18 min | 8 min |
| train only: 15 AOI x 2 scenarios x 3 steps | 50 min | 8 min | 4 min |
| search subsample: 6 AOI x 2 scenarios x 3 steps | 20 min | 3 min | 1 min |

**Recommendation: 2 m throughout, for search and final scoring alike.** At 2 m with a
6-AOI rotating subsample a policy costs ~3 minutes, so a few hundred evaluations fit in an
overnight run, and the full 20-AOI x 4-scenario final score is 18 minutes. 1 m on the full
grid is an hour and three quarters per policy -- worth spending once on a survivor or two
to confirm the ranking is not a grid artefact, but not as a scoring pass.

Two further levers before reaching for more compute:

- **AOIs are independent.** Four cores, so run 3-4 AOIs in parallel for close to 3x
  throughput. This is the cheapest speedup available and it is not yet implemented.
- **`prepare` is cached per AOI geometry and is weather-independent.** Albedo and
  land-cover interventions (cool roofs, reflective pavement, depaving) reuse the cached
  SVF entirely; only trees and canopies invalidate it. At 2 m that is the difference
  between 21 s and 0 s per AOI. Ordering the search to batch geometry-preserving
  candidates together is worth real time.

### One caveat on coarsening

Mean Tmrt drifts warm as the grid coarsens: 47.8 C at 1 m, 49.0 C at 4 m, because narrow
shaded strips get averaged away. The bias is systematic and in one direction, so
*comparisons between policies at a fixed resolution* stay sound -- which is all the search
and the final ranking need. But absolute Tmrt values are biased, and cross-resolution
comparison is not sound: never score one policy at 2 m against another at 1 m. Since
everything runs at 2 m, the trap only opens if someone spot-checks at 1 m and then reads
the two numbers side by side.

Unrelated but noisy: SOLWEIG logs a Unicode check mark that crashes the Windows cp1252
console encoder. Harmless, and silenced by `PYTHONIOENCODING=utf-8`.
