#!/usr/bin/env bash
# Downloads all City-of-Boston / Analyze Boston layers used by SHADE.
# Re-runnable: skips files that already exist. Run from anywhere.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)/data"
mkdir -p "$ROOT"
UA="Mozilla/5.0 (SHADE-research-download)"

get () { # get <dest-relative-path> <url>
  local dest="$ROOT/$1"; local url="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -s "$dest" ]; then echo "SKIP  $1"; return; fi
  echo "GET   $1"
  curl -sSL -A "$UA" --retry 3 --retry-delay 2 -o "$dest.part" "$url" && mv "$dest.part" "$dest" \
    && echo "  ok  $(du -h "$dest" | cut -f1)" || echo "  FAIL $1"
}

## --- boundaries / planning units ---
get boston/neighborhoods.geojson              "https://data.boston.gov/dataset/bf1a7b50-4c72-4637-b0fa-11d632e3aff1/resource/e5849875-a6f6-4c9c-9d8a-5048b0fbd03e/download/boston_neighborhood_boundaries.geojson"
get boston/neighborhoods_census_tracts_2020.geojson "https://data.boston.gov/dataset/5997399b-c665-4600-848f-a2a32834f009/resource/42a271c9-486d-4f9e-adc2-63e4bf47fe3e/download/boston_neighborhood_boundaries_approximated_by_2020_census_tracts.geojson"
get boston/street_segments_sam.geojson        "https://data.boston.gov/dataset/b9b8b634-f28a-410f-9727-b53d0d006308/resource/e850cfd2-2c6e-4af6-9ac4-e03019412d1e/download/boston_street_segments_sam_system.geojson"
get boston/sidewalk_centerline_geojson.zip    "https://data.boston.gov/dataset/67e1944c-b461-4ea6-8669-43969e8974ca/resource/a1720314-dd92-47ac-8bc4-7eaa4cadb77c/download/sidewalk_centerline_geojson.zip"
get boston/open_space.geojson                 "https://data.boston.gov/dataset/66a3324e-066f-4caf-897b-a2b4dcb8bc42/resource/ccc038ce-5602-42d0-b4c6-87f60c116ea3/download/open_space.geojson"

## --- morphology (SOLWEIG DSM inputs) ---
get boston/buildings_roof_breaks_geojson.zip  "https://data.boston.gov/dataset/08fd5249-2d75-42ef-ac23-951f3e0ec259/resource/57026638-b4e8-4dfa-8644-0e2cfe925a46/download/boston_buildings_with_roof_breaks_geojson.zip"

## --- land cover (SOLWEIG land-cover input) ---
get landcover/landcover_2016_bostoncity.zip   "https://data.boston.gov/dataset/a94bbab8-11ff-4361-b91d-0084385f6f76/resource/b79ea366-684e-404c-866d-848cf215b412/download/landcover_2016_bostoncity.zip"

## --- trees / canopy (intervention inventory + CDSM cross-check) ---
get canopy/bprd_trees.geojson                 "https://data.boston.gov/dataset/e4c76e72-dcf1-40a0-b426-97c52214a9fe/resource/2f575489-e721-45ec-865a-e98f10d2ee85/download/bprd_trees.geojson"
get canopy/bprd_trees.csv                     "https://data.boston.gov/dataset/e4c76e72-dcf1-40a0-b426-97c52214a9fe/resource/995cd80f-2489-41bf-b16b-113dba4f2797/download/bprd_trees.csv"
get canopy/bprd_trees_metadata.pdf            "https://data.boston.gov/dataset/e4c76e72-dcf1-40a0-b426-97c52214a9fe/resource/562516f7-8ff2-43a6-bd02-e49f0295c927/download/bprd-trees-metadata.pdf"
get canopy/canopy_change_2019_2024.zip        "https://data.boston.gov/dataset/b619811b-c52e-417c-a9d0-e82c19f89ca3/resource/7645f9fd-c8d8-4f08-9b6d-6cf35ff895a0/download/2019-2024-data.zip"
get canopy/canopy_change_2014_2019.zip        "https://data.boston.gov/dataset/b619811b-c52e-417c-a9d0-e82c19f89ca3/resource/8df4dce6-b575-43f4-90ef-2950f50a2b57/download/2014-2019data.zip"

## --- weather (SOLWEIG forcing) ---
get weather/USA_MA_Boston-Logan.Intl.AP.725090_TMYx.2011-2025.zip "https://www.climate.onebuilding.org/WMO_Region_4_North_and_Central_America/USA_United_States_of_America/MA_Massachusetts/USA_MA_Boston-Logan.Intl.AP.725090_TMYx.2011-2025.zip"

## --- equity / heat priority (scoring inputs) ---
get heat/climate_ready_social_vulnerability.geojson "https://bostonopendata-boston.opendata.arcgis.com/api/download/v1/items/34f2c48b670d4b43a617b1540f20efe3/geojson?layers=0"
get heat/urban_forest_priority_zones.geojson  "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/41bb1f69-18a8-4016-bd82-37267abea881/download/priority_zones.geojson"
get heat/urban_forest_priority_ej_tracts.geojson    "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/37163833-9fc4-4a83-a2ec-7250e4313467/download/priority_zone_indicators_priority_ej_census_tracts.geojson"
get heat/urban_forest_priority_heat_event_hours.geojson "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/b6ed8b78-0778-4689-aeaa-dd640fc8d6cc/download/priority_zone_indicators_priority_heat_event_hours_.geojson"
get heat/urban_forest_priority_holc_redlining.geojson  "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/eda9e38e-04f4-4b64-9a28-a0368a9d9117/download/priority_zone_indicators_priority_holc_boundaries.geojson"
get heat/urban_forest_priority_low_canopy_tracts.geojson "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/53e1312d-aded-42c6-96f0-7f257f3c914d/download/priority_zone_indicators_priority_low_canopy_census_tracts.geojson"
get heat/urban_forest_datadictionary.xlsx     "https://data.boston.gov/dataset/c8c042fb-fa02-4662-a523-593c21bb3b87/resource/58d4715d-29ca-4cb2-be79-1a329c74e0a5/download/datadictionary.xlsx"



## --- cooling resources (access-to-relief scoring) ---
get boston/community_centers.geojson          "https://data.boston.gov/dataset/33f63508-d3d0-4cea-a6bf-94c487ad745e/resource/b3b8525f-af13-413a-a766-e70287df4bb3/download/community_centers.geojson"
get boston/community_center_pools.geojson     "https://data.boston.gov/dataset/321c0d5f-fade-4cd1-be50-4674419fd946/resource/b61ef2fd-1324-4482-8ccd-4228f17dc0d7/download/community_center_pools.geojson"
get boston/public_libraries.geojson           "https://data.boston.gov/dataset/552df2e4-0db0-4fd6-b20f-4535695f17a4/resource/ad99c2c2-bcdd-4764-af15-786b8c8a3556/download/public_libraries.geojson"
get boston/main_streets_districts.geojson     "https://services.arcgis.com/sFnw0xNflSi8J0uh/ArcGIS/rest/services/Main_Streets_District_2019/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=26986&f=geojson"
echo "DONE"
