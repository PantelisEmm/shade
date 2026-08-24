"""Focused regression checks for GUI-to-SOLWEIG intervention handling."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import solweig


RUNNER_PATH = Path(__file__).with_name("run_gui_solweig.py")
SPEC = importlib.util.spec_from_file_location("gui_solweig_runner", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {RUNNER_PATH}")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class MaterialOverrideTests(unittest.TestCase):
    def test_interventions_keep_semantic_classes_and_override_expected_materials(self) -> None:
        landcover = np.array([[1, 1, 2, 2, 2, 5]], dtype=np.uint8)
        surface = solweig.SurfaceData(
            dsm=np.ones(landcover.shape, dtype=np.float32),
            land_cover=landcover.copy(),
        )
        reflective = np.array([[True, False, False, False, False, False]])
        cool = np.array([[False, False, False, True, False, False]])
        green = np.array([[False, False, False, False, True, False]])

        with runner.explicit_material_overrides(surface, reflective, cool, green):
            albedo, emissivity, tgk, tstart, tmaxlst = surface.get_land_cover_properties()

        np.testing.assert_array_equal(surface.land_cover, landcover)
        self.assertAlmostEqual(float(albedo[0, 0]), runner.REFLECTIVE_ALBEDO)
        self.assertAlmostEqual(float(albedo[0, 1]), runner.BASELINE_PAVEMENT_ALBEDO)
        self.assertAlmostEqual(float(albedo[0, 2]), runner.BASELINE_ROOF_ALBEDO)
        self.assertAlmostEqual(float(albedo[0, 3]), runner.COOL_ROOF_ALBEDO)
        self.assertAlmostEqual(float(albedo[0, 4]), runner.GREEN_ROOF_ALBEDO)
        self.assertAlmostEqual(float(emissivity[0, 4]), runner.GREEN_ROOF_EMISSIVITY)
        self.assertAlmostEqual(float(tgk[0, 4]), runner.GREEN_ROOF_TGK)
        self.assertAlmostEqual(float(tstart[0, 4]), runner.GREEN_ROOF_TSTART, places=6)
        self.assertAlmostEqual(float(tmaxlst[0, 4]), runner.GREEN_ROOF_TMAXLST)
        self.assertAlmostEqual(float(tgk[0, 3]), 0.58)

    def test_depaving_uses_class_five_grass_and_explicit_albedo(self) -> None:
        landcover = np.array([[1, 1, 4]], dtype=np.uint8)
        surface = solweig.SurfaceData(
            dsm=np.ones(landcover.shape, dtype=np.float32),
            land_cover=np.array([[5, 1, 4]], dtype=np.uint8),
        )
        depaved = np.array([[True, False, False]])
        with runner.explicit_material_overrides(surface, None, None, None, depaved):
            albedo, _, tgk, _, _ = surface.get_land_cover_properties()
        self.assertEqual(int(surface.land_cover[0, 0]), 5)
        self.assertAlmostEqual(float(albedo[0, 0]), runner.DEPAVED_GRASS_ALBEDO)
        self.assertAlmostEqual(float(tgk[0, 0]), 0.21)

    def test_depaving_preserves_overlapping_tree_crown_class(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.tif"
            profile = {
                "driver": "GTiff", "height": 1, "width": 3, "count": 1,
                "dtype": "uint8", "crs": "EPSG:26986",
                "transform": runner.rasterio.transform.from_origin(0, 1, 1, 1),
            }
            with runner.rasterio.open(source, "w", **profile) as dataset:
                dataset.write(np.array([[1, 4, 1]], dtype=np.uint8), 1)
            output = runner.apply_depaving_landcover(
                source,
                np.array([[True, True, False]]),
                Path(directory) / "output",
            )
            with runner.rasterio.open(output) as dataset:
                np.testing.assert_array_equal(dataset.read(1), np.array([[5, 4, 1]], dtype=np.uint8))

    def test_shade_canopy_uses_half_footprint_and_thin_overhead_layer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "cdsm.tif"
            profile = {
                "driver": "GTiff", "height": 4, "width": 4, "count": 1,
                "dtype": "float32", "crs": "EPSG:26986",
                "transform": runner.rasterio.transform.from_origin(0, 4, 1, 1),
            }
            existing = np.zeros((4, 4), dtype=np.float32)
            existing[0, 0] = 6.0
            with runner.rasterio.open(source, "w", **profile) as dataset:
                dataset.write(existing, 1)
            cdsm_path, tdsm_path, physical = runner.apply_shade_canopy_geometry(
                source,
                np.ones((4, 4), dtype=bool),
                Path(directory) / "output",
            )
            self.assertEqual(int(physical.sum()), 8)
            with runner.rasterio.open(cdsm_path) as dataset:
                cdsm = dataset.read(1)
            with runner.rasterio.open(tdsm_path) as dataset:
                tdsm = dataset.read(1)
            self.assertEqual(float(cdsm[0, 0]), 6.0)
            self.assertAlmostEqual(float(tdsm[0, 0]), 1.5)
            self.assertEqual(float(cdsm[0, 2]), runner.SHADE_CANOPY_HEIGHT_M)
            self.assertAlmostEqual(float(tdsm[0, 2]), runner.SHADE_CANOPY_BOTTOM_M, places=6)
            self.assertEqual(float(cdsm[0, 1]), 0.0)

    def test_solar_canopy_uses_full_footprint_above_fabric_canopy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "cdsm.tif"
            profile = {
                "driver": "GTiff", "height": 4, "width": 4, "count": 1,
                "dtype": "float32", "crs": "EPSG:26986",
                "transform": runner.rasterio.transform.from_origin(0, 4, 1, 1),
            }
            with runner.rasterio.open(source, "w", **profile) as dataset:
                dataset.write(np.zeros((4, 4), dtype=np.float32), 1)
            shade = np.zeros((4, 4), dtype=bool)
            shade[:, :2] = True
            solar = np.zeros((4, 4), dtype=bool)
            solar[:, 1:] = True
            cdsm_path, tdsm_path, physical_shade, physical_solar = runner.apply_combined_canopy_geometry(
                source, shade, solar, Path(directory) / "output",
            )
            self.assertEqual(int(physical_shade.sum()), 4)
            self.assertEqual(int(physical_solar.sum()), 12)
            with runner.rasterio.open(cdsm_path) as dataset:
                cdsm = dataset.read(1)
            with runner.rasterio.open(tdsm_path) as dataset:
                tdsm = dataset.read(1)
            self.assertTrue(np.all(cdsm[:, 1:] == runner.SOLAR_CANOPY_HEIGHT_M))
            self.assertTrue(np.allclose(tdsm[:, 1:], runner.SOLAR_CANOPY_BOTTOM_M))


class SummaryDomainTests(unittest.TestCase):
    def test_utci_mean_mask_excludes_roof_cells(self) -> None:
        baseline = np.array([[30.0, 50.0], [32.0, 52.0]])
        intervention = np.array([[29.0, 60.0], [31.0, 62.0]])
        non_roof = np.array([[True, False], [True, False]])
        summary = runner.metric_summary(
            baseline,
            intervention,
            np.ones_like(non_roof),
            non_roof,
        )
        self.assertEqual(summary["mean_cell_count"], 2)
        self.assertAlmostEqual(summary["baseline_mean"], 31.0)
        self.assertAlmostEqual(summary["intervention_mean"], 30.0)
        self.assertAlmostEqual(summary["study_area_mean_reduction"], 1.0)

    def test_roof_nearby_mask_reaches_surrounding_cells(self) -> None:
        roof = np.zeros((51, 51), dtype=bool)
        roof[25, 25] = True
        nearby = runner.surrounding_mask(roof, resolution_m=1, radius_m=20)
        self.assertTrue(nearby[25, 25])
        self.assertTrue(nearby[25, 45])
        self.assertFalse(nearby[25, 46])


class TreeValidationTests(unittest.TestCase):
    def test_policy_valid_center_allows_crown_to_cross_nearby_obstacles(self) -> None:
        landcover = np.ones((20, 20), dtype=np.uint8)
        landcover[10, 10] = 2
        landcover[15, 15] = 7
        runner.validate_tree_placements(
            [{"x": 9.0, "y": 10.0, "heightM": 5.0, "crownDiameterM": 3.0}],
            landcover,
            1.0,
        )
        runner.validate_tree_placements(
            [{"x": 15.0, "y": 14.0, "heightM": 5.0, "crownDiameterM": 3.0}],
            landcover,
            1.0,
        )

    def test_policy_invalid_center_is_rejected(self) -> None:
        landcover = np.ones((20, 20), dtype=np.uint8)
        landcover[10, 10] = 2
        landcover[15, 15] = 7
        with self.assertRaisesRegex(ValueError, "planting pixel is on"):
            runner.validate_tree_placements(
                [{"x": 10.5, "y": 10.5, "heightM": 5.0, "crownDiameterM": 3.0}],
                landcover,
                1.0,
            )
        with self.assertRaisesRegex(ValueError, "planting pixel is on"):
            runner.validate_tree_placements(
                [{"x": 15.5, "y": 15.5, "heightM": 5.0, "crownDiameterM": 3.0}],
                landcover,
                1.0,
            )


if __name__ == "__main__":
    unittest.main()
