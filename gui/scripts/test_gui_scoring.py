from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
GUI_SCRIPTS = ROOT / "gui" / "scripts"
for path in (SCRIPTS, GUI_SCRIPTS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from gui_policy import decode_mask, plan  # noqa: E402
from policy_api import Placement, load_context  # noqa: E402
from score_policy import aoi_path, audit  # noqa: E402


def encoded_mask(mask: np.ndarray) -> dict:
    packed = np.packbits(mask.reshape(-1), bitorder="little")
    return {
        "width": mask.shape[1],
        "height": mask.shape[0],
        "count": int(mask.sum()),
        "data": base64.b64encode(packed.tobytes()).decode(),
    }


@contextmanager
def policy_request(value: dict):
    previous = os.environ.get("SHADE_GUI_POLICY_REQUEST")
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "request.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        os.environ["SHADE_GUI_POLICY_REQUEST"] = str(path)
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("SHADE_GUI_POLICY_REQUEST", None)
            else:
                os.environ["SHADE_GUI_POLICY_REQUEST"] = previous


class MinimalContext:
    shape = (3, 4)
    pixel_area_m2 = 1.0
    interventions = {
        action: {"unit": "m2", "cost_usd_per_unit": 1, "applies_to_landcover": [1]}
        for action in ("light_road", "grass_conversion", "shade_canopy", "solar_canopy")
    }

    def eligible(self, _action):
        return np.ones(self.shape, dtype=bool)

    def siting_failures(self, _action, _rows, _cols):
        return 0, {}

    def spec(self, action):
        return self.interventions[action]

    def cost(self, _action, count):
        return float(count)


class GuiScoringTests(unittest.TestCase):
    def test_browser_mask_round_trip_and_count_validation(self):
        expected = np.zeros((3, 4), dtype=bool)
        expected[0, 1] = True
        expected[2, 3] = True
        value = encoded_mask(expected)
        np.testing.assert_array_equal(decode_mask(value, expected.shape, "test"), expected)
        value["count"] = 3
        with self.assertRaisesRegex(ValueError, "submitted count"):
            decode_mask(value, expected.shape, "test")

    def test_gui_policy_translates_trees_and_all_masks(self):
        mask = np.zeros((3, 4), dtype=bool)
        mask[1, 2] = True
        request = {
            "trees": [
                {"x": 1.8, "y": 0.2, "size": "small"},
                {"x": 3.1, "y": 2.9, "size": "medium"},
            ],
            **{key: encoded_mask(mask) for key in (
                "reflective_pavement", "cool_roof", "green_roof",
                "depaved_pavement", "shade_canopy", "solar_canopy",
            )},
        }
        with policy_request(request):
            placements = plan(MinimalContext(), 500_000)
        self.assertEqual(
            [placement.action for placement in placements],
            ["light_road", "cool_roof", "green_roof", "grass_conversion", "shade_canopy",
             "solar_canopy", "tree_small", "tree_medium"],
        )
        self.assertEqual((placements[-2].rows[0], placements[-2].cols[0]), (0, 1))
        self.assertEqual((placements[-1].rows[0], placements[-1].cols[0]), (2, 3))

    def test_audit_allows_ground_treatment_below_shade(self):
        point = np.array([1])
        problems, _ = audit(
            MinimalContext(),
            [Placement("light_road", point, point), Placement("shade_canopy", point, point)],
            100,
        )
        self.assertEqual(problems, [])

    def test_audit_rejects_two_ground_treatments_on_one_pixel(self):
        point = np.array([1])
        problems, _ = audit(
            MinimalContext(),
            [Placement("light_road", point, point), Placement("grass_conversion", point, point)],
            100,
        )
        self.assertTrue(any("ground-layer action" in problem for problem in problems))

    def test_scorer_discovers_standard_one_metre_chinatown_build(self):
        self.assertEqual(aoi_path("chinatown", 1.0), ROOT / "data" / "aoi" / "chinatown")

    @unittest.skipUnless(
        (ROOT / "gui/public/data/chinatown/manifest.json").exists()
        and (ROOT / "data/aoi/chinatown/aoi.json").exists(),
        "requires exported Chinatown GUI layers",
    )
    def test_every_exported_intervention_mask_passes_authoritative_audit(self):
        """Every tool in every exported study area must survive real preflight."""
        configured = json.loads((ROOT / "config/aois.json").read_text())["aois"]
        intervention_menu = json.loads(
            (ROOT / "config/interventions.json").read_text()
        )["interventions"]
        tested = 0
        for aoi in configured:
            gui_data = ROOT / "gui/public/data" / aoi
            aoi_data = ROOT / "data/aoi" / aoi
            if not (gui_data / "manifest.json").exists() or not (aoi_data / "aoi.json").exists():
                continue
            with self.subTest(aoi=aoi):
                manifest = json.loads((gui_data / "manifest.json").read_text())
                for action, spec in intervention_menu.items():
                    self.assertEqual(
                        manifest["interventions"][action]["cost_usd_per_unit"],
                        spec["cost_usd_per_unit"],
                    )
                shape = (int(manifest["height"]), int(manifest["width"]))
                used_by_layer: dict[str, set[int]] = {"ground": set(), "roof": set(), "shade": set()}

                def one_pixel(filename: str, layer: str) -> tuple[int, int]:
                    mask = np.asarray(Image.open(gui_data / filename).convert("L")) >= 128
                    for row, col in np.argwhere(mask):
                        flat = int(row) * shape[1] + int(col)
                        if flat not in used_by_layer[layer]:
                            used_by_layer[layer].add(flat)
                            return int(row), int(col)
                    self.fail(f"{aoi}/{filename} has no unused eligible pixel")

                request: dict = {"trees": []}
                for request_key, filename, layer in (
                    ("reflective_pavement", "pavement_mask.png", "ground"),
                    ("depaved_pavement", "depavable_mask.png", "ground"),
                    ("shade_canopy", "placeable_shade_canopy.png", "shade"),
                    ("solar_canopy", "placeable_solar_canopy.png", "shade"),
                ):
                    row, col = one_pixel(filename, layer)
                    mask = np.zeros(shape, dtype=bool)
                    mask[row, col] = True
                    request[request_key] = encoded_mask(mask)

                roof_rgba = np.asarray(Image.open(gui_data / "roof_regions.png").convert("RGBA"))
                roof_ids = roof_rgba[..., 0].astype("int64") | (roof_rgba[..., 1].astype("int64") << 8) | (roof_rgba[..., 2].astype("int64") << 16)
                selectable_roofs = np.unique(roof_ids[roof_ids > 0])
                self.assertGreaterEqual(len(selectable_roofs), 2)
                for request_key, region_id in zip(("cool_roof", "green_roof"), selectable_roofs[:2]):
                    request[request_key] = encoded_mask(roof_ids == region_id)

                for size, filename in (("small", "placeable_tree_small.png"), ("medium", "placeable_tree_medium.png")):
                    row, col = one_pixel(filename, "shade")
                    request["trees"].append({"x": col + 0.5, "y": row + 0.5, "size": size})

                context = load_context(aoi_data)
                with policy_request(request):
                    placements = plan(context, 1_000_000_000)
                problems, _ = audit(context, placements, 1_000_000_000)
                self.assertEqual(problems, [])
                tested += 1
        self.assertEqual(tested, len(configured))


if __name__ == "__main__":
    unittest.main()
