"""Regression checks for the GUI-facing autoresearch archive contract."""
from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
GUI_SCRIPTS = ROOT / "gui" / "scripts"
for directory in (SCRIPTS, GUI_SCRIPTS):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from evolve import export_candidate_artifacts, policy_metadata, refresh_archive, save_candidate  # noqa: E402
from import_git_results import normalize_legacy_canopy_landcover, packed_mask  # noqa: E402
from policy_api import Placement  # noqa: E402
from precompute_autoresearch_1m import normalize_layout_to_results  # noqa: E402


class AutoresearchArchiveTests(unittest.TestCase):
    def test_archived_layout_is_normalized_to_the_simulated_footprint(self):
        requested = np.array([[True, True], [False, False]])
        simulated = np.array([[True, False], [False, False]])
        empty = np.zeros((2, 2), dtype=bool)
        layout = {
            "interventions": {
                "shade_canopy": packed_mask(requested),
                **{
                    key: packed_mask(empty)
                    for key in (
                        "reflective_pavement", "cool_roof", "green_roof",
                        "depaved_pavement", "solar_canopy",
                    )
                },
            },
        }
        result = {
            "shade_canopy_snapshot": packed_mask(simulated),
            "reflective_snapshot": packed_mask(empty),
            "cool_roof_snapshot": packed_mask(empty),
            "green_roof_snapshot": packed_mask(empty),
            "depaved_pavement_snapshot": packed_mask(empty),
            "solar_canopy_snapshot": packed_mask(empty),
        }

        changes = normalize_layout_to_results(layout, [result, result])

        self.assertEqual(changes["shade_canopy"]["removed_pixels"], 1)
        self.assertEqual(layout["interventions"]["shade_canopy"]["data"], result["shade_canopy_snapshot"]["data"])

    def test_legacy_import_only_filters_canopy_landcover(self):
        class Context:
            shape = (2, 2)

            @staticmethod
            def eligible(action):
                self = np.zeros((2, 2), dtype=bool)
                self[0, 0] = True
                return self

        canopy = Placement("shade_canopy", [0, 0], [0, 1])
        tree = Placement("tree_medium", [0, 0], [0, 1])

        normalized, removed = normalize_legacy_canopy_landcover(Context(), [canopy, tree])

        self.assertEqual(removed, {"shade_canopy": 1})
        self.assertEqual(len(normalized[0]), 1)
        self.assertEqual(len(normalized[1]), 2)

    def test_policy_metadata_preserves_multiline_description(self):
        name, description = policy_metadata('''
POLICY_NAME = "Corridor shade"
DESCRIPTION = (
    "Plant the hottest pedestrian corridors, "
    "then use canopies with remaining funds."
)
''')
        self.assertEqual(name, "Corridor shade")
        self.assertEqual(
            description,
            "Plant the hottest pedestrian corridors, then use canopies with remaining funds.",
        )

    def test_archive_exposes_policy_lineage_scores_and_browser_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "evolve_test"
            score_dir = run_dir / "score_gen01_test"
            score_dir.mkdir(parents=True)
            (run_dir / "run.json").write_text(json.dumps({
                "id": "evolve_test",
                "aois": ["chinatown"],
                "resolution_m": 1.0,
            }), encoding="utf-8")
            (score_dir / "score.json").write_text(json.dumps({
                "verdict": "feasible",
                "objectives": {"heat_relief_c": 0.25},
            }), encoding="utf-8")
            np.savez_compressed(
                score_dir / "solution_chinatown.npz",
                **{
                    "0_tree_medium": np.asarray([[10], [20]], dtype="int64"),
                    "1_light_road": np.asarray([[11, 11], [21, 22]], dtype="int64"),
                    "2_shade_canopy": np.asarray([[12], [23]], dtype="int64"),
                },
            )

            layouts, scores = export_candidate_artifacts(
                run_dir, "gen01_test", score_dir, ["chinatown"], 1.0
            )
            save_candidate(run_dir, {
                "id": "gen01_test",
                "generation": 1,
                "parent_id": "gen00_seed",
                "inspiration_ids": [],
                "policy_name": "Test cooling policy",
                "description": "Places a tree, reflective pavement, and overhead shade.",
                "verdict": "feasible",
                "fitness": 0.25,
                "objectives": {"heat_relief_c": 0.25},
                "layout_files": layouts,
                "score_files": scores,
            })
            archive_path = refresh_archive(run_dir, state="complete")
            archive = json.loads(archive_path.read_text(encoding="utf-8"))
            self.assertEqual(archive["schema_version"], 1)
            self.assertEqual(archive["state"], "complete")
            self.assertEqual(archive["iterations"][0]["parent_id"], "gen00_seed")
            self.assertIn("reflective pavement", archive["iterations"][0]["description"])

            layout_path = run_dir / layouts["chinatown"]
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
            self.assertEqual(layout["trees"][0]["size"], "medium")
            reflective = layout["interventions"]["reflective_pavement"]
            self.assertEqual(reflective["count"], 2)
            packed = np.frombuffer(base64.b64decode(reflective["data"]), dtype="uint8")
            mask = np.unpackbits(packed, bitorder="little")[: reflective["width"] * reflective["height"]]
            self.assertTrue(mask[11 * reflective["width"] + 21])
            self.assertTrue(mask[11 * reflective["width"] + 22])


if __name__ == "__main__":
    unittest.main()
