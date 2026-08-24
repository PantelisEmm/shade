"""Policy adapter for a layout submitted by the local intervention studio.

The scorer imports this module using its normal policy contract.  The Vite API
places the browser snapshot on disk and points ``SHADE_GUI_POLICY_REQUEST`` at
it, keeping the generated policy reproducible alongside ``score.json``.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from policy_api import Placement, PlanningContext

POLICY_NAME = "GUI intervention layout"
DESCRIPTION = (
    "The intervention layout drawn in the browser studio, audited and scored "
    "with the repository's standard policy pipeline."
)

MASK_ACTIONS = {
    "reflective_pavement": "light_road",
    "cool_roof": "cool_roof",
    "green_roof": "green_roof",
    "depaved_pavement": "grass_conversion",
    "shade_canopy": "shade_canopy",
    "solar_canopy": "solar_canopy",
}


def _request() -> dict[str, Any]:
    path = os.environ.get("SHADE_GUI_POLICY_REQUEST")
    if not path:
        raise RuntimeError("SHADE_GUI_POLICY_REQUEST is not set")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def decode_mask(value: Any, shape: tuple[int, int], label: str) -> np.ndarray:
    """Decode the browser's little-endian packed bit grid with strict checks."""
    rows, cols = shape
    if not value:
        return np.zeros(shape, dtype=bool)
    width = int(value.get("width", 0))
    height = int(value.get("height", 0))
    if (height, width) != shape:
        raise ValueError(
            f"{label}: GUI grid {width}x{height} does not match scorer grid "
            f"{cols}x{rows}"
        )
    raw = base64.b64decode(str(value.get("data", "")), validate=True)
    expected = (rows * cols + 7) // 8
    if len(raw) != expected:
        raise ValueError(f"{label}: packed mask is {len(raw)} bytes, expected {expected}")
    mask = np.unpackbits(np.frombuffer(raw, dtype="uint8"), bitorder="little")
    mask = mask[: rows * cols].reshape(shape).astype(bool)
    submitted_count = int(value.get("count", int(mask.sum())))
    if submitted_count != int(mask.sum()):
        raise ValueError(
            f"{label}: submitted count {submitted_count} does not match "
            f"the {int(mask.sum())} encoded pixels"
        )
    return mask


def _tree_placements(ctx: PlanningContext, trees: Any) -> list[Placement]:
    grouped: dict[str, list[tuple[int, int]]] = {"tree_small": [], "tree_medium": []}
    for index, tree in enumerate(trees if isinstance(trees, list) else []):
        try:
            col = int(np.floor(float(tree["x"])))
            row = int(np.floor(float(tree["y"])))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"tree {index + 1}: invalid map position") from exc
        action = "tree_small" if tree.get("size") == "small" else "tree_medium"
        grouped[action].append((row, col))

    placements: list[Placement] = []
    for action, points in grouped.items():
        if points:
            rows, cols = np.asarray(points, dtype="int64").T
            placements.append(Placement(action, rows, cols))
    return placements


def plan(ctx: PlanningContext, budget_usd: float) -> list[Placement]:
    del budget_usd  # The auditor, not this adapter, decides affordability.
    request = _request()
    placements: list[Placement] = []
    # Apply surface/roof edits first so a tree painted afterward remains canopy
    # land cover where its crown overlaps a compatible ground treatment.
    for request_key, action in MASK_ACTIONS.items():
        mask = decode_mask(request.get(request_key), ctx.shape, request_key)
        if mask.any():
            placements.append(Placement.from_mask(action, mask))
    placements.extend(_tree_placements(ctx, request.get("trees", [])))
    return placements
