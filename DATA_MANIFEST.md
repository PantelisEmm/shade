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
$PY scripts/smoke_test_solweig.py --aoi dudley_square  # GPU is disabled by default; see §9
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
scoring alike; 1 m is a spot-check only — section 9 has the measured cost and the reason
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
| Pedestrian exposure | Sidewalk centerlines, SAM street segments | `data/boston/` — see §6 |
| Siting constraints | Fire hydrants, streetlight locations, BLC historic districts | `data/boston/` — see §6 |
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

### What an intervention is in year N — `config/lifecycle.json`

The table above describes a finished asset. A planted tree is not that on day one, and a
shade sail is not that in year 15. Left alone, the scorer gives every action its full effect
immediately, which flatters shade against albedo — albedo really is at full strength on day
one.

`--horizon-years N` on `score_policy.py` simulates what is standing N years after the build:
a tree gets the crown the growth curve gives it at that age, and anything past its service
life is absent from the geometry while still counted as spent. It adds two figures to the
objective vector — `expected_relief_c`, the simulated relief with expected mortality applied,
and `plan_survival`, the share of the plan's shade still standing. Without the flag the
behaviour is exactly as before, so earlier scores stay comparable.

**The growth curve is built from two real datasets** by `scripts/build_growth_curve.py`:

| | |
|---|---|
| Allometry | [Urban Tree Database](https://www.fs.usda.gov/rds/archive/catalog/RDS-2016-0005) (McPherson, van Doorn & Peper 2016, USDA FS RDS-2016-0005 / PSW-GTR-253) — equations fitted to 14 000 measured urban trees. Region `NoEast`, reference city Queens NY. Age → dbh → crown diameter and height. UTD age is *years since planting*, so horizon years map straight onto it. |
| Species mix | Boston's own street tree inventory, `data/canopy/bprd_trees.csv`. 51 914 trees with a species; **86.7 % match** the NoEast equations exactly (60 %) or by genus (27 %), and the rest are dropped and the weights renormalised. |
| Mortality | Roman & Scatena (2011), meta-analysis of 16 studies: annual street tree mortality **3.5–5.1 %**, half-life 13–20 years, mean life expectancy 19–28 years. The midpoint 4.3 % is applied uniformly. |

The resulting Boston street tree, written to `data/canopy/derived/boston_growth_curve.json`:

| years since planting | 0 | 5 | 10 | 15 | 20 | 30 | 40 |
|---|---|---|---|---|---|---|---|
| crown radius, m | 0.6 | 1.9 | 2.8 | 3.5 | 4.1 | 5.1 | 5.9 |
| height, m | 3.1 | 5.8 | 7.5 | 8.9 | 10.1 | 12.0 | 13.7 |
| expected survival | 100 % | 80 % | 64 % | 52 % | 42 % | 27 % | 17 % |

Two things fall out of that table which the interventions config gets wrong on its own.
`tree_medium`'s 2.5 m crown radius arrives at about **year 8**, but its 5 m height arrives at
about **year 4** — the configured pair is not a tree of any single age, and height is the half
that sets shadow length. And the configured 40-year life sits against a meta-analytic mean
life expectancy of 19–28 years; both are kept, with 40 read as the asset design life and the
mortality rate carrying the attrition.

Scored on `dudley_square`, one hot afternoon hour, $500 k, the baseline policy:

| horizon | as configured | 2 yr | 5 yr | 10 yr | 20 yr | 30 yr |
|---|---|---|---|---|---|---|
| `heat_relief_c` | 0.057 | 0.023 | 0.026 | 0.067 | 0.109 | 0.132 |
| `expected_relief_c` | — | 0.022 | 0.022 | 0.047 | 0.045 | 0.035 |
| `plan_survival` | — | 96 % | 86 % | 70 % | 42 % | 27 % |

The policy delivers under half its headline relief for its first five years, does not pass
the as-configured number until around year 8, and — once mortality is counted — peaks around
year 10–20 and declines. The shade canopies are gone by year 12, which is why the year-20
column loses 157 placements. `known_tensions` in `config/lifecycle.json` lists what this
still does not capture: front-loaded establishment mortality, albedo decay with soiling, and
replacement.

**Costs are the weakest numbers in the stack.** They are public order-of-magnitude figures
from other cities' programmes (Phoenix/Raleigh cool pavement at ~$5–14/sq yd applied,
shade sails at ~$12–35/sq ft installed), not Boston capital-budget figures. Every cost
carries its source in the JSON. Swap them before presenting any result as a recommendation.

---

## 6. Siting — where an intervention may physically go — `config/siting.json`

`config/interventions.json` says what land cover an action applies to. It cannot say
whether the pixel is the travel lane: Boston's land cover codes the roadway, the sidewalk,
a plaza and a parking lot all as **1, paved**. Left at that, the hottest paved pixels beside
a street centreline are the middle of the road, and a greedy policy plants trees there.

`scripts/siting.py` turns seven city layers into boolean masks on the AOI grid:

| Layer | Path | What it decides |
|---|---|---|
| Sidewalk Centerline — `SWALK-CL` 54 864, `PWALK-CL` 37 023, `CWALK-CL` 11 223, `CWALK-CL-UM` 6 921 | `data/boston/sidewalk_centerline_geojson.zip` | the pedestrian corridor, and which of it is a crosswalk |
| SAM street segments (19 437) | `data/boston/street_segments_sam.geojson` | the roadbed; and intersections, as nodes where ≥ 3 segments meet (10 550) |
| Fire hydrants, BWSC (13 747) | `data/boston/fire_hydrants.geojson` | 10 ft planting setback |
| Streetlight locations (74 065) | `data/boston/streetlight_locations.csv` | 10 ft planting setback. A legacy layer, last refreshed 2019 |
| BLC historic districts — 11 design-review of 15 | `data/boston/blc_historic_districts.geojson` | roofs and awnings that need a Landmarks Commission hearing |
| Sidewalk Inventory — 23 516 polygons with a surveyed `SWK_WIDTH` | `data/boston/sidewalk_inventory.geojson` | the 6 ft planting width rule |
| City Land Audit — 2 940 parcels | `data/boston/city_land_audit.geojson` | which ground and roofs the city actually owns |

### Roadbed and sidewalk are separated by a nearest-centreline split

The sidewalk layer is a **centreline with no width attribute**, so a buffer cannot be sized
from it. Instead every ground pixel is assigned to whichever centreline is nearer — a SAM
street centreline or a sidewalk centreline — and the paved pixels that fall on the street
side are the roadbed. Nothing may be built on them. The pedestrian corridor is a fixed 3 m
buffer either side of a walkway centreline with the roadbed removed, plus a 2.5 m buffer
around crosswalks: people stand on a crosswalk, so relief there counts toward the score,
but nothing may be built on it.

That corridor is also **where every population-weighted objective is measured**. It replaced
an 8 m buffer around street centrelines, which had no way to exclude the carriageway, so
scores produced before the siting rules landed are not comparable with scores produced after.

### What is enforced

`config/siting.json` lists the rule set per action, and `score_policy.audit()` rejects a
solution that breaks one before any SOLWEIG time is spent. The violation string names the
rule and the pixel count, because the next prompt reads it.

| Action | May not be on |
|---|---|
| `tree_small`, `tree_medium` | roadbed, crosswalk, a sidewalk narrower than 6 ft where that is known or imputable, within 3.05 m of a hydrant or light pole, within 6.1 m of an intersection, under an existing crown; must be in the pedestrian corridor |
| `shade_canopy`, `solar_canopy` | roadbed, crosswalk, historic district; must be in the pedestrian corridor |
| `cool_roof`, `green_roof` | historic district |
| `grass_conversion` | roadbed, crosswalk |
| `light_road` | — (a road coating belongs on the road) |

Setbacks come from the city's own planting rules — 10 ft from light poles, driveways and
hydrants, 10–20 ft from an intersection — taking the conservative end of the intersection
range. Sources are cited per rule in the JSON.

The masks are metric and read the AOI's own pixel size, so the same rule holds at any
resolution. On `dudley_square` the shares barely move between 2 m and 1 m, which is the
check that they are rules and not grid artefacts:

| | 2 m | 1 m |
|---|---|---|
| pedestrian corridor | 26.5 % | 24.1 % |
| roadbed | 11.1 % | 11.8 % |
| within a planting setback | 6.7 % | 5.8 % |
| in a design-review district | 10.1 % | 10.1 % |
| on a sidewalk under 6 ft (surveyed or imputed) | 2.5 % | 2.3 % |
| plantable | 11.7 % | 10.8 % |

A one-off derived cache (`data/boston/derived/siting_layers.gpkg`, built automatically,
rebuilt with `python scripts/siting.py --rebuild`) reprojects the five layers into one
indexed GeoPackage; without it each AOI would rescan a 70 MB GeoJSON. Per-AOI mask cost is
about a second, and `score.json` records the mask counts and which layers were available.

### Sidewalk width is measured where the city measured it, imputed close by

The centreline layer has no width, but the **Sidewalk Inventory** does: a 2014 Public Works
survey of 23 516 sidewalk polygons carrying `SWK_WIDTH` in feet. Median 7 ft, and **18 % of
surveyed sidewalk is under the 6 ft planting threshold** — a rule that bites, not a
formality.

**The threshold is 6 ft exactly, 1.8288 m, and that matters.** 6.0 ft is the modal width in
the survey: 3 930 polygons, 16.7 % of it, sit exactly on the standard. A threshold rounded
up to 1.83 m calls every one of them narrow and takes the rule from 18 % of surveyed
sidewalk to 35 %. `width_tolerance_m` in `config/siting.json` keeps float noise off that
boundary.

**Imputation.** The survey reaches about a quarter of the walkway corridor. Sidewalk width
is strongly autocorrelated along a block, so an unsurveyed walkway pixel takes the width of
the nearest surveyed one — within 25 m and no further. That lifts coverage in
`dudley_square` from 24 % measured to 90 % judged, and both figures go into `score.json` as
`measured_width_coverage_of_walkway` and `imputed_width_coverage_of_walkway`.

The 25 m cap is not a guess. `python scripts/siting.py --validate-width` holds out 20 % of
the surveyed polygons and imputes them from the rest:

| distance to nearest survey | n | MAE | accuracy on the 6 ft rule | wrongly forbids |
|---|---|---|---|---|
| 0–10 m | 501 | 0.22 m | 84.6 % | 12.6 % |
| 10–25 m | 2 399 | 0.37 m | **90.3 %** | **5.6 %** |
| 25–50 m | 1 121 | 0.65 m | 81.2 % | 11.8 % |
| > 50 m | 648 | 0.50 m | 77.6 % | 14.3 % |

The comparison that decides it is not MAE. Assuming every unsurveyed sidewalk is wide enough
is already **81.6 %** accurate, because most sidewalks are. Imputation only beats that inside
about 25 m; past 50 m it is worse than assuming wide, and would forbid planting on evidence
weaker than no evidence. Taking a median of the 3 or 5 nearest instead of the single nearest
traded recall for precision without moving accuracy.

Inside the cap the errors are asymmetric in the useful direction — a wrongly forbidden pixel
costs one planting site out of many, a wrongly permitted one is a plan that cannot be built —
so **imputed width is allowed to forbid**, and every violation string says how many of its
pixels rested on an inferred width rather than a surveyed one. The hold-out is also
conservative relative to how the rule is applied: it measures polygon-centroid to
polygon-centroid distance, while the pipeline measures pixel to nearest surveyed pixel, which
is shorter.

Beyond the cap, `ctx.sidewalk_width_m` still falls back to the thickness of the surrounding
non-roadbed ground. That fallback reads the whole open strip wherever a front yard or plaza
adjoins, so it over-estimates, and it forbids nothing.

### Ownership is reported, never enforced

Every building pixel is somebody's roof, and the **City Land Audit** says whose: 2 940
parcels the city holds, with the department in care and custody. Forbidding a cool roof on
a private building would be wrong — that is what a subsidy programme is — so `ctx.city_owned`
is a mask a policy may use and `score.json` records `placements_on_city_land` per AOI. The
baseline policy puts 31 % of its placements on city land in `dudley_square`.

### What is still not enforced, and why

Carried as `not_modelled` in `config/siting.json` and copied into every `score.json`:

- **Clear path of travel and tree pit area.** The inventory gives one width per polygon, so
  the width rule is testable but the 5 ft clear path and the 24 sq ft pit — both about where
  the pit sits *within* that width — are not. A 24 sq ft pit is also larger than a 1 m pixel
  and smaller than a 2 m one.
- **Sidewalk width more than 25 m from any surveyed polygon.** Left unjudged on purpose; see
  the hold-out table above.
- **Driveways and curb cuts.** The 10 ft setback applies and no city layer was found; the
  inventory's `curb_type` records the kerb material, not aprons.
- **Underground utilities and overhead wires.** Dig Safe, BWSC water and sewer, and the
  wires that in the field decide whether a small or a medium tree goes in. Nothing here
  sees them, so no policy has any modelled reason to prefer `tree_small`.
- **Permitting.** A Public Improvement Commission grant for anything in the public way, and
  a MGL c.87 hearing before a public shade tree comes out. Neither is spatial.

---

## 7. Data inventory

### `data/aoi/` — built per study area (~5 MB per AOI at 2 m, ~20 MB at 1 m)
`dsm.tif` `dem.tif` `cdsm.tif` `landcover.tif` `dsm_raw.tif` `heat_ta3pm.tif`
`heat_ta3am.tif` `heat_hours.tif` `heat_uhii.tif` `aoi.json`

### `data/canopy/` (1.8 GB) — [Canopy Change Assessment](https://data.boston.gov/dataset/tree-canopy-change-assessment)
Also `urban_tree_database.zip` (1.1 MB, USDA FS RDS-2016-0005 — not a Boston layer) and the
generated `derived/boston_growth_curve.json`; see §5.
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
`BLDG_HGT_2010` — a fallback DSM source), community centers, pools, libraries, fire
hydrants, streetlight locations, BLC historic districts, the 2014 sidewalk inventory with
surveyed widths, and the city land audit.

`data/boston/derived/siting_layers.gpkg` is generated, not downloaded: one indexed
GeoPackage holding the walkways, crossings, streets, intersection nodes, obstruction points
and design-review districts that §6 uses. Rebuild with `python scripts/siting.py --rebuild`.

### `data/landcover/`
`landcover_2016_bostoncity.zip` (140 MB) — the older 1 m ERDAS `.img`. Kept for the
2016→2024 comparison. **Needs 7-Zip to unpack**: it uses Deflate64, which Python's
`zipfile` cannot read. Superseded by the 2024 GeoTIFF for modelling.

### `data/weather/`
Boston Logan TMYx 2011–2025 and TMY3 EPW, plus the four generated scenarios.

---

## 8. Known gaps and judgement calls

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
8. **Growth and mortality are regional, not local.** The allometry is fitted on Queens,
   NY and the mortality rate is a national meta-analysis; neither is a Boston measurement.
   Boston's own inventory has `date_plant` and `dbh` on ~150 k trees, so a local refit is
   possible and would be the obvious improvement.
9. **Wicked Hot Boston (2019 NOAA/CAPA traverse campaign)** was not pulled — the 2024 city
   model supersedes it. Available from the Museum of Science if a ground-truth comparison
   is wanted.

---

## 9. Runtime, and the GPU trap

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
