import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  Building2,
  ChevronDown,
  CheckCircle2,
  CircleHelp,
  CloudSun,
  Cpu,
  Eye,
  EyeOff,
  GitBranch,
  Info,
  Layers3,
  Map,
  Menu,
  Moon,
  MousePointer2,
  Paintbrush,
  PanelRightClose,
  Play,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sprout,
  Sparkles,
  Sun,
  Trash2,
  TreePine,
  Umbrella,
  X,
} from "lucide-react";
import CoolRoofLayer from "./CoolRoofLayer";
import AutoresearchNavigator, { type Archive, type ArchiveIteration, type ArchivedLayout } from "./AutoresearchNavigator";
import GreenRoofLayer from "./GreenRoofLayer";
import DepavedLayer from "./DepavedLayer";
import ShadeCanopyLayer from "./ShadeCanopyLayer";
import ScreeningMetricLayer from "./ScreeningMetricLayer";
import InterventionMapLayers from "./InterventionMapLayers";
import ReflectivePavementLayer from "./ReflectivePavementLayer";
import StudyAreaOverview, { type OverviewArea } from "./StudyAreaOverview";
import {
  countMaskPixels,
  encodeMaskBits,
  decodeMaskBits,
  emptyRasterMask,
  hasMaskPixel,
  loadRasterMask,
  nearestPointOnSegmentSquared,
  storeRasterMask,
  writeMaskPixel,
  type RasterMask,
  type StreetSegment,
} from "./reflectivePavement";

type Layer = {
  id: string;
  label: string;
  detail: string;
  color: string;
  ready: boolean;
};

type Manifest = {
  aoi: string;
  label: string;
  split?: "train" | "held_out";
  bbox: number[];
  width: number;
  height: number;
  resolution_m: number;
  interventions?: Partial<Record<PolicyAction, { label: string; unit: "m2" | "tree"; cost_usd_per_unit: number }>>;
  built_utc: string;
  heat_ta3pm_c: { display_min: number; display_max: number };
  summary_masks?: {
    perceived_temperature: string;
    perceived_temperature_pixels: number;
    excluded_building_roof_pixels: number;
  };
  layers?: {
    tree_placement_mask?: string;
    tree_small_placeable_mask?: string;
    tree_medium_placeable_mask?: string;
    pavement_mask?: string;
    depavable_mask?: string;
    shade_canopy_placeable_mask?: string;
    solar_canopy_placeable_mask?: string;
    street_segments?: string;
    roof_regions?: string;
  };
  screening_metrics?: {
    file: string;
    approximate: boolean;
    basis: string;
    metrics: Record<"mrt" | "utci" | "surface", { display_min: number; display_max: number; label: string }>;
  };
};

type TreeSize = "small" | "medium";
type PolicyAction = "light_road" | "cool_roof" | "green_roof" | "grass_conversion" | "tree_small" | "tree_medium" | "shade_canopy" | "solar_canopy";

type TreeIntervention = {
  id: string;
  x: number;
  y: number;
  size: TreeSize;
  heightM: number;
  crownDiameterM: number;
};

type RemovalBox = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type TreeAction = {
  type: "place" | "remove";
  trees: TreeIntervention[];
};

type MapPoint = { x: number; y: number };

const CANOPY_ICON_PAVEMENT_TOLERANCE_M = 4;

const canopyIconIsNearEligibleGround = (
  point: MapPoint,
  placement: PlacementMask,
  depavable: PlacementMask,
  gridWidth: number,
  gridHeight: number,
  resolutionM: number,
) => {
  if (point.x < 0 || point.y < 0 || point.x >= gridWidth || point.y >= gridHeight) return false;
  const placementX = Math.min(placement.width - 1, Math.max(0, Math.floor((point.x / gridWidth) * placement.width)));
  const placementY = Math.min(placement.height - 1, Math.max(0, Math.floor((point.y / gridHeight) * placement.height)));
  if (placement.pixels[(placementY * placement.width + placementX) * 4] < 128) return false;
  const centerX = (point.x / gridWidth) * depavable.width;
  const centerY = (point.y / gridHeight) * depavable.height;
  const radius = (CANOPY_ICON_PAVEMENT_TOLERANCE_M / Math.max(resolutionM, 0.01)) * (depavable.width / gridWidth);
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(depavable.width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(depavable.height - 1, Math.ceil(centerY + radius));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) continue;
    if (depavable.pixels[(y * depavable.width + x) * 4] >= 128) return true;
  }
  return false;
};

type ShadeCanopyIcon = MapPoint & {
  id: string;
  angle: number;
};

type ReflectiveAction = {
  type: "reflective-paint" | "reflective-erase";
  pixels: number[];
  displacedDepavedPixels?: number[];
};

type DepaveAction = {
  type: "depave-add" | "depave-remove";
  pixels: number[];
  displacedReflectivePixels: number[];
};

type ShadeCanopyAction = {
  type: "shade-canopy-add" | "shade-canopy-remove";
  pixels: number[];
  icons: ShadeCanopyIcon[];
};

type SolarCanopyAction = {
  type: "solar-canopy-add" | "solar-canopy-remove";
  pixels: number[];
  icons: ShadeCanopyIcon[];
};

type RoofKind = "cool_roof" | "green_roof";

type RoofAction = {
  type: "roof-add" | "roof-remove";
  kind: RoofKind;
  pixels: number[];
  displacedPixels: number[];
};

type WorkspaceAction = TreeAction | ReflectiveAction | RoofAction | DepaveAction | ShadeCanopyAction | SolarCanopyAction;

type PlacementMask = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

const loadPlacementMask = (url: string) => new Promise<PlacementMask>((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      reject(new Error("Unable to read placement mask"));
      return;
    }
    context.drawImage(image, 0, 0);
    resolve({ width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data });
  };
  image.onerror = () => reject(new Error(`Unable to load ${url}`));
  image.src = url;
});

const placementMaskHasPoint = (mask: PlacementMask, point: MapPoint, gridWidth: number, gridHeight: number) => {
  if (point.x < 0 || point.y < 0 || point.x >= gridWidth || point.y >= gridHeight) return false;
  const x = Math.min(mask.width - 1, Math.max(0, Math.floor((point.x / gridWidth) * mask.width)));
  const y = Math.min(mask.height - 1, Math.max(0, Math.floor((point.y / gridHeight) * mask.height)));
  return mask.pixels[(y * mask.width + x) * 4] >= 128;
};

type SimulationMetric = {
  display_min: number;
  display_max: number;
  baseline_mean: number;
  intervention_mean: number;
  study_area_mean_reduction: number;
  local_mean_reduction: number;
  mean_cell_count?: number;
};

type SolweigBaseline = {
  aoi?: string;
  model: string;
  physics_version?: string;
  scenario: string;
  date: string;
  hour: number;
  file: string;
  metrics: Record<"mrt" | "utci", Pick<SimulationMetric, "display_min" | "display_max" | "baseline_mean">>;
};

type SimulationResult = {
  kind?: "comparison";
  id: string;
  state: "complete";
  completed_at: string;
  model: string;
  aoi?: string;
  physics_version?: string;
  scenario: string;
  date: string;
  hour: number;
  tree_snapshot: TreeIntervention[];
  reflective_snapshot?: { width: number; height: number; count: number; data: string };
  cool_roof_snapshot?: { width: number; height: number; count: number; data: string };
  green_roof_snapshot?: { width: number; height: number; count: number; data: string };
  depaved_pavement_snapshot?: { width: number; height: number; count: number; data: string };
  shade_canopy_snapshot?: { width: number; height: number; count: number; data: string };
  solar_canopy_snapshot?: { width: number; height: number; count: number; data: string };
  metrics: Record<"mrt" | "utci", SimulationMetric>;
  files: { baseline: string; intervention: string };
};

type BaselineJobResult = {
  kind: "baseline";
  id: string;
  state: "complete";
  completed_at: string;
  baseline: SolweigBaseline;
};

type SimulationJob = {
  id: string;
  mode?: "baseline" | "comparison";
  state: "queued" | "running" | "complete" | "failed" | "cancelled";
  stage: string;
  progress: number;
  elapsed_seconds?: number;
  error?: string;
  result?: SimulationResult | BaselineJobResult;
};

type PolicyScoreObjectives = {
  heat_relief_c: number | null;
  expected_relief_c: number | null;
  access_gain_pp: number | null;
  equity_ratio: number | null;
  equity_relief_c: number | null;
  equity_pop_share: number | null;
  equity_aois: number;
  cobenefit_greened_pct: number | null;
  cost_efficiency_person_c_per_100k: number | null;
  tmrt_relief_c: number | null;
  plan_survival: number | null;
  pv_mwh_per_yr: number | null;
  spend_usd: number | null;
};

type PolicyScoreReport = {
  verdict: "feasible" | "infeasible";
  objectives: PolicyScoreObjectives | null;
  violations: Record<string, string[]>;
  run: {
    scenarios: string[];
    resolution_m: number;
    hours: number[];
    horizon_years: number | null;
  };
  spend?: Record<string, { total_usd: number; budget_usd: number }>;
  gui?: { layout_signature?: string; aoi?: string; scenario?: string; budget_usd?: number };
};

type PolicyScoreJob = {
  id: string;
  state: "queued" | "running" | "complete" | "failed" | "cancelled";
  stage: string;
  progress: number;
  elapsed_seconds?: number;
  error?: string;
  result?: PolicyScoreReport;
};

type MetricKey = "mrt" | "utci" | "surface";
type ScenarioKey = "baseline" | "warm_2c" | "humid_warm_2c" | "warm_4c";

type TimeOption = {
  hour: number;
  label: string;
  detail: string;
  body: "sun" | "moon";
  bodyY: number;
};

const METRICS: Record<MetricKey, { label: string; shortLabel: string; unit: string; medium: number; small: number; color: string }> = {
  mrt: { label: "Mean radiant temperature", shortLabel: "Local MRT reduction", unit: "°C", medium: 10, small: 6.5, color: "42, 103, 168" },
  utci: { label: "UTCI / perceived temperature", shortLabel: "Local UTCI reduction", unit: "°C", medium: 2.8, small: 1.8, color: "28, 137, 111" },
  surface: { label: "Surface temperature", shortLabel: "Local surface reduction", unit: "°C", medium: 8.3, small: 5.4, color: "116, 76, 163" },
};

const FALLBACK_UNIT_COSTS: Record<PolicyAction, number> = {
  light_road: 22.28,
  cool_roof: 69.97,
  green_roof: 376.74,
  grass_conversion: 90,
  tree_small: 2024,
  tree_medium: 6687,
  shade_canopy: 1055,
  solar_canopy: 2150,
};

const SCENARIOS: Record<ScenarioKey, { label: string; shortLabel: string; description: string; deltaC: number; holdRh: boolean }> = {
  baseline: { label: "Current climate · hottest TMY day", shortLabel: "Current climate", description: "TMYx 2011–2025, unmodified", deltaC: 0, holdRh: false },
  warm_2c: { label: "Mid-century · +2°C", shortLabel: "+2°C mid-century", description: "Dry-bulb warming stress test", deltaC: 2, holdRh: false },
  humid_warm_2c: { label: "Hot and humid · +2°C", shortLabel: "+2°C humid", description: "Warming at constant relative humidity", deltaC: 2, holdRh: true },
  warm_4c: { label: "Late-century extreme · +4°C", shortLabel: "+4°C extreme", description: "High-emissions robustness test", deltaC: 4, holdRh: false },
};

const TIME_OPTIONS: TimeOption[] = [
  { hour: 10, label: "10 AM", detail: "Morning", body: "sun", bodyY: 12 },
  { hour: 13, label: "1 PM", detail: "Solar peak", body: "sun", bodyY: 5 },
  { hour: 16, label: "4 PM", detail: "Afternoon", body: "sun", bodyY: 13 },
  { hour: 20, label: "8 PM", detail: "Sunset", body: "sun", bodyY: 25 },
  { hour: 23, label: "11 PM", detail: "Night", body: "moon", bodyY: 7 },
];

const BASELINE_WEATHER: Record<number, { temperature: number; humidity: number; wind: number }> = {
  10: { temperature: 31.1, humidity: 38, wind: 5.7 },
  13: { temperature: 33.3, humidity: 31, wind: 5.1 },
  16: { temperature: 34.0, humidity: 30, wind: 5.1 },
  20: { temperature: 31.7, humidity: 35, wind: 5.1 },
  23: { temperature: 27.8, humidity: 47, wind: 4.6 },
};

const DRY_WARMING_HUMIDITY: Record<2 | 4, Record<number, number>> = {
  2: { 10: 34, 13: 28, 16: 27, 20: 31, 23: 42 },
  4: { 10: 30, 13: 25, 16: 24, 20: 28, 23: 38 },
};

const STUDY_AREA_STORAGE_KEY = "shade.active-study-area.v1";
const storedStudyArea = localStorage.getItem(STUDY_AREA_STORAGE_KEY);
const ACTIVE_AOI = storedStudyArea && /^[a-z0-9_]+$/.test(storedStudyArea) ? storedStudyArea : "chinatown";
const WORKSPACE_STORAGE_PREFIX = `shade.workspace.v3.${ACTIVE_AOI}`;
const TREE_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.trees`;
const SIMULATION_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.solweig-result`;
const POLICY_SCORE_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.policy-score`;
const BASELINE_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.solweig-baselines`;
const REFLECTIVE_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.reflective-pavement`;
const COOL_ROOF_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.cool-roof`;
const GREEN_ROOF_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.green-roof`;
const DEPAVED_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.depaved-pavement`;
const SHADE_CANOPY_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.shade-canopy`;
const LEGACY_SHADE_CANOPY_ICONS_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.shade-canopy-icons-legacy`;
const SHADE_CANOPY_ICONS_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.shade-canopy-icons`;
const SOLAR_CANOPY_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.solar-canopy`;
const SOLAR_CANOPY_ICONS_STORAGE_KEY = `${WORKSPACE_STORAGE_PREFIX}.solar-canopy-icons`;
const AUTORESEARCH_MODE_STORAGE_KEY = "shade.autoresearch.enabled.v1";
const DEFAULT_GRID_SIZE = 1001;
const DEFAULT_RESOLUTION_M = 1;
const MAP_FRAME_LEFT = 199;
const MAP_DISPLAY_SIZE = 1000;
const SHADE_CANOPY_ICON_SPACING_M = 12;
const SOLWEIG_PHYSICS_VERSION = "gui-solweig-multi-aoi-v3-safe-tiling";
const REFLECTIVE_LOCAL_EFFECT = { mrt: 0, utci: 0.8, surface: 6.1 } as const;

const loadTrees = (): TreeIntervention[] => {
  try {
    const stored = localStorage.getItem(TREE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

const loadShadeCanopyIcons = (): ShadeCanopyIcon[] => {
  try {
    const stored = localStorage.getItem(SHADE_CANOPY_ICONS_STORAGE_KEY);
    if (stored) {
      return (JSON.parse(stored) as ShadeCanopyIcon[]).map((icon) => ({ ...icon, angle: 0 }));
    }
    const legacyStored = localStorage.getItem(LEGACY_SHADE_CANOPY_ICONS_STORAGE_KEY);
    if (!legacyStored) return [];
    const legacyIcons = JSON.parse(legacyStored) as ShadeCanopyIcon[];
    const migrated: ShadeCanopyIcon[] = [];
    const minimumSpacingSquared = (SHADE_CANOPY_ICON_SPACING_M * 0.8) ** 2;
    for (const icon of legacyIcons) {
      if (migrated.some((existing) => (existing.x - icon.x) ** 2 + (existing.y - icon.y) ** 2 < minimumSpacingSquared)) continue;
      migrated.push({ ...icon, angle: 0 });
    }
    return migrated;
  } catch {
    return [];
  }
};

const loadSolarCanopyIcons = (): ShadeCanopyIcon[] => {
  try {
    const stored = localStorage.getItem(SOLAR_CANOPY_ICONS_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as ShadeCanopyIcon[]).map((icon) => ({ ...icon, angle: 0 })) : [];
  } catch {
    return [];
  }
};

const loadSimulation = (): SimulationResult | null => {
  try {
    const stored = localStorage.getItem(SIMULATION_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

const loadPolicyScore = (): PolicyScoreReport | null => {
  try {
    const stored = localStorage.getItem(POLICY_SCORE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

const compactFingerprint = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const formatPolicyMetric = (value: number | null | undefined, suffix: string, digits = 2) => (
  value === null || value === undefined ? "Not available" : `${value.toFixed(digits)}${suffix}`
);

const baselineCacheKey = (scenario: string, date: string, hour: number) => `${scenario}:${date}:${hour}`;

const loadBaselineCache = (): Record<string, SolweigBaseline> => {
  try {
    const stored = localStorage.getItem(BASELINE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

const storeBaseline = (baseline: SolweigBaseline) => {
  const cache = loadBaselineCache();
  cache[baselineCacheKey(baseline.scenario, baseline.date, baseline.hour)] = baseline;
  localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(cache));
};

const treeSignature = (items: TreeIntervention[]) => JSON.stringify(
  [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((tree) => [tree.id, Number(tree.x.toFixed(3)), Number(tree.y.toFixed(3)), tree.size, Number(tree.heightM.toFixed(2)), Number(tree.crownDiameterM.toFixed(2))]),
);

const layers: Layer[] = [
  { id: "base", label: "Cartographic base", detail: "Light local map", color: "#ded8c8", ready: true },
  { id: "land", label: "Land cover", detail: "Pavement · grass/soil · water", color: "#85a778", ready: true },
  { id: "canopy", label: "Tree canopy", detail: "2024 crowns + placed trees", color: "#3f7656", ready: true },
  { id: "heat", label: "Heat exposure", detail: "3 PM air temperature", color: "#db725a", ready: true },
];

function App() {
  const [overviewOpen, setOverviewOpen] = useState(() => !localStorage.getItem(STUDY_AREA_STORAGE_KEY));
  const dataRoot = `/data/${ACTIVE_AOI}`;
  const [visible, setVisible] = useState<Record<string, boolean>>({ base: true });
  const [panelOpen, setPanelOpen] = useState(true);
  const [metric, setMetric] = useState<MetricKey>("mrt");
  const [scenario, setScenario] = useState<ScenarioKey>("baseline");
  const [simulationHour, setSimulationHour] = useState(13);
  const [camera, setCamera] = useState({ x: -150, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [activeView, setActiveView] = useState<"map" | "design" | "results">("map");
  const [designIntervention, setDesignIntervention] = useState<"trees" | "reflective" | "depave" | "shade_canopy" | "solar_canopy" | RoofKind>("trees");
  const [trees, setTrees] = useState<TreeIntervention[]>(loadTrees);
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [placementMode, setPlacementMode] = useState(false);
  const [brushMode, setBrushMode] = useState(false);
  const [removalMode, setRemovalMode] = useState(false);
  const [removalBox, setRemovalBox] = useState<RemovalBox | null>(null);
  const [actionHistory, setActionHistory] = useState<WorkspaceAction[]>([]);
  const [newTreeSize, setNewTreeSize] = useState<TreeSize>("medium");
  const [brushDiameterM, setBrushDiameterM] = useState(30);
  const [brushDensity, setBrushDensity] = useState(8);
  const [brushCursor, setBrushCursor] = useState<MapPoint | null>(null);
  const [placementMask, setPlacementMask] = useState<PlacementMask | null>(null);
  const [placementMaskStatus, setPlacementMaskStatus] = useState<"loading" | "ready" | "error">("loading");
  const [treePlaceableMasks, setTreePlaceableMasks] = useState<Record<TreeSize, PlacementMask | null>>({ small: null, medium: null });
  const [reflectiveMask, setReflectiveMask] = useState<RasterMask>(() => loadRasterMask(REFLECTIVE_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const reflectivePixelCount = useMemo(
    () => countMaskPixels(reflectiveMask.bits, reflectiveMask.width, reflectiveMask.height),
    [reflectiveMask.bits, reflectiveMask.width, reflectiveMask.height],
  );
  const [pavementMask, setPavementMask] = useState<PlacementMask | null>(null);
  const [pavementMaskStatus, setPavementMaskStatus] = useState<"loading" | "ready" | "error">("loading");
  const [streetSegments, setStreetSegments] = useState<StreetSegment[]>([]);
  const [reflectiveBrushMode, setReflectiveBrushMode] = useState(false);
  const [reflectiveSegmentMode, setReflectiveSegmentMode] = useState(false);
  const [reflectiveEraseMode, setReflectiveEraseMode] = useState(false);
  const [reflectiveEraseBox, setReflectiveEraseBox] = useState<RemovalBox | null>(null);
  const [reflectiveBrushDiameterM, setReflectiveBrushDiameterM] = useState(14);
  const [reflectiveCursor, setReflectiveCursor] = useState<MapPoint | null>(null);
  const [depavedMask, setDepavedMask] = useState<RasterMask>(() => loadRasterMask(DEPAVED_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const depavedPixelCount = useMemo(
    () => countMaskPixels(depavedMask.bits, depavedMask.width, depavedMask.height),
    [depavedMask.bits, depavedMask.width, depavedMask.height],
  );
  const [depavableMask, setDepavableMask] = useState<PlacementMask | null>(null);
  const [depavableMaskStatus, setDepavableMaskStatus] = useState<"loading" | "ready" | "error">("loading");
  const [depaveBrushMode, setDepaveBrushMode] = useState(false);
  const [depaveBoxMode, setDepaveBoxMode] = useState(false);
  const [depaveEraseMode, setDepaveEraseMode] = useState(false);
  const [depaveBox, setDepaveBox] = useState<RemovalBox | null>(null);
  const [depaveBrushDiameterM, setDepaveBrushDiameterM] = useState(14);
  const [depaveCursor, setDepaveCursor] = useState<MapPoint | null>(null);
  const [shadeCanopyMask, setShadeCanopyMask] = useState<RasterMask>(() => loadRasterMask(SHADE_CANOPY_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const [shadeCanopyPlaceableMask, setShadeCanopyPlaceableMask] = useState<PlacementMask | null>(null);
  const [shadeCanopyIcons, setShadeCanopyIcons] = useState<ShadeCanopyIcon[]>(loadShadeCanopyIcons);
  const shadeCanopyPixelCount = useMemo(
    () => countMaskPixels(shadeCanopyMask.bits, shadeCanopyMask.width, shadeCanopyMask.height),
    [shadeCanopyMask.bits, shadeCanopyMask.width, shadeCanopyMask.height],
  );
  const [shadeCanopySegmentMode, setShadeCanopySegmentMode] = useState(false);
  const [shadeCanopyBrushMode, setShadeCanopyBrushMode] = useState(false);
  const [shadeCanopyEraseMode, setShadeCanopyEraseMode] = useState(false);
  const [shadeCanopyEraseBox, setShadeCanopyEraseBox] = useState<RemovalBox | null>(null);
  const [shadeCanopyWidthM, setShadeCanopyWidthM] = useState(6);
  const [shadeCanopyBrushDiameterM, setShadeCanopyBrushDiameterM] = useState(10);
  const [shadeCanopyCursor, setShadeCanopyCursor] = useState<MapPoint | null>(null);
  const [solarCanopyMask, setSolarCanopyMask] = useState<RasterMask>(() => loadRasterMask(SOLAR_CANOPY_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const [solarCanopyPlaceableMask, setSolarCanopyPlaceableMask] = useState<PlacementMask | null>(null);
  const [solarCanopyIcons, setSolarCanopyIcons] = useState<ShadeCanopyIcon[]>(loadSolarCanopyIcons);
  const solarCanopyPixelCount = useMemo(
    () => countMaskPixels(solarCanopyMask.bits, solarCanopyMask.width, solarCanopyMask.height),
    [solarCanopyMask.bits, solarCanopyMask.width, solarCanopyMask.height],
  );
  const [solarCanopySegmentMode, setSolarCanopySegmentMode] = useState(false);
  const [solarCanopyBrushMode, setSolarCanopyBrushMode] = useState(false);
  const [solarCanopyEraseMode, setSolarCanopyEraseMode] = useState(false);
  const [solarCanopyEraseBox, setSolarCanopyEraseBox] = useState<RemovalBox | null>(null);
  const [solarCanopyWidthM, setSolarCanopyWidthM] = useState(6);
  const [solarCanopyBrushDiameterM, setSolarCanopyBrushDiameterM] = useState(10);
  const [solarCanopyCursor, setSolarCanopyCursor] = useState<MapPoint | null>(null);
  const [coolRoofMask, setCoolRoofMask] = useState<RasterMask>(() => loadRasterMask(COOL_ROOF_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const coolRoofPixelCount = useMemo(
    () => countMaskPixels(coolRoofMask.bits, coolRoofMask.width, coolRoofMask.height),
    [coolRoofMask.bits, coolRoofMask.width, coolRoofMask.height],
  );
  const [greenRoofMask, setGreenRoofMask] = useState<RasterMask>(() => loadRasterMask(GREEN_ROOF_STORAGE_KEY, DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE));
  const greenRoofPixelCount = useMemo(
    () => countMaskPixels(greenRoofMask.bits, greenRoofMask.width, greenRoofMask.height),
    [greenRoofMask.bits, greenRoofMask.width, greenRoofMask.height],
  );
  const [roofRegions, setRoofRegions] = useState<PlacementMask | null>(null);
  const [roofRegionsStatus, setRoofRegionsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [coolRoofClickMode, setCoolRoofClickMode] = useState(false);
  const [coolRoofBrushMode, setCoolRoofBrushMode] = useState(false);
  const [coolRoofBoxMode, setCoolRoofBoxMode] = useState(false);
  const [coolRoofEraseMode, setCoolRoofEraseMode] = useState(false);
  const [coolRoofBox, setCoolRoofBox] = useState<RemovalBox | null>(null);
  const [coolRoofBrushDiameterM, setCoolRoofBrushDiameterM] = useState(18);
  const [coolRoofCursor, setCoolRoofCursor] = useState<MapPoint | null>(null);
  const [placementNotice, setPlacementNotice] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [autoresearchMode, setAutoresearchMode] = useState(() => localStorage.getItem(AUTORESEARCH_MODE_STORAGE_KEY) === "true");
  const [autoresearchCandidate, setAutoresearchCandidate] = useState<ArchiveIteration | null>(null);
  const [autoresearchRunId, setAutoresearchRunId] = useState<string | null>(null);
  const [autoresearchLayoutReady, setAutoresearchLayoutReady] = useState(false);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(loadSimulation);
  const [solweigBaseline, setSolweigBaseline] = useState<SolweigBaseline | null>(null);
  const [baselineLoadState, setBaselineLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [simulationJob, setSimulationJob] = useState<SimulationJob | null>(null);
  const [simulationReady, setSimulationReady] = useState(false);
  const [simulationChecked, setSimulationChecked] = useState(false);
  const [simulationSetupOpen, setSimulationSetupOpen] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [policyScore, setPolicyScore] = useState<PolicyScoreReport | null>(loadPolicyScore);
  const [policyScoreJob, setPolicyScoreJob] = useState<PolicyScoreJob | null>(null);
  const [policyScoringReady, setPolicyScoringReady] = useState(false);
  const [policyScoringChecked, setPolicyScoringChecked] = useState(false);
  const [policyScoringBudget, setPolicyScoringBudget] = useState(() => loadPolicyScore()?.gui?.budget_usd ?? 500_000);
  const [policyScoreError, setPolicyScoreError] = useState<string | null>(null);
  const [comparisonActive, setComparisonActive] = useState(false);
  const [comparisonSplit, setComparisonSplit] = useState(52);
  const [comparisonDragging, setComparisonDragging] = useState(false);
  const dragOrigin = useRef({ pointerX: 0, pointerY: 0, cameraX: 0, cameraY: 0 });
  const rasterFrameRef = useRef<HTMLDivElement>(null);
  const mapStageRef = useRef<HTMLElement>(null);
  const draggingTreeId = useRef<string | null>(null);
  const treesRef = useRef(trees);
  const reflectiveMaskRef = useRef(reflectiveMask);
  const depavedMaskRef = useRef(depavedMask);
  const shadeCanopyMaskRef = useRef(shadeCanopyMask);
  const shadeCanopyStrokeActive = useRef(false);
  const shadeCanopyStrokeLastPoint = useRef<MapPoint | null>(null);
  const shadeCanopyStrokeChanges = useRef<number[]>([]);
  const shadeCanopyStrokeIcons = useRef<ShadeCanopyIcon[]>([]);
  const shadeCanopyStrokeLastIconPoint = useRef<MapPoint | null>(null);
  const solarCanopyMaskRef = useRef(solarCanopyMask);
  const solarCanopyStrokeActive = useRef(false);
  const solarCanopyStrokeLastPoint = useRef<MapPoint | null>(null);
  const solarCanopyStrokeChanges = useRef<number[]>([]);
  const solarCanopyStrokeIcons = useRef<ShadeCanopyIcon[]>([]);
  const solarCanopyStrokeLastIconPoint = useRef<MapPoint | null>(null);
  const coolRoofMaskRef = useRef(coolRoofMask);
  const greenRoofMaskRef = useRef(greenRoofMask);
  const brushStrokeActive = useRef(false);
  const brushStrokeTrees = useRef<TreeIntervention[]>([]);
  const brushLastPoint = useRef<MapPoint | null>(null);
  const reflectiveStrokeActive = useRef(false);
  const reflectiveStrokeLastPoint = useRef<MapPoint | null>(null);
  const reflectiveStrokeChanges = useRef<number[]>([]);
  const reflectiveStrokeChangedSet = useRef(new Set<number>());
  const reflectiveStrokeDisplacedDepaved = useRef<number[]>([]);
  const depaveStrokeActive = useRef(false);
  const depaveStrokeLastPoint = useRef<MapPoint | null>(null);
  const depaveStrokeChanges = useRef<number[]>([]);
  const depaveStrokeChangedSet = useRef(new Set<number>());
  const depaveStrokeDisplacedReflective = useRef<number[]>([]);
  const roofPixelsByRegionRef = useRef(new globalThis.Map<number, number[]>());
  const coolRoofStrokeActive = useRef(false);
  const coolRoofStrokeLastPoint = useRef<MapPoint | null>(null);
  const coolRoofStrokeRegionIds = useRef(new Set<number>());
  const coolRoofStrokePixels = useRef<number[]>([]);
  const roofStrokeDisplacedPixels = useRef<number[]>([]);
  const attemptedBaselines = useRef(new Set<string>());
  const strictWorkspaceSanitized = useRef(false);
  const autoresearchModeRef = useRef(autoresearchMode);
  const autoresearchSimulationAttempt = useRef<string | null>(null);

  const archivedSimulationFile = autoresearchCandidate?.simulation_files?.[ACTIVE_AOI]?.[scenario]?.[String(simulationHour)] ?? null;

  useEffect(() => {
    autoresearchModeRef.current = autoresearchMode;
  }, [autoresearchMode]);

  const maskFromArchive = useCallback((value: ArchivedLayout["interventions"][string] | undefined, width: number, height: number) => {
    if (!value || value.width !== width || value.height !== height) return emptyRasterMask(width, height);
    try {
      const bits = decodeMaskBits(value.data);
      if (bits.length !== Math.ceil((width * height) / 8)) return emptyRasterMask(width, height);
      return { width, height, bits, count: countMaskPixels(bits, width, height) };
    } catch {
      return emptyRasterMask(width, height);
    }
  }, []);

  const applyAutoresearchLayout = useCallback((layout: ArchivedLayout, iteration: ArchiveIteration, archive: Archive, runId: string) => {
    if (layout.aoi !== ACTIVE_AOI) return;
    const width = layout.width;
    const height = layout.height;
    const nextReflective = maskFromArchive(layout.interventions.reflective_pavement, width, height);
    const nextCoolRoof = maskFromArchive(layout.interventions.cool_roof, width, height);
    const nextGreenRoof = maskFromArchive(layout.interventions.green_roof, width, height);
    const nextDepaved = maskFromArchive(layout.interventions.depaved_pavement, width, height);
    const nextShade = maskFromArchive(layout.interventions.shade_canopy, width, height);
    const nextSolar = maskFromArchive(layout.interventions.solar_canopy, width, height);
    treesRef.current = layout.trees;
    reflectiveMaskRef.current = nextReflective;
    coolRoofMaskRef.current = nextCoolRoof;
    greenRoofMaskRef.current = nextGreenRoof;
    depavedMaskRef.current = nextDepaved;
    shadeCanopyMaskRef.current = nextShade;
    solarCanopyMaskRef.current = nextSolar;
    setTrees(layout.trees);
    setReflectiveMask(nextReflective);
    setCoolRoofMask(nextCoolRoof);
    setGreenRoofMask(nextGreenRoof);
    setDepavedMask(nextDepaved);
    setShadeCanopyMask(nextShade);
    setSolarCanopyMask(nextSolar);
    setShadeCanopyIcons([]);
    setSolarCanopyIcons([]);
    setSelectedTreeId(null);
    setActionHistory([]);
    setAutoresearchCandidate(iteration);
    setAutoresearchRunId(runId);
    setAutoresearchLayoutReady(true);
    setSimulationResult(null);
    setSimulationJob(null);
    setSimulationError(null);
    const archived = iteration.objectives ?? {};
    const archivedObjectives: PolicyScoreObjectives = {
      heat_relief_c: archived.heat_relief_c ?? iteration.fitness ?? null,
      expected_relief_c: archived.expected_relief_c ?? null,
      access_gain_pp: archived.access_gain_pp ?? null,
      equity_ratio: archived.equity_ratio ?? null,
      equity_relief_c: archived.equity_relief_c ?? null,
      equity_pop_share: archived.equity_pop_share ?? null,
      equity_aois: archived.equity_aois ?? 0,
      cobenefit_greened_pct: archived.cobenefit_greened_pct ?? null,
      cost_efficiency_person_c_per_100k: archived.cost_efficiency_person_c_per_100k ?? null,
      tmrt_relief_c: archived.tmrt_relief_c ?? null,
      plan_survival: archived.plan_survival ?? null,
      pv_mwh_per_yr: archived.pv_mwh_per_yr ?? null,
      spend_usd: archived.spend_usd ?? null,
    };
    setPolicyScore({
      verdict: "feasible",
      objectives: archivedObjectives,
      violations: {},
      run: {
        scenarios: archive.run?.scenarios ?? ["baseline"],
        resolution_m: archive.run?.resolution_m ?? layout.resolution_m,
        hours: [10, 13, 16],
        horizon_years: null,
      },
    });
    if (archive.run?.budget_usd_per_aoi ?? archive.run?.budget_usd) {
      setPolicyScoringBudget(Number(archive.run?.budget_usd_per_aoi ?? archive.run?.budget_usd));
    }
    setPolicyScoreJob(null);
    autoresearchSimulationAttempt.current = null;
  }, [maskFromArchive]);

  const clearAutoresearchLayout = useCallback((iteration: ArchiveIteration | null, runId: string | null) => {
    const width = manifest?.width ?? DEFAULT_GRID_SIZE;
    const height = manifest?.height ?? DEFAULT_GRID_SIZE;
    const empty = () => emptyRasterMask(width, height);
    const nextReflective = empty();
    const nextCool = empty();
    const nextGreen = empty();
    const nextDepaved = empty();
    const nextShade = empty();
    const nextSolar = empty();
    treesRef.current = [];
    reflectiveMaskRef.current = nextReflective;
    coolRoofMaskRef.current = nextCool;
    greenRoofMaskRef.current = nextGreen;
    depavedMaskRef.current = nextDepaved;
    shadeCanopyMaskRef.current = nextShade;
    solarCanopyMaskRef.current = nextSolar;
    setTrees([]);
    setReflectiveMask(nextReflective);
    setCoolRoofMask(nextCool);
    setGreenRoofMask(nextGreen);
    setDepavedMask(nextDepaved);
    setShadeCanopyMask(nextShade);
    setSolarCanopyMask(nextSolar);
    setShadeCanopyIcons([]);
    setSolarCanopyIcons([]);
    setAutoresearchCandidate(iteration);
    setAutoresearchRunId(runId);
    setAutoresearchLayoutReady(false);
    setSimulationResult(null);
    setSimulationJob(null);
    setPolicyScore(null);
    setPolicyScoreJob(null);
    autoresearchSimulationAttempt.current = null;
  }, [manifest?.height, manifest?.width]);

  const restoreEditableWorkspace = useCallback(() => {
    const width = manifest?.width ?? DEFAULT_GRID_SIZE;
    const height = manifest?.height ?? DEFAULT_GRID_SIZE;
    const nextTrees = loadTrees();
    const nextReflective = loadRasterMask(REFLECTIVE_STORAGE_KEY, width, height);
    const nextCoolRoof = loadRasterMask(COOL_ROOF_STORAGE_KEY, width, height);
    const nextGreenRoof = loadRasterMask(GREEN_ROOF_STORAGE_KEY, width, height);
    const nextDepaved = loadRasterMask(DEPAVED_STORAGE_KEY, width, height);
    const nextShade = loadRasterMask(SHADE_CANOPY_STORAGE_KEY, width, height);
    const nextSolar = loadRasterMask(SOLAR_CANOPY_STORAGE_KEY, width, height);
    treesRef.current = nextTrees;
    reflectiveMaskRef.current = nextReflective;
    coolRoofMaskRef.current = nextCoolRoof;
    greenRoofMaskRef.current = nextGreenRoof;
    depavedMaskRef.current = nextDepaved;
    shadeCanopyMaskRef.current = nextShade;
    solarCanopyMaskRef.current = nextSolar;
    setTrees(nextTrees);
    setReflectiveMask(nextReflective);
    setCoolRoofMask(nextCoolRoof);
    setGreenRoofMask(nextGreenRoof);
    setDepavedMask(nextDepaved);
    setShadeCanopyMask(nextShade);
    setSolarCanopyMask(nextSolar);
    setShadeCanopyIcons(loadShadeCanopyIcons());
    setSolarCanopyIcons(loadSolarCanopyIcons());
    setSimulationResult(loadSimulation());
    setPolicyScore(loadPolicyScore());
    setAutoresearchCandidate(null);
    setAutoresearchRunId(null);
    setAutoresearchLayoutReady(false);
    setSelectedTreeId(null);
    setActionHistory([]);
  }, [manifest?.height, manifest?.width]);

  const enableAutoresearch = useCallback(() => {
    autoresearchModeRef.current = true;
    localStorage.setItem(AUTORESEARCH_MODE_STORAGE_KEY, "true");
    setPlacementMode(false);
    setBrushMode(false);
    setRemovalMode(false);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setShadeCanopySegmentMode(false);
    setShadeCanopyBrushMode(false);
    setShadeCanopyEraseMode(false);
    setSolarCanopySegmentMode(false);
    setSolarCanopyBrushMode(false);
    setSolarCanopyEraseMode(false);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    clearAutoresearchLayout(null, null);
    setAutoresearchMode(true);
    setPanelOpen(true);
  }, [clearAutoresearchLayout]);

  const disableAutoresearch = useCallback(() => {
    autoresearchModeRef.current = false;
    localStorage.removeItem(AUTORESEARCH_MODE_STORAGE_KEY);
    setAutoresearchMode(false);
    restoreEditableWorkspace();
  }, [restoreEditableWorkspace]);

  const copyAutoresearchToDesign = useCallback(() => {
    if (!autoresearchLayoutReady) return;
    localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(treesRef.current));
    storeRasterMask(REFLECTIVE_STORAGE_KEY, reflectiveMaskRef.current);
    storeRasterMask(COOL_ROOF_STORAGE_KEY, coolRoofMaskRef.current);
    storeRasterMask(GREEN_ROOF_STORAGE_KEY, greenRoofMaskRef.current);
    storeRasterMask(DEPAVED_STORAGE_KEY, depavedMaskRef.current);
    storeRasterMask(SHADE_CANOPY_STORAGE_KEY, shadeCanopyMaskRef.current);
    storeRasterMask(SOLAR_CANOPY_STORAGE_KEY, solarCanopyMaskRef.current);
    if (shadeCanopyIcons.length) localStorage.setItem(SHADE_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(shadeCanopyIcons));
    else localStorage.removeItem(SHADE_CANOPY_ICONS_STORAGE_KEY);
    if (solarCanopyIcons.length) localStorage.setItem(SOLAR_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(solarCanopyIcons));
    else localStorage.removeItem(SOLAR_CANOPY_ICONS_STORAGE_KEY);
    if (simulationResult) localStorage.setItem(SIMULATION_STORAGE_KEY, JSON.stringify(simulationResult));
    else localStorage.removeItem(SIMULATION_STORAGE_KEY);
    localStorage.removeItem(POLICY_SCORE_STORAGE_KEY);
    localStorage.removeItem(AUTORESEARCH_MODE_STORAGE_KEY);
    autoresearchModeRef.current = false;
    setAutoresearchMode(false);
    setAutoresearchCandidate(null);
    setAutoresearchRunId(null);
    setAutoresearchLayoutReady(false);
    setActiveView("design");
    setComparisonActive(false);
    setPlacementNotice("Archived policy copied into this editable workspace.");
  }, [autoresearchLayoutReady, shadeCanopyIcons, simulationResult, solarCanopyIcons]);

  const selectAutoresearchAoi = useCallback((aoi: string) => {
    if (!/^[a-z0-9_]+$/.test(aoi) || aoi === ACTIVE_AOI) return;
    localStorage.setItem(STUDY_AREA_STORAGE_KEY, aoi);
    window.location.reload();
  }, []);

  useEffect(() => {
    if (autoresearchMode && !autoresearchCandidate && !autoresearchLayoutReady) {
      clearAutoresearchLayout(null, null);
    }
  }, [autoresearchCandidate, autoresearchLayoutReady, autoresearchMode, clearAutoresearchLayout]);

  useEffect(() => {
    fetch(`${dataRoot}/manifest.json`)
      .then((response) => {
        if (!response.ok) throw new Error("Study-area layer manifest is unavailable");
        return response.json();
      })
      .then((loaded: Manifest) => {
        strictWorkspaceSanitized.current = false;
        setManifest(loaded);
        if (autoresearchModeRef.current) return;
        setReflectiveMask(loadRasterMask(REFLECTIVE_STORAGE_KEY, loaded.width, loaded.height));
        setCoolRoofMask(loadRasterMask(COOL_ROOF_STORAGE_KEY, loaded.width, loaded.height));
        setGreenRoofMask(loadRasterMask(GREEN_ROOF_STORAGE_KEY, loaded.width, loaded.height));
        setDepavedMask(loadRasterMask(DEPAVED_STORAGE_KEY, loaded.width, loaded.height));
        setShadeCanopyMask(loadRasterMask(SHADE_CANOPY_STORAGE_KEY, loaded.width, loaded.height));
        setSolarCanopyMask(loadRasterMask(SOLAR_CANOPY_STORAGE_KEY, loaded.width, loaded.height));
      })
      .catch(() => setManifest(null));
  }, [dataRoot]);

  useEffect(() => {
    setSolweigBaseline(null);
    setBaselineLoadState("loading");
    const cached = loadBaselineCache()[baselineCacheKey(scenario, "07-27", simulationHour)];
    if (cached?.physics_version === SOLWEIG_PHYSICS_VERSION) {
      setSolweigBaseline(cached);
      setBaselineLoadState("ready");
    } else {
      setBaselineLoadState("missing");
    }
  }, [scenario, simulationHour]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setPlacementMaskStatus("loading");
    Promise.all([
      loadPlacementMask(`${dataRoot}/${manifest.layers?.tree_placement_mask ?? "tree_placement_mask.png"}`),
      loadPlacementMask(`${dataRoot}/${manifest.layers?.tree_small_placeable_mask ?? "placeable_tree_small.png"}`),
      loadPlacementMask(`${dataRoot}/${manifest.layers?.tree_medium_placeable_mask ?? "placeable_tree_medium.png"}`),
    ]).then(([physical, small, medium]) => {
      if (cancelled) return;
      setPlacementMask(physical);
      setTreePlaceableMasks({ small, medium });
      setPlacementMaskStatus("ready");
    }).catch(() => {
      if (!cancelled) setPlacementMaskStatus("error");
    });
    return () => { cancelled = true; };
  }, [manifest, dataRoot]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setDepavableMaskStatus("loading");
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) { setDepavableMaskStatus("error"); return; }
      context.drawImage(image, 0, 0);
      const loaded = { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
      setDepavableMask(loaded);
      setDepavedMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const x = pixel % current.width;
          const y = Math.floor(pixel / current.width);
          const maskX = Math.min(loaded.width - 1, Math.floor(((x + 0.5) / current.width) * loaded.width));
          const maskY = Math.min(loaded.height - 1, Math.floor(((y + 0.5) / current.height) * loaded.height));
          if (loaded.pixels[(maskY * loaded.width + maskX) * 4] >= 128) count += 1;
          else { writeMaskPixel(bits, pixel, false); removed += 1; }
        }
        const next = removed || count !== current.count ? { ...current, bits, count } : current;
        depavedMaskRef.current = next;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved grass pixel${removed === 1 ? "" : "s"} outside eligible non-road pavement.`);
        return next;
      });
      setShadeCanopyMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const x = pixel % current.width;
          const y = Math.floor(pixel / current.width);
          const maskX = Math.min(loaded.width - 1, Math.floor(((x + 0.5) / current.width) * loaded.width));
          const maskY = Math.min(loaded.height - 1, Math.floor(((y + 0.5) / current.height) * loaded.height));
          if (loaded.pixels[(maskY * loaded.width + maskX) * 4] >= 128) count += 1;
          else { writeMaskPixel(bits, pixel, false); removed += 1; }
        }
        const next = removed || count !== current.count ? { ...current, bits, count } : current;
        shadeCanopyMaskRef.current = next;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved canopy pixel${removed === 1 ? "" : "s"} outside eligible non-road pavement.`);
        return next;
      });
      setSolarCanopyMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const x = pixel % current.width;
          const y = Math.floor(pixel / current.width);
          const maskX = Math.min(loaded.width - 1, Math.floor(((x + 0.5) / current.width) * loaded.width));
          const maskY = Math.min(loaded.height - 1, Math.floor(((y + 0.5) / current.height) * loaded.height));
          if (loaded.pixels[(maskY * loaded.width + maskX) * 4] >= 128) count += 1;
          else { writeMaskPixel(bits, pixel, false); removed += 1; }
        }
        const next = removed || count !== current.count ? { ...current, bits, count } : current;
        solarCanopyMaskRef.current = next;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved solar-canopy pixel${removed === 1 ? "" : "s"} outside eligible non-road pavement.`);
        return next;
      });
      setDepavableMaskStatus("ready");
    };
    image.onerror = () => { if (!cancelled) setDepavableMaskStatus("error"); };
    image.src = `${dataRoot}/${manifest.layers?.depavable_mask ?? "depavable_mask.png"}`;
    return () => { cancelled = true; };
  }, [manifest, dataRoot]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    Promise.all([
      loadPlacementMask(`${dataRoot}/${manifest.layers?.shade_canopy_placeable_mask ?? "placeable_shade_canopy.png"}`),
      loadPlacementMask(`${dataRoot}/${manifest.layers?.solar_canopy_placeable_mask ?? "placeable_solar_canopy.png"}`),
    ]).then(([shade, solar]) => {
      if (cancelled) return;
      setShadeCanopyPlaceableMask(shade);
      setSolarCanopyPlaceableMask(solar);
      const sanitize = (
        current: RasterMask,
        allowed: PlacementMask,
        conflict?: RasterMask,
      ) => {
        const bits = current.bits.slice();
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const point = { x: (pixel % current.width) + 0.5, y: Math.floor(pixel / current.width) + 0.5 };
          const valid = placementMaskHasPoint(allowed, point, current.width, current.height);
          if (valid && (!conflict || !hasMaskPixel(conflict, pixel))) continue;
          writeMaskPixel(bits, pixel, false);
          removed += 1;
        }
        return removed ? { ...current, bits, count: current.count - removed } : current;
      };
      setShadeCanopyMask((current) => {
        const next = sanitize(current, shade);
        shadeCanopyMaskRef.current = next;
        if (next !== current) setPlacementNotice(`Removed ${(current.count - next.count).toLocaleString()} saved shade-canopy pixels that fail strict siting rules.`);
        return next;
      });
      setSolarCanopyMask((current) => {
        const next = sanitize(current, solar, shadeCanopyMaskRef.current);
        solarCanopyMaskRef.current = next;
        if (next !== current) setPlacementNotice(`Removed ${(current.count - next.count).toLocaleString()} saved PV-canopy pixels that fail strict siting or overlap shade canopy.`);
        return next;
      });
    }).catch(() => {
      if (!cancelled) setDepavableMaskStatus("error");
    });
    return () => { cancelled = true; };
  }, [manifest, dataRoot]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setRoofRegionsStatus("loading");
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        setRoofRegionsStatus("error");
        return;
      }
      context.drawImage(image, 0, 0);
      const loadedRoofRegions = { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
      const pixelsByRegion = new globalThis.Map<number, number[]>();
      for (let pixel = 0; pixel < loadedRoofRegions.width * loadedRoofRegions.height; pixel += 1) {
        const offset = pixel * 4;
        const regionId = loadedRoofRegions.pixels[offset]
          | (loadedRoofRegions.pixels[offset + 1] << 8)
          | (loadedRoofRegions.pixels[offset + 2] << 16);
        if (!regionId) continue;
        const pixels = pixelsByRegion.get(regionId);
        if (pixels) pixels.push(pixel);
        else pixelsByRegion.set(regionId, [pixel]);
      }
      roofPixelsByRegionRef.current = pixelsByRegion;
      setRoofRegions(loadedRoofRegions);
      setCoolRoofMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const offset = pixel * 4;
          const regionId = loadedRoofRegions.pixels[offset]
            | (loadedRoofRegions.pixels[offset + 1] << 8)
            | (loadedRoofRegions.pixels[offset + 2] << 16);
          if (regionId) { count += 1; continue; }
          writeMaskPixel(bits, pixel, false);
          removed += 1;
        }
        if (!removed && count === current.count) return current;
        const sanitized = { ...current, bits, count };
        coolRoofMaskRef.current = sanitized;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved cool-roof pixel${removed === 1 ? "" : "s"} outside buildings.`);
        return sanitized;
      });
      setGreenRoofMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const offset = pixel * 4;
          const regionId = loadedRoofRegions.pixels[offset]
            | (loadedRoofRegions.pixels[offset + 1] << 8)
            | (loadedRoofRegions.pixels[offset + 2] << 16);
          if (regionId) { count += 1; continue; }
          writeMaskPixel(bits, pixel, false);
          removed += 1;
        }
        if (!removed && count === current.count) return current;
        const sanitized = { ...current, bits, count };
        greenRoofMaskRef.current = sanitized;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved green-roof pixel${removed === 1 ? "" : "s"} outside buildings.`);
        return sanitized;
      });
      setRoofRegionsStatus("ready");
    };
    image.onerror = () => { if (!cancelled) setRoofRegionsStatus("error"); };
    image.src = `${dataRoot}/${manifest.layers?.roof_regions ?? "roof_regions.png"}`;
    return () => { cancelled = true; };
  }, [manifest, dataRoot]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setPavementMaskStatus("loading");
    const pavementImage = new Image();
    pavementImage.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = pavementImage.naturalWidth;
      canvas.height = pavementImage.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        setPavementMaskStatus("error");
        return;
      }
      context.drawImage(pavementImage, 0, 0);
      const loadedPavementMask = {
        width: canvas.width,
        height: canvas.height,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
      setPavementMask(loadedPavementMask);
      setReflectiveMask((current) => {
        const bits = current.bits.slice();
        let count = 0;
        let removed = 0;
        for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
          if (!hasMaskPixel(current, pixel)) continue;
          const x = pixel % current.width;
          const y = Math.floor(pixel / current.width);
          const maskX = Math.min(
            loadedPavementMask.width - 1,
            Math.floor(((x + 0.5) / current.width) * loadedPavementMask.width),
          );
          const maskY = Math.min(
            loadedPavementMask.height - 1,
            Math.floor(((y + 0.5) / current.height) * loadedPavementMask.height),
          );
          if (loadedPavementMask.pixels[(maskY * loadedPavementMask.width + maskX) * 4] >= 128) {
            count += 1;
            continue;
          }
          writeMaskPixel(bits, pixel, false);
          removed += 1;
        }
        if (!removed && count === current.count) return current;
        const sanitized = { ...current, bits, count };
        reflectiveMaskRef.current = sanitized;
        if (removed) setPlacementNotice(`Corrected ${removed.toLocaleString()} saved coating pixel${removed === 1 ? "" : "s"} outside pavement.`);
        return sanitized;
      });
      setPavementMaskStatus("ready");
    };
    pavementImage.onerror = () => { if (!cancelled) setPavementMaskStatus("error"); };
    pavementImage.src = `${dataRoot}/${manifest.layers?.pavement_mask ?? "pavement_mask.png"}`;

    fetch(`${dataRoot}/${manifest.layers?.street_segments ?? "street_segments.json"}`)
      .then((response) => {
        if (!response.ok) throw new Error("Street segments unavailable");
        return response.json();
      })
      .then((value: { segments?: StreetSegment[] }) => { if (!cancelled) setStreetSegments(value.segments ?? []); })
      .catch(() => { if (!cancelled) setStreetSegments([]); });
    return () => { cancelled = true; };
  }, [manifest, dataRoot]);

  useEffect(() => {
    treesRef.current = trees;
    if (autoresearchModeRef.current) return;
    if (trees.length) localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(trees));
    else localStorage.removeItem(TREE_STORAGE_KEY);
  }, [trees]);

  useEffect(() => {
    if (
      autoresearchModeRef.current
      ||
      strictWorkspaceSanitized.current
      || !manifest
      || !placementMask
      || !treePlaceableMasks.small
      || !treePlaceableMasks.medium
      || !shadeCanopyPlaceableMask
      || !solarCanopyPlaceableMask
      || pavementMaskStatus !== "ready"
      || depavableMaskStatus !== "ready"
      || roofRegionsStatus !== "ready"
    ) return;
    strictWorkspaceSanitized.current = true;

    const acceptedTrees: TreeIntervention[] = [];
    const occupiedPixels = new Set<number>();
    let removedTrees = 0;
    for (const tree of treesRef.current) {
      const strictMask = treePlaceableMasks[tree.size];
      const col = Math.floor(tree.x);
      const row = Math.floor(tree.y);
      const pixel = row * manifest.width + col;
      if (!strictMask || !placementMaskHasPoint(strictMask, tree, manifest.width, manifest.height) || occupiedPixels.has(pixel)) {
        removedTrees += 1;
        continue;
      }
      occupiedPixels.add(pixel);
      acceptedTrees.push(tree);
    }
    if (removedTrees) {
      treesRef.current = acceptedTrees;
      setTrees(acceptedTrees);
    }

    const clearPixels = (current: RasterMask, forbidden: Set<number>) => {
      const bits = current.bits.slice();
      let removed = 0;
      for (const pixel of forbidden) {
        if (!hasMaskPixel(current, pixel)) continue;
        writeMaskPixel(bits, pixel, false);
        removed += 1;
      }
      return removed ? { ...current, bits, count: current.count - removed } : current;
    };
    const clearMaskOverlap = (current: RasterMask, conflict: RasterMask) => {
      const bits = current.bits.slice();
      let removed = 0;
      for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
        if (!hasMaskPixel(current, pixel) || !hasMaskPixel(conflict, pixel)) continue;
        writeMaskPixel(bits, pixel, false);
        removed += 1;
      }
      return { mask: removed ? { ...current, bits, count: current.count - removed } : current, removed };
    };

    // Preserve existing trees, reflective pavement, cool roofs, and fabric
    // canopies when repairing legacy same-layer conflicts.
    const depavedRepair = clearMaskOverlap(depavedMaskRef.current, reflectiveMaskRef.current);
    const depaved = depavedRepair.mask;
    if (depaved !== depavedMaskRef.current) {
      depavedMaskRef.current = depaved;
      setDepavedMask(depaved);
    }
    const greenRepair = clearMaskOverlap(greenRoofMaskRef.current, coolRoofMaskRef.current);
    const green = greenRepair.mask;
    if (green !== greenRoofMaskRef.current) {
      greenRoofMaskRef.current = green;
      setGreenRoofMask(green);
    }
    const solarForbidden = new Set(occupiedPixels);
    for (let pixel = 0; pixel < shadeCanopyMaskRef.current.width * shadeCanopyMaskRef.current.height; pixel += 1) {
      if (hasMaskPixel(shadeCanopyMaskRef.current, pixel)) solarForbidden.add(pixel);
    }
    const solarBefore = solarCanopyMaskRef.current;
    const solar = clearPixels(solarBefore, solarForbidden);
    if (solar !== solarCanopyMaskRef.current) {
      solarCanopyMaskRef.current = solar;
      setSolarCanopyMask(solar);
    }
    const shadeBefore = shadeCanopyMaskRef.current;
    const shade = clearPixels(shadeBefore, occupiedPixels);
    if (shade !== shadeCanopyMaskRef.current) {
      shadeCanopyMaskRef.current = shade;
      setShadeCanopyMask(shade);
    }

    const repairedPixels = depavedRepair.removed
      + greenRepair.removed
      + (solarBefore.count - solar.count)
      + (shadeBefore.count - shade.count);
    if (removedTrees || repairedPixels) {
      setPlacementNotice(`Strict feasibility repaired ${removedTrees} tree${removedTrees === 1 ? "" : "s"}${repairedPixels ? ` and ${repairedPixels.toLocaleString()} conflicting pixels` : ""} from the saved layout.`);
    }
  }, [manifest, placementMask, treePlaceableMasks, shadeCanopyPlaceableMask, solarCanopyPlaceableMask, pavementMaskStatus, depavableMaskStatus, roofRegionsStatus]);

  useEffect(() => {
    const count = countMaskPixels(reflectiveMask.bits, reflectiveMask.width, reflectiveMask.height);
    if (count !== reflectiveMask.count) {
      const normalized = { ...reflectiveMask, count };
      reflectiveMaskRef.current = normalized;
      setReflectiveMask(normalized);
      return;
    }
    reflectiveMaskRef.current = reflectiveMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(REFLECTIVE_STORAGE_KEY, reflectiveMask);
  }, [reflectiveMask]);

  useEffect(() => {
    const count = countMaskPixels(depavedMask.bits, depavedMask.width, depavedMask.height);
    if (count !== depavedMask.count) {
      const normalized = { ...depavedMask, count };
      depavedMaskRef.current = normalized;
      setDepavedMask(normalized);
      return;
    }
    depavedMaskRef.current = depavedMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(DEPAVED_STORAGE_KEY, depavedMask);
  }, [depavedMask]);

  useEffect(() => {
    const count = countMaskPixels(shadeCanopyMask.bits, shadeCanopyMask.width, shadeCanopyMask.height);
    if (count !== shadeCanopyMask.count) {
      const normalized = { ...shadeCanopyMask, count };
      shadeCanopyMaskRef.current = normalized;
      setShadeCanopyMask(normalized);
      return;
    }
    shadeCanopyMaskRef.current = shadeCanopyMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(SHADE_CANOPY_STORAGE_KEY, shadeCanopyMask);
  }, [shadeCanopyMask]);

  useEffect(() => {
    if (autoresearchModeRef.current) return;
    if (shadeCanopyIcons.length) localStorage.setItem(SHADE_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(shadeCanopyIcons));
    else localStorage.removeItem(SHADE_CANOPY_ICONS_STORAGE_KEY);
  }, [shadeCanopyIcons]);

  useEffect(() => {
    if (!shadeCanopyPixelCount || shadeCanopyIcons.length) return;
    const blocked = new Uint8Array(shadeCanopyMask.width * shadeCanopyMask.height);
    const generated: ShadeCanopyIcon[] = [];
    const radius = SHADE_CANOPY_ICON_SPACING_M / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    for (let pixel = 0; pixel < shadeCanopyMask.width * shadeCanopyMask.height; pixel += 1) {
      if (blocked[pixel] || !hasMaskPixel(shadeCanopyMask, pixel)) continue;
      const x = pixel % shadeCanopyMask.width;
      const y = Math.floor(pixel / shadeCanopyMask.width);
      generated.push({ id: crypto.randomUUID(), x, y, angle: 0 });
      const minX = Math.max(0, Math.floor(x - radius));
      const maxX = Math.min(shadeCanopyMask.width - 1, Math.ceil(x + radius));
      const minY = Math.max(0, Math.floor(y - radius));
      const maxY = Math.min(shadeCanopyMask.height - 1, Math.ceil(y + radius));
      for (let blockY = minY; blockY <= maxY; blockY += 1) for (let blockX = minX; blockX <= maxX; blockX += 1) {
        if ((blockX - x) ** 2 + (blockY - y) ** 2 <= radius ** 2) blocked[blockY * shadeCanopyMask.width + blockX] = 1;
      }
    }
    setShadeCanopyIcons(generated);
  }, [shadeCanopyPixelCount, shadeCanopyIcons.length, shadeCanopyMask, manifest?.resolution_m]);

  useEffect(() => {
    const count = countMaskPixels(solarCanopyMask.bits, solarCanopyMask.width, solarCanopyMask.height);
    if (count !== solarCanopyMask.count) {
      const normalized = { ...solarCanopyMask, count };
      solarCanopyMaskRef.current = normalized;
      setSolarCanopyMask(normalized);
      return;
    }
    solarCanopyMaskRef.current = solarCanopyMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(SOLAR_CANOPY_STORAGE_KEY, solarCanopyMask);
  }, [solarCanopyMask]);

  useEffect(() => {
    if (autoresearchModeRef.current) return;
    if (solarCanopyIcons.length) localStorage.setItem(SOLAR_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(solarCanopyIcons));
    else localStorage.removeItem(SOLAR_CANOPY_ICONS_STORAGE_KEY);
  }, [solarCanopyIcons]);

  useEffect(() => {
    if (!placementMask || !depavableMask || !manifest) return;
    const keepEligibleIcons = (icons: ShadeCanopyIcon[]) => icons.filter((icon) => canopyIconIsNearEligibleGround(
      icon,
      placementMask,
      depavableMask,
      manifest.width,
      manifest.height,
      manifest.resolution_m,
    ));
    setShadeCanopyIcons((current) => {
      const eligible = keepEligibleIcons(current);
      return eligible.length === current.length ? current : eligible;
    });
    setSolarCanopyIcons((current) => {
      const eligible = keepEligibleIcons(current);
      return eligible.length === current.length ? current : eligible;
    });
  }, [placementMask, depavableMask, manifest]);

  useEffect(() => {
    if (!solarCanopyPixelCount || solarCanopyIcons.length) return;
    const blocked = new Uint8Array(solarCanopyMask.width * solarCanopyMask.height);
    const generated: ShadeCanopyIcon[] = [];
    const radius = SHADE_CANOPY_ICON_SPACING_M / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    for (let pixel = 0; pixel < solarCanopyMask.width * solarCanopyMask.height; pixel += 1) {
      if (blocked[pixel] || !hasMaskPixel(solarCanopyMask, pixel)) continue;
      const x = pixel % solarCanopyMask.width;
      const y = Math.floor(pixel / solarCanopyMask.width);
      generated.push({ id: crypto.randomUUID(), x, y, angle: 0 });
      const minX = Math.max(0, Math.floor(x - radius));
      const maxX = Math.min(solarCanopyMask.width - 1, Math.ceil(x + radius));
      const minY = Math.max(0, Math.floor(y - radius));
      const maxY = Math.min(solarCanopyMask.height - 1, Math.ceil(y + radius));
      for (let blockY = minY; blockY <= maxY; blockY += 1) for (let blockX = minX; blockX <= maxX; blockX += 1) {
        if ((blockX - x) ** 2 + (blockY - y) ** 2 <= radius ** 2) blocked[blockY * solarCanopyMask.width + blockX] = 1;
      }
    }
    setSolarCanopyIcons(generated);
  }, [solarCanopyPixelCount, solarCanopyIcons.length, solarCanopyMask, manifest?.resolution_m]);

  useEffect(() => {
    const count = countMaskPixels(coolRoofMask.bits, coolRoofMask.width, coolRoofMask.height);
    if (count !== coolRoofMask.count) {
      const normalized = { ...coolRoofMask, count };
      coolRoofMaskRef.current = normalized;
      setCoolRoofMask(normalized);
      return;
    }
    coolRoofMaskRef.current = coolRoofMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(COOL_ROOF_STORAGE_KEY, coolRoofMask);
  }, [coolRoofMask]);

  useEffect(() => {
    const count = countMaskPixels(greenRoofMask.bits, greenRoofMask.width, greenRoofMask.height);
    if (count !== greenRoofMask.count) {
      const normalized = { ...greenRoofMask, count };
      greenRoofMaskRef.current = normalized;
      setGreenRoofMask(normalized);
      return;
    }
    greenRoofMaskRef.current = greenRoofMask;
    if (autoresearchModeRef.current) return;
    storeRasterMask(GREEN_ROOF_STORAGE_KEY, greenRoofMask);
  }, [greenRoofMask]);

  useEffect(() => {
    fetch(`/api/solweig/availability?aoi=${encodeURIComponent(ACTIVE_AOI)}`)
      .then((response) => response.json())
      .then((availability) => {
        setSimulationReady(Boolean(availability.ready));
        setSimulationChecked(true);
        if (availability.active_job_id) {
          setSimulationJob({ id: availability.active_job_id, state: "running", stage: "Reconnecting to simulation", progress: 0 });
        }
      })
      .catch(() => {
        setSimulationReady(false);
        setSimulationChecked(true);
      });
  }, []);

  useEffect(() => {
    fetch(`/api/scoring/availability?aoi=${encodeURIComponent(ACTIVE_AOI)}`)
      .then((response) => response.json())
      .then((availability) => {
        setPolicyScoringReady(Boolean(availability.ready));
        setPolicyScoringChecked(true);
        if (availability.active_job_id) {
          setPolicyScoreJob({ id: availability.active_job_id, state: "running", stage: "Reconnecting to policy score", progress: 0 });
        }
      })
      .catch(() => {
        setPolicyScoringReady(false);
        setPolicyScoringChecked(true);
      });
  }, []);

  useEffect(() => {
    if (!simulationJob || !["queued", "running"].includes(simulationJob.state)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/solweig/status/${simulationJob.id}`);
        if (!response.ok) throw new Error("Unable to read simulation progress");
        const status = await response.json() as SimulationJob;
        if (cancelled) return;
        setSimulationJob(status);
        if (status.state === "complete" && status.result) {
          if (status.result.kind === "baseline") {
            setSolweigBaseline(status.result.baseline);
            storeBaseline(status.result.baseline);
            setBaselineLoadState("ready");
          } else {
            setSimulationResult(status.result);
            if (!autoresearchModeRef.current) localStorage.setItem(SIMULATION_STORAGE_KEY, JSON.stringify(status.result));
            setSimulationSetupOpen(false);
          }
          setSimulationError(null);
        } else if (status.state === "failed") {
          if (status.mode === "baseline") setBaselineLoadState("error");
          setSimulationError(status.error ?? "SOLWEIG did not complete.");
        }
      } catch (error) {
        if (!cancelled) setSimulationError(error instanceof Error ? error.message : "Unable to read simulation progress");
      }
    };
    poll();
    const interval = window.setInterval(poll, 1200);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [simulationJob?.id, simulationJob?.state]);

  useEffect(() => {
    if (!policyScoreJob || !["queued", "running"].includes(policyScoreJob.state)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/scoring/status/${policyScoreJob.id}`);
        if (!response.ok) throw new Error("Unable to read policy scoring progress");
        const status = await response.json() as PolicyScoreJob;
        if (cancelled) return;
        setPolicyScoreJob(status);
        if (status.state === "complete" && status.result) {
          setPolicyScore(status.result);
          localStorage.setItem(POLICY_SCORE_STORAGE_KEY, JSON.stringify(status.result));
          setPolicyScoreError(null);
        } else if (status.state === "failed") {
          setPolicyScoreError(status.error ?? "Policy scoring did not complete.");
        }
      } catch (error) {
        if (!cancelled) setPolicyScoreError(error instanceof Error ? error.message : "Unable to read policy scoring progress");
      }
    };
    poll();
    const interval = window.setInterval(poll, 1200);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [policyScoreJob?.id, policyScoreJob?.state]);

  useEffect(() => {
    if (!placementNotice) return;
    const timeout = window.setTimeout(() => setPlacementNotice(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [placementNotice]);

  useEffect(() => {
    if (designIntervention === "solar_canopy") return;
    setSolarCanopySegmentMode(false);
    setSolarCanopyBrushMode(false);
    setSolarCanopyEraseMode(false);
    setSolarCanopyEraseBox(null);
    setSolarCanopyCursor(null);
  }, [designIntervention]);

  useEffect(() => {
    if (!trees.length && !reflectivePixelCount && !coolRoofPixelCount && !greenRoofPixelCount && !depavedPixelCount && !shadeCanopyPixelCount && !solarCanopyPixelCount) {
      setComparisonActive(false);
    }
  }, [trees.length, reflectivePixelCount, coolRoofPixelCount, greenRoofPixelCount, depavedPixelCount, shadeCanopyPixelCount, solarCanopyPixelCount]);

  useEffect(() => {
    const deleteSelected = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "Escape") {
        setResetConfirmOpen(false);
        setPlacementMode(false);
        setBrushMode(false);
        setBrushCursor(null);
        setRemovalMode(false);
        setRemovalBox(null);
        setReflectiveBrushMode(false);
        setReflectiveSegmentMode(false);
        setReflectiveEraseMode(false);
        setReflectiveEraseBox(null);
        setReflectiveCursor(null);
        setDepaveBrushMode(false);
        setDepaveBoxMode(false);
        setDepaveEraseMode(false);
        setDepaveBox(null);
        setDepaveCursor(null);
        setShadeCanopySegmentMode(false);
        setShadeCanopyBrushMode(false);
        setShadeCanopyEraseMode(false);
        setShadeCanopyEraseBox(null);
        setShadeCanopyCursor(null);
        setSolarCanopySegmentMode(false);
        setSolarCanopyBrushMode(false);
        setSolarCanopyEraseMode(false);
        setSolarCanopyEraseBox(null);
        setSolarCanopyCursor(null);
        setCoolRoofClickMode(false);
        setCoolRoofBrushMode(false);
        setCoolRoofBoxMode(false);
        setCoolRoofEraseMode(false);
        setCoolRoofBox(null);
        setCoolRoofCursor(null);
        return;
      }
      if (!selectedTreeId || !["Delete", "Backspace"].includes(event.key) || target.matches("input, select, textarea")) return;
      const removed = trees.filter((tree) => tree.id === selectedTreeId);
      if (removed.length) setActionHistory((current) => [...current, { type: "remove", trees: removed }]);
      setTrees((current) => current.filter((tree) => tree.id !== selectedTreeId));
      setSelectedTreeId(null);
    };
    window.addEventListener("keydown", deleteSelected);
    return () => window.removeEventListener("keydown", deleteSelected);
  }, [selectedTreeId, trees]);

  const selectedTree = trees.find((tree) => tree.id === selectedTreeId) ?? null;
  const lastAction = actionHistory[actionHistory.length - 1] ?? null;
  const activeRoofKind: RoofKind = designIntervention === "green_roof" ? "green_roof" : "cool_roof";
  const activeRoofLabel = activeRoofKind === "green_roof" ? "green roof" : "cool roof";
  const reflectiveMaskEncoded = useMemo(() => encodeMaskBits(reflectiveMask.bits), [reflectiveMask.bits]);
  const coolRoofMaskEncoded = useMemo(() => encodeMaskBits(coolRoofMask.bits), [coolRoofMask.bits]);
  const greenRoofMaskEncoded = useMemo(() => encodeMaskBits(greenRoofMask.bits), [greenRoofMask.bits]);
  const depavedMaskEncoded = useMemo(() => encodeMaskBits(depavedMask.bits), [depavedMask.bits]);
  const shadeCanopyMaskEncoded = useMemo(() => encodeMaskBits(shadeCanopyMask.bits), [shadeCanopyMask.bits]);
  const solarCanopyMaskEncoded = useMemo(() => encodeMaskBits(solarCanopyMask.bits), [solarCanopyMask.bits]);
  const policyLayoutSignature = useMemo(() => compactFingerprint([
    treeSignature(trees),
    reflectiveMaskEncoded,
    coolRoofMaskEncoded,
    greenRoofMaskEncoded,
    depavedMaskEncoded,
    shadeCanopyMaskEncoded,
    solarCanopyMaskEncoded,
  ].join("|")), [trees, reflectiveMaskEncoded, coolRoofMaskEncoded, greenRoofMaskEncoded, depavedMaskEncoded, shadeCanopyMaskEncoded, solarCanopyMaskEncoded]);
  const simulationReflectiveMask = useMemo(() => {
    const snapshot = simulationResult?.reflective_snapshot;
    if (!snapshot) return emptyRasterMask(reflectiveMask.width, reflectiveMask.height);
    const bits = decodeMaskBits(snapshot.data);
    return { width: snapshot.width, height: snapshot.height, count: countMaskPixels(bits, snapshot.width, snapshot.height), bits };
  }, [simulationResult?.reflective_snapshot, reflectiveMask.width, reflectiveMask.height]);
  const pixelAreaM2 = (count: number) => Math.round(count * (manifest?.resolution_m ?? DEFAULT_RESOLUTION_M) ** 2);
  const reflectiveAreaM2 = pixelAreaM2(reflectivePixelCount);
  const coolRoofAreaM2 = pixelAreaM2(coolRoofPixelCount);
  const greenRoofAreaM2 = pixelAreaM2(greenRoofPixelCount);
  const depavedAreaM2 = pixelAreaM2(depavedPixelCount);
  const shadeCanopyAreaM2 = pixelAreaM2(shadeCanopyPixelCount);
  const solarCanopyAreaM2 = pixelAreaM2(solarCanopyPixelCount);
  const hasInterventions = trees.length > 0 || reflectivePixelCount > 0 || coolRoofPixelCount > 0 || greenRoofPixelCount > 0 || depavedPixelCount > 0 || shadeCanopyPixelCount > 0 || solarCanopyPixelCount > 0;
  const metricDefinition = METRICS[metric];
  const studyAreaPixelCount = Math.max((manifest?.width ?? DEFAULT_GRID_SIZE) * (manifest?.height ?? DEFAULT_GRID_SIZE), 1);
  const metricMeanPixelCount = (selectedMetric: MetricKey) => selectedMetric === "utci"
    ? Math.max(manifest?.summary_masks?.perceived_temperature_pixels ?? studyAreaPixelCount, 1)
    : studyAreaPixelCount;
  const heuristicAreaReduction = (items: TreeIntervention[], selectedMetric: MetricKey) => items.reduce((sum, tree) => {
    const definition = METRICS[selectedMetric];
    const presetDiameter = tree.size === "small" ? 3 : 5;
    const sizeScale = Math.min(1.6, Math.max(0.55, Math.sqrt(tree.crownDiameterM / presetDiameter) * Math.sqrt(tree.heightM / 5)));
    const peak = (tree.size === "small" ? definition.small : definition.medium) * sizeScale;
    const sigma = Math.max(12, tree.crownDiameterM * 3.4) / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    return sum + peak * 2 * Math.PI * sigma * sigma / metricMeanPixelCount(selectedMetric);
  }, 0);
  const reflectiveFastEffect = reflectivePixelCount ? REFLECTIVE_LOCAL_EFFECT[metric] : 0;
  const reflectiveAreaReduction = reflectiveFastEffect * reflectivePixelCount / metricMeanPixelCount(metric);
  const screeningEstimateValue = heuristicAreaReduction(trees, metric) + reflectiveAreaReduction;
  const uncertaintyFraction = 0.4;
  const selectedScenario = SCENARIOS[scenario];
  const selectedTime = TIME_OPTIONS.find((option) => option.hour === simulationHour) ?? TIME_OPTIONS[1];
  const baseWeather = BASELINE_WEATHER[simulationHour];
  const selectedWeather = {
    temperature: baseWeather.temperature + selectedScenario.deltaC,
    humidity: selectedScenario.holdRh || selectedScenario.deltaC === 0
      ? baseWeather.humidity
      : DRY_WARMING_HUMIDITY[selectedScenario.deltaC as 2 | 4][simulationHour],
    wind: baseWeather.wind,
  };
  const simulationMatchesConditions = Boolean(
    simulationResult
    && simulationResult.aoi === ACTIVE_AOI
    && simulationResult.scenario === scenario
    && simulationResult.date === "07-27"
    && simulationResult.hour === simulationHour,
  );
  const baselineMatchesConditions = Boolean(
    solweigBaseline
    && solweigBaseline.aoi === ACTIVE_AOI
    && solweigBaseline.scenario === scenario
    && solweigBaseline.date === "07-27"
    && solweigBaseline.hour === simulationHour,
  );
  const simulationSupportsMetric = Boolean(
    simulationResult
    && simulationResult.physics_version === SOLWEIG_PHYSICS_VERSION
    && simulationMatchesConditions
    && metric !== "surface",
  );
  const baselineSupportsMetric = Boolean(solweigBaseline && baselineMatchesConditions && metric !== "surface");
  const emptyReflectiveMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(reflectiveMask.bits.length)), [reflectiveMask.bits.length]);
  const emptyCoolRoofMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(coolRoofMask.bits.length)), [coolRoofMask.bits.length]);
  const emptyGreenRoofMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(greenRoofMask.bits.length)), [greenRoofMask.bits.length]);
  const emptyDepavedMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(depavedMask.bits.length)), [depavedMask.bits.length]);
  const emptyShadeCanopyMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(shadeCanopyMask.bits.length)), [shadeCanopyMask.bits.length]);
  const emptySolarCanopyMaskEncoded = useMemo(() => encodeMaskBits(new Uint8Array(solarCanopyMask.bits.length)), [solarCanopyMask.bits.length]);
  const reflectiveMatchesSimulation = Boolean(
    simulationResult
    && reflectiveMaskEncoded === (simulationResult.reflective_snapshot?.data ?? emptyReflectiveMaskEncoded),
  );
  const coolRoofMatchesSimulation = Boolean(
    simulationResult
    && coolRoofMaskEncoded === (simulationResult.cool_roof_snapshot?.data ?? emptyCoolRoofMaskEncoded),
  );
  const greenRoofMatchesSimulation = Boolean(
    simulationResult
    && greenRoofMaskEncoded === (simulationResult.green_roof_snapshot?.data ?? emptyGreenRoofMaskEncoded),
  );
  const depavedMatchesSimulation = Boolean(
    simulationResult
    && depavedMaskEncoded === (simulationResult.depaved_pavement_snapshot?.data ?? emptyDepavedMaskEncoded),
  );
  const shadeCanopyMatchesSimulation = Boolean(
    simulationResult
    && shadeCanopyMaskEncoded === (simulationResult.shade_canopy_snapshot?.data ?? emptyShadeCanopyMaskEncoded),
  );
  const solarCanopyMatchesSimulation = Boolean(
    simulationResult
    && solarCanopyMaskEncoded === (simulationResult.solar_canopy_snapshot?.data ?? emptySolarCanopyMaskEncoded),
  );
  const simulationMatchesLayout = Boolean(
    simulationSupportsMetric
    && simulationResult
    && treeSignature(trees) === treeSignature(simulationResult.tree_snapshot)
    && reflectiveMatchesSimulation
    && coolRoofMatchesSimulation
    && greenRoofMatchesSimulation
    && depavedMatchesSimulation
    && shadeCanopyMatchesSimulation
    && solarCanopyMatchesSimulation,
  );
  const simulatedMetric = simulationSupportsMetric && simulationResult ? simulationResult.metrics[metric as "mrt" | "utci"] : null;
  const baselineMetric = baselineSupportsMetric && solweigBaseline ? solweigBaseline.metrics[metric as "mrt" | "utci"] : null;
  const postSimulationDelta = simulatedMetric && simulationResult
    ? heuristicAreaReduction(trees, metric)
      - heuristicAreaReduction(simulationResult.tree_snapshot, metric)
      + reflectiveAreaReduction
      - REFLECTIVE_LOCAL_EFFECT[metric]
        * (simulationResult.reflective_snapshot?.count ?? 0)
        / metricMeanPixelCount(metric)
    : 0;
  const estimateValue = simulatedMetric ? simulatedMetric.study_area_mean_reduction + postSimulationDelta : screeningEstimateValue;
  const deltaBounds = [postSimulationDelta * (1 - uncertaintyFraction), postSimulationDelta * (1 + uncertaintyFraction)];
  const estimateLow = simulatedMetric
    ? simulatedMetric.study_area_mean_reduction + Math.min(...deltaBounds)
    : estimateValue * (1 - uncertaintyFraction);
  const estimateHigh = simulatedMetric
    ? simulatedMetric.study_area_mean_reduction + Math.max(...deltaBounds)
    : estimateValue * (1 + uncertaintyFraction);
  const smallTreeCount = trees.filter((tree) => tree.size === "small").length;
  const mediumTreeCount = trees.length - smallTreeCount;
  const unitCost = (action: PolicyAction) => manifest?.interventions?.[action]?.cost_usd_per_unit ?? FALLBACK_UNIT_COSTS[action];
  const treeCost = { small: unitCost("tree_small"), medium: unitCost("tree_medium") };
  const reflectiveCostEstimate = reflectiveAreaM2 * unitCost("light_road");
  const coolRoofCostEstimate = coolRoofAreaM2 * unitCost("cool_roof");
  const greenRoofCostEstimate = greenRoofAreaM2 * unitCost("green_roof");
  const depavedCostEstimate = depavedAreaM2 * unitCost("grass_conversion");
  const shadeCanopyCostEstimate = shadeCanopyAreaM2 * unitCost("shade_canopy");
  const solarCanopyCostEstimate = solarCanopyAreaM2 * unitCost("solar_canopy");
  const costEstimate = smallTreeCount * treeCost.small + mediumTreeCount * treeCost.medium + reflectiveCostEstimate + coolRoofCostEstimate + greenRoofCostEstimate + depavedCostEstimate + shadeCanopyCostEstimate + solarCanopyCostEstimate;
  const budgetExceeded = costEstimate > policyScoringBudget + 0.000001;
  const workspaceSpend = () => {
    const area = (manifest?.resolution_m ?? DEFAULT_RESOLUTION_M) ** 2;
    return treesRef.current.reduce((sum, tree) => sum + treeCost[tree.size], 0)
      + reflectiveMaskRef.current.count * area * unitCost("light_road")
      + coolRoofMaskRef.current.count * area * unitCost("cool_roof")
      + greenRoofMaskRef.current.count * area * unitCost("green_roof")
      + depavedMaskRef.current.count * area * unitCost("grass_conversion")
      + shadeCanopyMaskRef.current.count * area * unitCost("shade_canopy")
      + solarCanopyMaskRef.current.count * area * unitCost("solar_canopy");
  };
  const costLow = costEstimate * 0.65;
  const costHigh = costEstimate * 1.35;
  const addedCanopyArea = trees.reduce((sum, tree) => sum + Math.PI * (tree.crownDiameterM / 2) ** 2, 0);
  const resultVisible = activeView === "results";
  const resultDataReady = autoresearchMode && hasInterventions
    ? Boolean(simulationMatchesConditions && simulationMatchesLayout)
    : simulationMatchesConditions || baselineMatchesConditions;
  const resultRasterVisible = resultVisible && resultDataReady;
  const autoresearchSimulationFailed = Boolean(autoresearchMode && simulationJob && ["failed", "cancelled"].includes(simulationJob.state));
  const resultsUnavailable = resultVisible && !resultDataReady && simulationChecked && (!simulationReady || baselineLoadState === "error" || autoresearchSimulationFailed);
  const resultsAwaitingSolweig = resultVisible && !resultDataReady && !resultsUnavailable;
  const activeSimulationRunning = Boolean(simulationJob && ["queued", "running"].includes(simulationJob.state));
  const metricDisplayMin = simulatedMetric?.display_min ?? baselineMetric?.display_min ?? manifest?.screening_metrics?.metrics[metric].display_min;
  const metricDisplayMax = simulatedMetric?.display_max ?? baselineMetric?.display_max ?? manifest?.screening_metrics?.metrics[metric].display_max;
  const mapSimulation = metric !== "surface"
    ? simulationSupportsMetric && simulationResult
      ? {
          baselineUrl: simulationResult.files.baseline,
          interventionUrl: simulationResult.files.intervention,
          snapshotTrees: simulationResult.tree_snapshot,
          snapshotReflectiveMask: simulationReflectiveMask,
        }
      : baselineSupportsMetric && solweigBaseline
        ? {
            baselineUrl: solweigBaseline.file,
            interventionUrl: solweigBaseline.file,
            snapshotTrees: [],
            snapshotReflectiveMask: emptyRasterMask(reflectiveMask.width, reflectiveMask.height),
          }
        : null
    : null;
  const baselineConditionKey = `${scenario}:07-27:${simulationHour}`;
  const baselineJobRunning = Boolean(
    simulationJob
    && simulationJob.mode === "baseline"
    && ["queued", "running"].includes(simulationJob.state),
  );
  const resultLoadingProgress = activeSimulationRunning ? simulationJob?.progress ?? 0 : 0;
  const resultLoadingStage = activeSimulationRunning
    ? simulationJob?.stage ?? "Running SOLWEIG"
    : simulationChecked
      ? "Starting SOLWEIG simulation"
      : "Checking the local simulation environment";
  const existingConditionsOnly = Boolean(!hasInterventions && baselineMetric);
  const reflectiveMrtRequiresSimulation = Boolean(metric === "mrt" && reflectivePixelCount && (!simulatedMetric || !reflectiveMatchesSimulation));
  const coolRoofRequiresSimulation = Boolean(coolRoofPixelCount && (!simulatedMetric || !coolRoofMatchesSimulation));
  const greenRoofRequiresSimulation = Boolean(greenRoofPixelCount && (!simulatedMetric || !greenRoofMatchesSimulation));
  const depavedRequiresSimulation = Boolean(depavedPixelCount && (!simulatedMetric || !depavedMatchesSimulation));
  const shadeCanopyRequiresSimulation = Boolean(shadeCanopyPixelCount && (!simulatedMetric || !shadeCanopyMatchesSimulation));
  const solarCanopyRequiresSimulation = Boolean(solarCanopyPixelCount && (!simulatedMetric || !solarCanopyMatchesSimulation));
  const roofRequiresSimulation = coolRoofRequiresSimulation || greenRoofRequiresSimulation;
  const resultRequiresSimulation = reflectiveMrtRequiresSimulation || roofRequiresSimulation || depavedRequiresSimulation || shadeCanopyRequiresSimulation || solarCanopyRequiresSimulation;
  const resultHeroValue = existingConditionsOnly && baselineMetric ? baselineMetric.baseline_mean : estimateValue;
  const policyScoreRunning = Boolean(policyScoreJob && ["queued", "running"].includes(policyScoreJob.state));
  const policyScoreMatchesLayout = Boolean(
    policyScore
    && (autoresearchMode || (policyScore.gui?.layout_signature === policyLayoutSignature
    && policyScore.gui?.aoi === ACTIVE_AOI
    && policyScore.gui?.scenario === scenario
    && policyScore.gui?.budget_usd === policyScoringBudget))
  );

  useEffect(() => {
    if (
      activeView !== "results"
      || !simulationReady
      || baselineLoadState !== "missing"
      || simulationMatchesConditions
      || (simulationJob && ["queued", "running"].includes(simulationJob.state))
      || attemptedBaselines.current.has(baselineConditionKey)
    ) return;

    attemptedBaselines.current.add(baselineConditionKey);
    setBaselineLoadState("loading");
    setSimulationError(null);
    fetch("/api/solweig/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aoi: ACTIVE_AOI, scenario, date: "07-27", hour: simulationHour }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok && !(response.status === 409 && body.id)) {
          throw new Error(body.error ?? "Unable to start the SOLWEIG baseline");
        }
        setSimulationJob({
          id: body.id,
          mode: body.mode ?? "baseline",
          state: body.state ?? "running",
          stage: response.ok ? "Waiting to build baseline" : "Waiting for active SOLWEIG job",
          progress: 0,
        });
      })
      .catch((error) => {
        setBaselineLoadState("error");
        setSimulationError(error instanceof Error ? error.message : "Unable to start the SOLWEIG baseline");
      });
  }, [activeView, baselineConditionKey, baselineLoadState, scenario, simulationHour, simulationReady, simulationJob?.id, simulationJob?.state, simulationMatchesConditions]);

  // The comparison position is stored in raster coordinates, so its screen
  // position follows the same geographic location when the map pans or zooms.
  const comparisonDividerX = camera.x + (MAP_FRAME_LEFT + (comparisonSplit / 100) * MAP_DISPLAY_SIZE) * camera.zoom;
  const comparisonClip = comparisonSplit;

  const formatEstimate = (value: number) => `${value.toFixed(Math.abs(value) < 0.01 ? 3 : Math.abs(value) < 1 ? 2 : 1)}°C`;
  const formatEffect = (reduction: number) => Math.abs(reduction) < 0.0005
    ? "No mean change"
    : `${formatEstimate(Math.abs(reduction))} ${reduction > 0 ? "cooling" : "warming"}`;
  const formatCost = (value: number) => `$${Math.round(value).toLocaleString()}`;
  const formatUnitCost = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
  const changedSinceSimulation = simulationResult ? (() => {
    const previous = new globalThis.Map(simulationResult.tree_snapshot.map((tree) => [tree.id, tree]));
    const current = new globalThis.Map(trees.map((tree) => [tree.id, tree]));
    const treeChanges = [...new Set([...previous.keys(), ...current.keys()])].filter((id) => {
      const before = previous.get(id);
      const after = current.get(id);
      return !before || !after || treeSignature([before]) !== treeSignature([after]);
    }).length;
    const pavementChanged = !reflectiveMatchesSimulation;
    const coolRoofsChanged = !coolRoofMatchesSimulation;
    const greenRoofsChanged = !greenRoofMatchesSimulation;
    const depavingChanged = !depavedMatchesSimulation;
    const shadeCanopyChanged = !shadeCanopyMatchesSimulation;
    const solarCanopyChanged = !solarCanopyMatchesSimulation;
    return treeChanges + (pavementChanged ? 1 : 0) + (coolRoofsChanged ? 1 : 0) + (greenRoofsChanged ? 1 : 0) + (depavingChanged ? 1 : 0) + (shadeCanopyChanged ? 1 : 0) + (solarCanopyChanged ? 1 : 0);
  })() : 0;

  const startFullSimulation = async () => {
    if (!hasInterventions || !simulationReady || simulationJob?.state === "running" || simulationJob?.state === "queued") return;
    setSimulationError(null);
    try {
      const response = await fetch("/api/solweig/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aoi: ACTIVE_AOI,
          trees,
          reflective_pavement: {
            width: reflectiveMask.width,
            height: reflectiveMask.height,
            count: reflectivePixelCount,
            data: reflectiveMaskEncoded,
          },
          cool_roof: {
            width: coolRoofMask.width,
            height: coolRoofMask.height,
            count: coolRoofPixelCount,
            data: coolRoofMaskEncoded,
          },
          green_roof: {
            width: greenRoofMask.width,
            height: greenRoofMask.height,
            count: greenRoofPixelCount,
            data: greenRoofMaskEncoded,
          },
          depaved_pavement: {
            width: depavedMask.width,
            height: depavedMask.height,
            count: depavedPixelCount,
            data: depavedMaskEncoded,
          },
          shade_canopy: {
            width: shadeCanopyMask.width,
            height: shadeCanopyMask.height,
            count: shadeCanopyPixelCount,
            data: shadeCanopyMaskEncoded,
          },
          solar_canopy: {
            width: solarCanopyMask.width,
            height: solarCanopyMask.height,
            count: solarCanopyPixelCount,
            data: solarCanopyMaskEncoded,
          },
          scenario,
          date: "07-27",
          hour: simulationHour,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409 && body.id) {
          setSimulationJob({ id: body.id, state: "running", stage: "Reconnecting to simulation", progress: 0 });
          return;
        }
        throw new Error(body.error ?? "Unable to start SOLWEIG");
      }
      setSimulationJob({ id: body.id, state: "queued", stage: "Waiting to start", progress: 0 });
    } catch (error) {
      setSimulationError(error instanceof Error ? error.message : "Unable to start SOLWEIG");
    }
  };

  useEffect(() => {
    if (!autoresearchMode || !autoresearchRunId || !archivedSimulationFile) return;
    let cancelled = false;
    setSimulationResult(null);
    setSimulationJob(null);
    setSimulationError(null);
    const encodedPath = archivedSimulationFile.split("/").map(encodeURIComponent).join("/");
    fetch(`/api/autoresearch/runs/${encodeURIComponent(autoresearchRunId)}/files/${encodedPath}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The archived SOLWEIG map result is unavailable");
        return response.json() as Promise<SimulationResult>;
      })
      .then((result) => {
        if (cancelled) return;
        setSimulationResult(result);
        setSimulationJob({ id: result.id, mode: "comparison", state: "complete", stage: "Archived result ready", progress: 100, result });
      })
      .catch((error) => {
        if (cancelled) return;
        setSimulationJob(null);
        setSimulationError(error instanceof Error ? error.message : "Unable to load the archived SOLWEIG map");
      });
    return () => { cancelled = true; };
  }, [archivedSimulationFile, autoresearchCandidate?.id, autoresearchMode, autoresearchRunId, simulationHour]);

  useEffect(() => {
    if (
      !autoresearchMode
      || !autoresearchLayoutReady
      || !autoresearchCandidate
      || !autoresearchRunId
      || activeView !== "results"
      || !hasInterventions
      || !simulationReady
      || activeSimulationRunning
      || simulationMatchesLayout
      || baselineLoadState !== "ready"
      || Boolean(archivedSimulationFile)
    ) return;
    const attemptKey = `${autoresearchRunId}:${autoresearchCandidate.id}:${ACTIVE_AOI}:${scenario}:${simulationHour}:${policyLayoutSignature}`;
    if (autoresearchSimulationAttempt.current === attemptKey) return;
    autoresearchSimulationAttempt.current = attemptKey;
    void startFullSimulation();
  }, [
    activeSimulationRunning,
    activeView,
    autoresearchCandidate,
    autoresearchLayoutReady,
    autoresearchMode,
    autoresearchRunId,
    archivedSimulationFile,
    baselineLoadState,
    hasInterventions,
    policyLayoutSignature,
    scenario,
    simulationHour,
    simulationMatchesLayout,
    simulationReady,
  ]);

  const cancelSimulation = async () => {
    if (!simulationJob || !["queued", "running"].includes(simulationJob.state)) return;
    try {
      await fetch(`/api/solweig/run/${simulationJob.id}`, { method: "DELETE" });
      setSimulationJob((current) => current ? { ...current, state: "cancelled", stage: "Cancelled by user", progress: 100 } : current);
    } catch {
      setSimulationError("Unable to cancel the local process.");
    }
  };

  const startPolicyScoring = async () => {
    if (!hasInterventions || !policyScoringReady || policyScoreRunning || activeSimulationRunning || budgetExceeded) return;
    setPolicyScoreError(null);
    try {
      const response = await fetch("/api/scoring/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aoi: ACTIVE_AOI,
          trees,
          reflective_pavement: { width: reflectiveMask.width, height: reflectiveMask.height, count: reflectivePixelCount, data: reflectiveMaskEncoded },
          cool_roof: { width: coolRoofMask.width, height: coolRoofMask.height, count: coolRoofPixelCount, data: coolRoofMaskEncoded },
          green_roof: { width: greenRoofMask.width, height: greenRoofMask.height, count: greenRoofPixelCount, data: greenRoofMaskEncoded },
          depaved_pavement: { width: depavedMask.width, height: depavedMask.height, count: depavedPixelCount, data: depavedMaskEncoded },
          shade_canopy: { width: shadeCanopyMask.width, height: shadeCanopyMask.height, count: shadeCanopyPixelCount, data: shadeCanopyMaskEncoded },
          solar_canopy: { width: solarCanopyMask.width, height: solarCanopyMask.height, count: solarCanopyPixelCount, data: solarCanopyMaskEncoded },
          scenario,
          budget_usd: policyScoringBudget,
          layout_signature: policyLayoutSignature,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409 && body.id) {
          setPolicyScoreJob({ id: body.id, state: "running", stage: "Reconnecting to policy score", progress: 0 });
          return;
        }
        throw new Error(body.error ?? "Unable to start policy scoring");
      }
      setPolicyScoreJob({ id: body.id, state: "queued", stage: "Waiting to audit layout", progress: 0 });
    } catch (error) {
      setPolicyScoreError(error instanceof Error ? error.message : "Unable to start policy scoring");
    }
  };

  const cancelPolicyScoring = async () => {
    if (!policyScoreJob || !["queued", "running"].includes(policyScoreJob.state)) return;
    try {
      await fetch(`/api/scoring/run/${policyScoreJob.id}`, { method: "DELETE" });
      setPolicyScoreJob((current) => current ? { ...current, state: "cancelled", stage: "Cancelled by user", progress: 100 } : current);
    } catch {
      setPolicyScoreError("Unable to cancel the local scoring process.");
    }
  };

  const positionComparisonBeforeInterventions = () => {
    const mapWidth = manifest?.width ?? DEFAULT_GRID_SIZE;
    let firstIntervention = Math.min(...trees.map((tree) => (tree.x / mapWidth) * 100));
    if (reflectivePixelCount) {
      for (let x = 0; x < reflectiveMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < reflectiveMask.height; y += 1) {
          if (hasMaskPixel(reflectiveMask, y * reflectiveMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / reflectiveMask.width) * 100);
          break;
        }
      }
    }
    if (coolRoofPixelCount) {
      for (let x = 0; x < coolRoofMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < coolRoofMask.height; y += 1) {
          if (hasMaskPixel(coolRoofMask, y * coolRoofMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / coolRoofMask.width) * 100);
          break;
        }
      }
    }
    if (greenRoofPixelCount) {
      for (let x = 0; x < greenRoofMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < greenRoofMask.height; y += 1) {
          if (hasMaskPixel(greenRoofMask, y * greenRoofMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / greenRoofMask.width) * 100);
          break;
        }
      }
    }
    if (depavedPixelCount) {
      for (let x = 0; x < depavedMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < depavedMask.height; y += 1) {
          if (hasMaskPixel(depavedMask, y * depavedMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / depavedMask.width) * 100);
          break;
        }
      }
    }
    if (shadeCanopyPixelCount) {
      for (let x = 0; x < shadeCanopyMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < shadeCanopyMask.height; y += 1) {
          if (hasMaskPixel(shadeCanopyMask, y * shadeCanopyMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / shadeCanopyMask.width) * 100);
          break;
        }
      }
    }
    if (solarCanopyPixelCount) {
      for (let x = 0; x < solarCanopyMask.width; x += 1) {
        let found = false;
        for (let y = 0; y < solarCanopyMask.height; y += 1) {
          if (hasMaskPixel(solarCanopyMask, y * solarCanopyMask.width + x)) { found = true; break; }
        }
        if (found) {
          firstIntervention = Math.min(firstIntervention, (x / solarCanopyMask.width) * 100);
          break;
        }
      }
    }
    setComparisonSplit(Number.isFinite(firstIntervention) ? Math.min(82, Math.max(8, firstIntervention - 7)) : 35);
  };

  const openResults = () => {
    if (hasInterventions) positionComparisonBeforeInterventions();
    setActiveView("results");
    setComparisonActive(hasInterventions);
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setShadeCanopySegmentMode(false);
    setShadeCanopyBrushMode(false);
    setShadeCanopyEraseMode(false);
    setShadeCanopyEraseBox(null);
    setShadeCanopyCursor(null);
    setSolarCanopySegmentMode(false);
    setSolarCanopyBrushMode(false);
    setSolarCanopyEraseMode(false);
    setSolarCanopyEraseBox(null);
    setSolarCanopyCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
    setPanelOpen(true);
  };

  const openMap = () => {
    setActiveView("map");
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setShadeCanopySegmentMode(false);
    setShadeCanopyBrushMode(false);
    setShadeCanopyEraseMode(false);
    setShadeCanopyEraseBox(null);
    setShadeCanopyCursor(null);
    setSolarCanopySegmentMode(false);
    setSolarCanopyBrushMode(false);
    setSolarCanopyEraseMode(false);
    setSolarCanopyEraseBox(null);
    setSolarCanopyCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
    setPanelOpen(true);
    if (hasInterventions) {
      positionComparisonBeforeInterventions();
      setComparisonActive(true);
    } else {
      setComparisonActive(false);
    }
  };

  const mapPoint = (clientX: number, clientY: number) => {
    const frame = rasterFrameRef.current;
    if (!frame) return null;
    const bounds = frame.getBoundingClientRect();
    if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
    return {
      x: Math.min(manifest?.width ?? DEFAULT_GRID_SIZE, Math.max(0, ((clientX - bounds.left) / bounds.width) * (manifest?.width ?? DEFAULT_GRID_SIZE))),
      y: Math.min(manifest?.height ?? DEFAULT_GRID_SIZE, Math.max(0, ((clientY - bounds.top) / bounds.height) * (manifest?.height ?? DEFAULT_GRID_SIZE))),
    };
  };

  const updateTree = (id: string, updates: Partial<TreeIntervention>) => {
    const tree = treesRef.current.find((candidate) => candidate.id === id);
    if (!tree) return;
    const candidate = { ...tree, ...updates };
    if (!Number.isFinite(candidate.heightM) || candidate.heightM < 2 || candidate.heightM > 30) {
      setPlacementNotice("Tree height must remain between 2 and 30 m.");
      return;
    }
    if (!Number.isFinite(candidate.crownDiameterM) || candidate.crownDiameterM < 2 || candidate.crownDiameterM > 20) {
      setPlacementNotice("Tree crown diameter must remain between 2 and 20 m.");
      return;
    }
    if (!isTreeLocationValid(candidate, candidate.crownDiameterM, candidate.size, id)) {
      setPlacementNotice("That tree would break a planting, obstruction, overlap, or boundary rule.");
      return;
    }
    const costDelta = treeCost[candidate.size] - treeCost[tree.size];
    if (costDelta > 0 && workspaceSpend() + costDelta > policyScoringBudget + 0.000001) {
      setPlacementNotice(`Changing this tree would exceed the ${formatCost(policyScoringBudget)} policy budget.`);
      return;
    }
    setPlacementNotice(null);
    setTrees((current) => current.map((item) => item.id === id ? candidate : item));
  };

  const crownDiameterForSize = (size: TreeSize) => size === "small" ? 3 : 5;

  const makeTree = (point: MapPoint): TreeIntervention => ({
    id: crypto.randomUUID(),
    ...point,
    size: newTreeSize,
    heightM: 5,
    crownDiameterM: crownDiameterForSize(newTreeSize),
  });

  const isTreeLocationValid = (point: MapPoint, crownDiameterM: number, size: TreeSize, excludeTreeId?: string) => {
    if (!placementMask || !manifest) return false;
    const strictMask = treePlaceableMasks[size];
    if (!strictMask || !placementMaskHasPoint(strictMask, point, manifest.width, manifest.height)) return false;
    const col = Math.floor(point.x);
    const row = Math.floor(point.y);
    const pixel = row * manifest.width + col;
    if (treesRef.current.some((tree) => tree.id !== excludeTreeId && Math.floor(tree.x) === col && Math.floor(tree.y) === row)) return false;
    if (hasMaskPixel(shadeCanopyMaskRef.current, pixel) || hasMaskPixel(solarCanopyMaskRef.current, pixel)) return false;
    const resolution = Math.max(manifest.resolution_m, 0.01);
    const radius = crownDiameterM / (2 * resolution);
    const centerX = (point.x / manifest.width) * placementMask.width;
    const centerY = (point.y / manifest.height) * placementMask.height;
    const minX = Math.floor(centerX - radius);
    const maxX = Math.ceil(centerX + radius);
    const minY = Math.floor(centerY - radius);
    const maxY = Math.ceil(centerY + radius);
    if (minX < 0 || minY < 0 || maxX >= placementMask.width || maxY >= placementMask.height) return false;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) continue;
        if (placementMask.pixels[(y * placementMask.width + x) * 4] < 128) return false;
      }
    }
    return true;
  };

  const placementUnavailableMessage = () => placementMaskStatus === "loading"
    ? "The offline placement check is still loading."
    : "The offline placement check is unavailable.";

  const placeTree = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!placementMode || brushMode || removalMode || (event.target as HTMLElement).closest("button")) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    const tree = makeTree(point);
    if (!placementMask) {
      setPlacementNotice(placementUnavailableMessage());
      return;
    }
    if (!isTreeLocationValid(point, tree.crownDiameterM, tree.size)) {
      setPlacementNotice("Trees must use a policy-valid pedestrian planting pixel, avoid obstructions and existing canopy, and not share a shade-layer pixel.");
      return;
    }
    if (workspaceSpend() + treeCost[tree.size] > policyScoringBudget + 0.000001) {
      setPlacementNotice(`The ${formatCost(policyScoringBudget)} policy budget has no room for another ${tree.size} tree.`);
      return;
    }
    setPlacementNotice(null);
    setTrees((current) => [...current, tree]);
    setActionHistory((current) => [...current, { type: "place", trees: [tree] }]);
    setSelectedTreeId(tree.id);
  };

  const brushSpacingPx = () => Math.sqrt(1000 / brushDensity) / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);

  const paintBrushStamp = (point: MapPoint) => {
    if (!manifest || !placementMask || brushStrokeTrees.current.length >= 500) return;
    const resolution = Math.max(manifest.resolution_m, 0.01);
    const radius = brushDiameterM / (2 * resolution);
    const spacing = brushSpacingPx();
    const minDistanceSquared = (spacing * 0.72) ** 2;
    const crownDiameterM = crownDiameterForSize(newTreeSize);
    const candidates: MapPoint[] = [];
    const firstX = Math.ceil((point.x - radius) / spacing) * spacing;
    for (let x = firstX; x <= point.x + radius; x += spacing) {
      const row = Math.round(x / spacing);
      const offsetY = row % 2 === 0 ? 0 : spacing / 2;
      const firstY = Math.ceil((point.y - radius - offsetY) / spacing) * spacing + offsetY;
      for (let y = firstY; y <= point.y + radius; y += spacing) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radius ** 2) candidates.push({ x, y });
      }
    }
    if (!candidates.length) candidates.push(point);

    const accepted: TreeIntervention[] = [];
    const occupied = treesRef.current;
    let availableBudget = policyScoringBudget - workspaceSpend();
    for (const candidate of candidates) {
      if (brushStrokeTrees.current.length + accepted.length >= 500) break;
      if (!isTreeLocationValid(candidate, crownDiameterM, newTreeSize)) continue;
      const tooClose = [...occupied, ...accepted].some((tree) => (tree.x - candidate.x) ** 2 + (tree.y - candidate.y) ** 2 < minDistanceSquared);
      if (!tooClose && availableBudget + 0.000001 >= treeCost[newTreeSize]) {
        accepted.push(makeTree(candidate));
        availableBudget -= treeCost[newTreeSize];
      }
    }
    if (!accepted.length) return;
    brushStrokeTrees.current.push(...accepted);
    treesRef.current = [...treesRef.current, ...accepted];
    setTrees((current) => [...current, ...accepted]);
  };

  const startBrushStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!brushMode || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setBrushCursor(point);
    if (!placementMask) {
      setPlacementNotice(placementUnavailableMessage());
      return;
    }
    setPlacementNotice(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    brushStrokeActive.current = true;
    brushStrokeTrees.current = [];
    brushLastPoint.current = point;
    paintBrushStamp(point);
  };

  const moveBrushStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!brushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setBrushCursor(point);
    if (!brushStrokeActive.current || !point || !brushLastPoint.current) return;
    event.stopPropagation();
    const previous = brushLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const stampStep = Math.max(1, Math.min(brushSpacingPx() * 0.55, brushDiameterM * 0.3 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01)));
    const steps = Math.max(1, Math.ceil(distance / stampStep));
    for (let step = 1; step <= steps; step += 1) {
      paintBrushStamp({
        x: previous.x + ((point.x - previous.x) * step) / steps,
        y: previous.y + ((point.y - previous.y) * step) / steps,
      });
    }
    brushLastPoint.current = point;
  };

  const finishBrushStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!brushStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    brushStrokeActive.current = false;
    brushLastPoint.current = null;
    const placed = brushStrokeTrees.current;
    brushStrokeTrees.current = [];
    if (placed.length) {
      setActionHistory((current) => [...current, { type: "place", trees: placed }]);
      setSelectedTreeId(placed[placed.length - 1].id);
    } else {
      setPlacementNotice("No valid, unoccupied planting locations were found in this stroke.");
    }
  };

  const startTreeDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (removalMode || brushMode || reflectiveBrushMode || reflectiveSegmentMode || reflectiveEraseMode || depaveBrushMode || depaveBoxMode || depaveEraseMode || shadeCanopySegmentMode || shadeCanopyBrushMode || shadeCanopyEraseMode || solarCanopySegmentMode || solarCanopyBrushMode || solarCanopyEraseMode || coolRoofClickMode || coolRoofBrushMode || coolRoofBoxMode || coolRoofEraseMode || activeView !== "design") return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingTreeId.current = id;
    setSelectedTreeId(id);
  };

  const moveTree = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (removalMode) return;
    event.stopPropagation();
    if (!draggingTreeId.current) return;
    const point = mapPoint(event.clientX, event.clientY);
    const tree = treesRef.current.find((candidate) => candidate.id === draggingTreeId.current);
    if (point && tree && isTreeLocationValid(point, tree.crownDiameterM, tree.size, tree.id)) updateTree(draggingTreeId.current, point);
  };

  const endTreeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (removalMode || brushMode) return;
    event.stopPropagation();
    if (!draggingTreeId.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    draggingTreeId.current = null;
  };

  const startRemovalBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!removalMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setRemovalBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveRemovalBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!removalMode || !removalBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setRemovalBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishRemovalBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!removalMode || !removalBox) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    const minX = Math.min(removalBox.startX, removalBox.currentX);
    const maxX = Math.max(removalBox.startX, removalBox.currentX);
    const minY = Math.min(removalBox.startY, removalBox.currentY);
    const maxY = Math.max(removalBox.startY, removalBox.currentY);
    if (maxX - minX >= 3 && maxY - minY >= 3) {
      const removed = trees.filter((tree) => tree.x >= minX && tree.x <= maxX && tree.y >= minY && tree.y <= maxY);
      if (removed.length) {
        const removedIds = new Set(removed.map((tree) => tree.id));
        setTrees((current) => current.filter((tree) => !removedIds.has(tree.id)));
        setActionHistory((current) => [...current, { type: "remove", trees: removed }]);
        if (selectedTreeId && removedIds.has(selectedTreeId)) setSelectedTreeId(null);
      }
    }
    setRemovalBox(null);
  };

  const pavementPixelIsValid = (x: number, y: number) => {
    if (!pavementMask) return false;
    const current = reflectiveMaskRef.current;
    const maskX = Math.min(pavementMask.width - 1, Math.max(0, Math.floor(((x + 0.5) / current.width) * pavementMask.width)));
    const maskY = Math.min(pavementMask.height - 1, Math.max(0, Math.floor(((y + 0.5) / current.height) * pavementMask.height)));
    return pavementMask.pixels[(maskY * pavementMask.width + maskX) * 4] >= 128;
  };

  const applyReflectiveStamps = (points: MapPoint[], erase: boolean) => {
    if (!pavementMask || !manifest || !points.length) return;
    const current = reflectiveMaskRef.current;
    const bits = current.bits.slice();
    let count = current.count;
    const currentDepaved = depavedMaskRef.current;
    const depavedBits = currentDepaved.bits.slice();
    let depavedCount = currentDepaved.count;
    let runningSpend = workspaceSpend();
    const pixelArea = (manifest.resolution_m ?? DEFAULT_RESOLUTION_M) ** 2;
    const radius = reflectiveBrushDiameterM / (2 * Math.max(manifest.resolution_m, 0.01));
    for (const point of points) {
      const minX = Math.max(0, Math.floor(point.x - radius));
      const maxX = Math.min(current.width - 1, Math.ceil(point.x + radius));
      const minY = Math.max(0, Math.floor(point.y - radius));
      const maxY = Math.min(current.height - 1, Math.ceil(point.y + radius));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if ((x - point.x) ** 2 + (y - point.y) ** 2 > radius ** 2) continue;
          if (!erase && !pavementPixelIsValid(x, y)) continue;
          const pixel = y * current.width + x;
          const wasSet = hasMaskPixel(current, pixel);
          const willSet = !erase;
          if (wasSet === willSet) continue;
          const displacesDepaved = willSet && (depavedBits[pixel >> 3] & (1 << (pixel & 7))) !== 0;
          const spendDelta = willSet ? pixelArea * (unitCost("light_road") - (displacesDepaved ? unitCost("grass_conversion") : 0)) : -pixelArea * unitCost("light_road");
          if (runningSpend + spendDelta > policyScoringBudget + 0.000001) continue;
          writeMaskPixel(bits, pixel, willSet);
          count += willSet ? 1 : -1;
          runningSpend += spendDelta;
          if (displacesDepaved) {
            writeMaskPixel(depavedBits, pixel, false);
            depavedCount -= 1;
            reflectiveStrokeDisplacedDepaved.current.push(pixel);
          }
          if (!reflectiveStrokeChangedSet.current.has(pixel)) {
            reflectiveStrokeChangedSet.current.add(pixel);
            reflectiveStrokeChanges.current.push(pixel);
          }
        }
      }
    }
    if (count === current.count) return;
    const next = { ...current, bits, count };
    reflectiveMaskRef.current = next;
    setReflectiveMask(next);
    if (depavedCount !== currentDepaved.count) {
      const nextDepaved = { ...currentDepaved, bits: depavedBits, count: depavedCount };
      depavedMaskRef.current = nextDepaved;
      setDepavedMask(nextDepaved);
    }
  };

  const startReflectiveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveBrushMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    if (!pavementMask) {
      setPlacementNotice(pavementMaskStatus === "loading" ? "The pavement map is still loading." : "The pavement map is unavailable.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    reflectiveStrokeActive.current = true;
    reflectiveStrokeLastPoint.current = point;
    reflectiveStrokeChanges.current = [];
    reflectiveStrokeChangedSet.current = new Set();
    reflectiveStrokeDisplacedDepaved.current = [];
    setReflectiveCursor(point);
    setPlacementNotice(null);
    applyReflectiveStamps([point], false);
  };

  const moveReflectiveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveBrushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setReflectiveCursor(point);
    if (!reflectiveStrokeActive.current || !point || !reflectiveStrokeLastPoint.current) return;
    event.stopPropagation();
    const previous = reflectiveStrokeLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const stepLength = Math.max(1, reflectiveBrushDiameterM * 0.28 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01));
    const steps = Math.max(1, Math.ceil(distance / stepLength));
    const stamps = Array.from({ length: steps }, (_, index) => ({
      x: previous.x + ((point.x - previous.x) * (index + 1)) / steps,
      y: previous.y + ((point.y - previous.y) * (index + 1)) / steps,
    }));
    applyReflectiveStamps(stamps, false);
    reflectiveStrokeLastPoint.current = point;
  };

  const finishReflectiveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    reflectiveStrokeActive.current = false;
    reflectiveStrokeLastPoint.current = null;
    const pixels = reflectiveStrokeChanges.current;
    const displacedDepavedPixels = reflectiveStrokeDisplacedDepaved.current;
    reflectiveStrokeChanges.current = [];
    reflectiveStrokeChangedSet.current = new Set();
    reflectiveStrokeDisplacedDepaved.current = [];
    if (pixels.length) {
      setActionHistory((current) => [...current, { type: "reflective-paint", pixels, displacedDepavedPixels }]);
    } else {
      setPlacementNotice("This stroke did not cross valid, uncoated pavement.");
    }
  };

  const startReflectiveEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveEraseMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setReflectiveEraseBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveReflectiveEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveEraseMode || !reflectiveEraseBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setReflectiveEraseBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishReflectiveEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!reflectiveEraseMode || !reflectiveEraseBox) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = reflectiveMaskRef.current;
    const minX = Math.max(0, Math.floor(Math.min(reflectiveEraseBox.startX, reflectiveEraseBox.currentX)));
    const maxX = Math.min(current.width - 1, Math.ceil(Math.max(reflectiveEraseBox.startX, reflectiveEraseBox.currentX)));
    const minY = Math.max(0, Math.floor(Math.min(reflectiveEraseBox.startY, reflectiveEraseBox.currentY)));
    const maxY = Math.min(current.height - 1, Math.ceil(Math.max(reflectiveEraseBox.startY, reflectiveEraseBox.currentY)));
    const pixels: number[] = [];
    const bits = current.bits.slice();
    if (maxX - minX >= 3 && maxY - minY >= 3) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const pixel = y * current.width + x;
          if (!hasMaskPixel(current, pixel)) continue;
          writeMaskPixel(bits, pixel, false);
          pixels.push(pixel);
        }
      }
    }
    if (pixels.length) {
      const next = { ...current, bits, count: current.count - pixels.length };
      reflectiveMaskRef.current = next;
      setReflectiveMask(next);
      setActionHistory((history) => [...history, { type: "reflective-erase", pixels, displacedDepavedPixels: [] }]);
      setPlacementNotice(`Erased ${pixelAreaM2(pixels.length).toLocaleString()} m² of reflective pavement.`);
    } else {
      setPlacementNotice("The rectangle did not contain any proposed reflective pavement.");
    }
    setReflectiveEraseBox(null);
  };

  const selectStreetSegment = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!reflectiveSegmentMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point || !pavementMask) return;
    let selected: StreetSegment | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const segment of streetSegments) {
      for (const path of segment.paths) {
        for (let index = 1; index < path.length; index += 1) {
          const distance = nearestPointOnSegmentSquared(point, path[index - 1], path[index]);
          if (distance < nearest) { nearest = distance; selected = segment; }
        }
      }
    }
    const resolution = Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    const selectionDistance = Math.max(10, reflectiveBrushDiameterM / 2 + 5) / resolution;
    if (!selected || nearest > selectionDistance ** 2) {
      setPlacementNotice("Click closer to a mapped street segment.");
      return;
    }
    const stamps: MapPoint[] = [];
    for (const path of selected.paths) {
      for (let index = 1; index < path.length; index += 1) {
        const start = path[index - 1];
        const end = path[index];
        const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
        const steps = Math.max(1, Math.ceil(distance / Math.max(1, reflectiveBrushDiameterM * 0.25 / resolution)));
        for (let step = 0; step <= steps; step += 1) stamps.push({
          x: start[0] + ((end[0] - start[0]) * step) / steps,
          y: start[1] + ((end[1] - start[1]) * step) / steps,
        });
      }
    }
    reflectiveStrokeChanges.current = [];
    reflectiveStrokeChangedSet.current = new Set();
    reflectiveStrokeDisplacedDepaved.current = [];
    applyReflectiveStamps(stamps, false);
    const pixels = reflectiveStrokeChanges.current;
    const displacedDepavedPixels = reflectiveStrokeDisplacedDepaved.current;
    reflectiveStrokeChanges.current = [];
    reflectiveStrokeChangedSet.current = new Set();
    reflectiveStrokeDisplacedDepaved.current = [];
    if (pixels.length) {
      setActionHistory((current) => [...current, { type: "reflective-paint", pixels, displacedDepavedPixels }]);
      setPlacementNotice(`${selected.name}: ${pixelAreaM2(pixels.length).toLocaleString()} m² of pavement selected.`);
    } else {
      setPlacementNotice(`${selected.name} is already coated or has no pavement in the selected width.`);
    }
  };

  const nearestStreetSide = (point: MapPoint) => {
    let selected: StreetSegment | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    let selectedSide: 1 | -1 = 1;
    for (const segment of streetSegments) for (const path of segment.paths) {
      for (let index = 1; index < path.length; index += 1) {
        const start = path[index - 1];
        const end = path[index];
        const distance = nearestPointOnSegmentSquared(point, start, end);
        if (distance >= nearest) continue;
        nearest = distance;
        selected = segment;
        const cross = (end[0] - start[0]) * (point.y - start[1]) - (end[1] - start[1]) * (point.x - start[0]);
        selectedSide = cross >= 0 ? 1 : -1;
      }
    }
    return { segment: selected, distanceSquared: nearest, side: selectedSide };
  };

  const oneSidedSegmentStamps = (segment: StreetSegment, side: 1 | -1, widthM: number) => {
    const stamps: MapPoint[] = [];
    const resolution = Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    const offset = (5.25 + widthM / 2) / resolution;
    for (const path of segment.paths) for (let index = 1; index < path.length; index += 1) {
      const start = path[index - 1];
      const end = path[index];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const distance = Math.hypot(dx, dy);
      if (!distance) continue;
      const normalX = (-dy / distance) * side;
      const normalY = (dx / distance) * side;
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, widthM * 0.25 / resolution)));
      for (let step = 0; step <= steps; step += 1) stamps.push({
        x: start[0] + (dx * step) / steps + normalX * offset,
        y: start[1] + (dy * step) / steps + normalY * offset,
      });
    }
    return stamps;
  };

  const oneSidedSegmentIcons = (segment: StreetSegment, side: 1 | -1, widthM: number) => {
    const icons: ShadeCanopyIcon[] = [];
    const resolution = Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    const offset = (5.25 + widthM / 2) / resolution;
    const iconSpacing = SHADE_CANOPY_ICON_SPACING_M / resolution;
    for (const path of segment.paths) {
      let traversed = 0;
      let nextIconDistance = iconSpacing / 2;
      for (let index = 1; index < path.length; index += 1) {
        const start = path[index - 1];
        const end = path[index];
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const distance = Math.hypot(dx, dy);
        if (!distance) continue;
        const normalX = (-dy / distance) * side;
        const normalY = (dx / distance) * side;
        while (nextIconDistance <= traversed + distance) {
          const fraction = (nextIconDistance - traversed) / distance;
          icons.push({
            id: crypto.randomUUID(),
            x: start[0] + dx * fraction + normalX * offset,
            y: start[1] + dy * fraction + normalY * offset,
            angle: 0,
          });
          nextIconDistance += iconSpacing;
        }
        traversed += distance;
      }
    }
    return icons;
  };

  const depavablePixelIsValid = (x: number, y: number) => {
    if (!depavableMask) return false;
    const current = depavedMaskRef.current;
    const maskX = Math.min(depavableMask.width - 1, Math.max(0, Math.floor(((x + 0.5) / current.width) * depavableMask.width)));
    const maskY = Math.min(depavableMask.height - 1, Math.max(0, Math.floor(((y + 0.5) / current.height) * depavableMask.height)));
    return depavableMask.pixels[(maskY * depavableMask.width + maskX) * 4] >= 128;
  };

  const canopyPixelIsValid = (mask: PlacementMask | null, x: number, y: number, current: RasterMask) => {
    if (!mask) return false;
    return placementMaskHasPoint(mask, { x: x + 0.5, y: y + 0.5 }, current.width, current.height);
  };

  const treeOccupiesPixel = (pixel: number, width: number) => treesRef.current.some(
    (tree) => Math.floor(tree.y) * width + Math.floor(tree.x) === pixel,
  );

  const applyDepavePixels = (candidatePixels: number[], select: boolean) => {
    const current = depavedMaskRef.current;
    const reflective = reflectiveMaskRef.current;
    const bits = current.bits.slice();
    const reflectiveBits = reflective.bits.slice();
    let count = current.count;
    let reflectiveCount = reflective.count;
    let runningSpend = workspaceSpend();
    const pixelArea = (manifest?.resolution_m ?? DEFAULT_RESOLUTION_M) ** 2;
    const changed: number[] = [];
    const displacedReflective: number[] = [];
    for (const pixel of candidatePixels) {
      const x = pixel % current.width;
      const y = Math.floor(pixel / current.width);
      if (select && !depavablePixelIsValid(x, y)) continue;
      const wasSet = (bits[pixel >> 3] & (1 << (pixel & 7))) !== 0;
      if (wasSet === select) continue;
      const displacesReflective = select && (reflectiveBits[pixel >> 3] & (1 << (pixel & 7))) !== 0;
      const spendDelta = select ? pixelArea * (unitCost("grass_conversion") - (displacesReflective ? unitCost("light_road") : 0)) : -pixelArea * unitCost("grass_conversion");
      if (runningSpend + spendDelta > policyScoringBudget + 0.000001) continue;
      writeMaskPixel(bits, pixel, select);
      count += select ? 1 : -1;
      runningSpend += spendDelta;
      changed.push(pixel);
      if (displacesReflective) {
        writeMaskPixel(reflectiveBits, pixel, false);
        reflectiveCount -= 1;
        displacedReflective.push(pixel);
      }
    }
    if (changed.length) {
      const next = { ...current, bits, count };
      depavedMaskRef.current = next;
      setDepavedMask(next);
    }
    if (displacedReflective.length) {
      const nextReflective = { ...reflective, bits: reflectiveBits, count: reflectiveCount };
      reflectiveMaskRef.current = nextReflective;
      setReflectiveMask(nextReflective);
    }
    return { changed, displacedReflective };
  };

  const applyDepaveStamps = (points: MapPoint[]) => {
    if (!manifest || !points.length) return;
    const current = depavedMaskRef.current;
    const radius = depaveBrushDiameterM / (2 * Math.max(manifest.resolution_m, 0.01));
    const candidates: number[] = [];
    for (const point of points) {
      const minX = Math.max(0, Math.floor(point.x - radius));
      const maxX = Math.min(current.width - 1, Math.ceil(point.x + radius));
      const minY = Math.max(0, Math.floor(point.y - radius));
      const maxY = Math.min(current.height - 1, Math.ceil(point.y + radius));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 > radius ** 2) continue;
        const pixel = y * current.width + x;
        if (depaveStrokeChangedSet.current.has(pixel)) continue;
        depaveStrokeChangedSet.current.add(pixel);
        candidates.push(pixel);
      }
    }
    const result = applyDepavePixels(candidates, true);
    depaveStrokeChanges.current.push(...result.changed);
    depaveStrokeDisplacedReflective.current.push(...result.displacedReflective);
  };

  const startDepaveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveBrushMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    if (!depavableMask) {
      setPlacementNotice(depavableMaskStatus === "loading" ? "The non-road pavement map is still loading." : "The non-road pavement map is unavailable.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    depaveStrokeActive.current = true;
    depaveStrokeLastPoint.current = point;
    depaveStrokeChanges.current = [];
    depaveStrokeChangedSet.current = new Set();
    depaveStrokeDisplacedReflective.current = [];
    setDepaveCursor(point);
    applyDepaveStamps([point]);
  };

  const moveDepaveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveBrushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setDepaveCursor(point);
    if (!depaveStrokeActive.current || !point || !depaveStrokeLastPoint.current) return;
    event.stopPropagation();
    const previous = depaveStrokeLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, depaveBrushDiameterM * 0.28 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01))));
    applyDepaveStamps(Array.from({ length: steps }, (_, index) => ({
      x: previous.x + ((point.x - previous.x) * (index + 1)) / steps,
      y: previous.y + ((point.y - previous.y) * (index + 1)) / steps,
    })));
    depaveStrokeLastPoint.current = point;
  };

  const finishDepaveStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    depaveStrokeActive.current = false;
    depaveStrokeLastPoint.current = null;
    const pixels = depaveStrokeChanges.current;
    const displacedReflectivePixels = depaveStrokeDisplacedReflective.current;
    depaveStrokeChanges.current = [];
    depaveStrokeChangedSet.current = new Set();
    depaveStrokeDisplacedReflective.current = [];
    if (pixels.length) setActionHistory((history) => [...history, { type: "depave-add", pixels, displacedReflectivePixels }]);
    else setPlacementNotice("This stroke did not cross eligible, unconverted non-road pavement.");
  };

  const selectDepaveSegment = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!depaveBoxMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point || !depavableMask) return;
    const selection = nearestStreetSide(point);
    const selectionDistance = Math.max(16, depaveBrushDiameterM + 7) / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    if (!selection.segment || selection.distanceSquared > selectionDistance ** 2) {
      setPlacementNotice("Click on the sidewalk side of a mapped street segment.");
      return;
    }
    depaveStrokeChanges.current = [];
    depaveStrokeChangedSet.current = new Set();
    depaveStrokeDisplacedReflective.current = [];
    applyDepaveStamps(oneSidedSegmentStamps(selection.segment, selection.side, depaveBrushDiameterM));
    const pixels = depaveStrokeChanges.current;
    const displacedReflectivePixels = depaveStrokeDisplacedReflective.current;
    depaveStrokeChanges.current = [];
    depaveStrokeChangedSet.current = new Set();
    depaveStrokeDisplacedReflective.current = [];
    if (pixels.length) {
      setActionHistory((history) => [...history, { type: "depave-add", pixels, displacedReflectivePixels }]);
      setPlacementNotice(`${selection.segment.name}: converted ${pixelAreaM2(pixels.length).toLocaleString()} m² on the clicked side.`);
    } else setPlacementNotice(`${selection.segment.name} has no unconverted eligible pavement on that side.`);
  };

  const startDepaveBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveEraseMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDepaveBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveDepaveBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveEraseMode || !depaveBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setDepaveBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishDepaveBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!depaveEraseMode || !depaveBox) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = depavedMaskRef.current;
    const minX = Math.max(0, Math.floor(Math.min(depaveBox.startX, depaveBox.currentX)));
    const maxX = Math.min(current.width - 1, Math.ceil(Math.max(depaveBox.startX, depaveBox.currentX)));
    const minY = Math.max(0, Math.floor(Math.min(depaveBox.startY, depaveBox.currentY)));
    const maxY = Math.min(current.height - 1, Math.ceil(Math.max(depaveBox.startY, depaveBox.currentY)));
    const candidates: number[] = [];
    if (maxX - minX >= 3 && maxY - minY >= 3) {
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) candidates.push(y * current.width + x);
    }
    const result = applyDepavePixels(candidates, false);
    if (result.changed.length) {
      setActionHistory((history) => [...history, { type: "depave-remove", pixels: result.changed, displacedReflectivePixels: result.displacedReflective }]);
      setPlacementNotice(`Restored ${pixelAreaM2(result.changed.length).toLocaleString()} m².`);
    } else setPlacementNotice("The rectangle did not contain proposed grass conversion.");
    setDepaveBox(null);
  };

  const applyShadeCanopyStamps = (points: MapPoint[], diameterM = shadeCanopyWidthM) => {
    if (!manifest || !shadeCanopyPlaceableMask || !points.length) return [] as number[];
    const current = shadeCanopyMaskRef.current;
    const bits = current.bits.slice();
    const radius = diameterM / (2 * Math.max(manifest.resolution_m, 0.01));
    const changed: number[] = [];
    const visited = new Set<number>();
    let runningSpend = workspaceSpend();
    const pixelCost = manifest.resolution_m ** 2 * unitCost("shade_canopy");
    for (const point of points) {
      const minX = Math.max(0, Math.floor(point.x - radius));
      const maxX = Math.min(current.width - 1, Math.ceil(point.x + radius));
      const minY = Math.max(0, Math.floor(point.y - radius));
      const maxY = Math.min(current.height - 1, Math.ceil(point.y + radius));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 > radius ** 2) continue;
        const pixel = y * current.width + x;
        if (visited.has(pixel) || !canopyPixelIsValid(shadeCanopyPlaceableMask, x, y, current) || treeOccupiesPixel(pixel, current.width) || hasMaskPixel(current, pixel) || hasMaskPixel(solarCanopyMaskRef.current, pixel)) continue;
        if (runningSpend + pixelCost > policyScoringBudget + 0.000001) continue;
        visited.add(pixel);
        writeMaskPixel(bits, pixel, true);
        runningSpend += pixelCost;
        changed.push(pixel);
      }
    }
    if (changed.length) {
      const next = { ...current, bits, count: current.count + changed.length };
      shadeCanopyMaskRef.current = next;
      setShadeCanopyMask(next);
    }
    return changed;
  };

  const addShadeCanopyIcons = (candidates: ShadeCanopyIcon[]) => {
    const accepted: ShadeCanopyIcon[] = [];
    const minimumSpacingSquared = (SHADE_CANOPY_ICON_SPACING_M * 0.6 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01)) ** 2;
    for (const icon of candidates) {
      if (!placementMask || !depavableMask || !manifest || !canopyIconIsNearEligibleGround(icon, placementMask, depavableMask, manifest.width, manifest.height, manifest.resolution_m)) continue;
      if ([...shadeCanopyIcons, ...shadeCanopyStrokeIcons.current, ...accepted].some((existing) => (existing.x - icon.x) ** 2 + (existing.y - icon.y) ** 2 < minimumSpacingSquared)) continue;
      accepted.push(icon);
    }
    if (accepted.length) setShadeCanopyIcons((current) => [...current, ...accepted]);
    return accepted;
  };

  const startShadeCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyBrushMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    if (!shadeCanopyPlaceableMask) {
      setPlacementNotice(depavableMaskStatus === "loading" ? "The canopy placement map is still loading." : "The canopy placement map is unavailable.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    shadeCanopyStrokeActive.current = true;
    shadeCanopyStrokeLastPoint.current = point;
    shadeCanopyStrokeChanges.current = [];
    shadeCanopyStrokeIcons.current = [];
    shadeCanopyStrokeLastIconPoint.current = point;
    setShadeCanopyCursor(point);
    shadeCanopyStrokeChanges.current.push(...applyShadeCanopyStamps([point], shadeCanopyBrushDiameterM));
    const initialIcons = addShadeCanopyIcons([{ id: crypto.randomUUID(), x: point.x, y: point.y, angle: 0 }]);
    shadeCanopyStrokeIcons.current.push(...initialIcons);
  };

  const moveShadeCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyBrushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setShadeCanopyCursor(point);
    if (!shadeCanopyStrokeActive.current || !point || !shadeCanopyStrokeLastPoint.current) return;
    event.stopPropagation();
    const previous = shadeCanopyStrokeLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const resolution = Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, shadeCanopyBrushDiameterM * 0.28 / resolution)));
    const stamps = Array.from({ length: steps }, (_, index) => ({
      x: previous.x + ((point.x - previous.x) * (index + 1)) / steps,
      y: previous.y + ((point.y - previous.y) * (index + 1)) / steps,
    }));
    shadeCanopyStrokeChanges.current.push(...applyShadeCanopyStamps(stamps, shadeCanopyBrushDiameterM));
    const iconStart = shadeCanopyStrokeLastIconPoint.current ?? previous;
    const iconDistance = Math.hypot(point.x - iconStart.x, point.y - iconStart.y);
    const iconSpacing = SHADE_CANOPY_ICON_SPACING_M / resolution;
    if (iconDistance >= iconSpacing) {
      const iconSteps = Math.floor(iconDistance / iconSpacing);
      const angle = Math.atan2(point.y - iconStart.y, point.x - iconStart.x);
      const candidates = Array.from({ length: iconSteps }, (_, index) => {
        const distanceAlong = (index + 1) * iconSpacing;
        return {
          id: crypto.randomUUID(),
          x: iconStart.x + Math.cos(angle) * distanceAlong,
          y: iconStart.y + Math.sin(angle) * distanceAlong,
          angle: 0,
        };
      });
      const added = addShadeCanopyIcons(candidates);
      shadeCanopyStrokeIcons.current.push(...added);
      const lastCandidate = candidates[candidates.length - 1];
      shadeCanopyStrokeLastIconPoint.current = { x: lastCandidate.x, y: lastCandidate.y };
    }
    shadeCanopyStrokeLastPoint.current = point;
  };

  const finishShadeCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    shadeCanopyStrokeActive.current = false;
    shadeCanopyStrokeLastPoint.current = null;
    const pixels = shadeCanopyStrokeChanges.current;
    const icons = shadeCanopyStrokeIcons.current;
    shadeCanopyStrokeChanges.current = [];
    shadeCanopyStrokeIcons.current = [];
    shadeCanopyStrokeLastIconPoint.current = null;
    if (pixels.length) setActionHistory((history) => [...history, { type: "shade-canopy-add", pixels, icons }]);
    else {
      if (icons.length) {
        const ids = new Set(icons.map((icon) => icon.id));
        setShadeCanopyIcons((current) => current.filter((icon) => !ids.has(icon.id)));
      }
      setPlacementNotice("No new sidewalk canopy was added. Fabric and PV canopies cannot overlap.");
    }
  };

  const selectShadeCanopySegment = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!shadeCanopySegmentMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point || !shadeCanopyPlaceableMask) return;
    const selection = nearestStreetSide(point);
    const selectionDistance = Math.max(16, shadeCanopyWidthM + 7) / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    if (!selection.segment || selection.distanceSquared > selectionDistance ** 2) {
      setPlacementNotice("Click on the sidewalk side of a mapped street segment.");
      return;
    }
    const pixels = applyShadeCanopyStamps(oneSidedSegmentStamps(selection.segment, selection.side, shadeCanopyWidthM));
    if (pixels.length) {
      const icons = addShadeCanopyIcons(oneSidedSegmentIcons(selection.segment, selection.side, shadeCanopyWidthM));
      setActionHistory((history) => [...history, { type: "shade-canopy-add", pixels, icons }]);
      setPlacementNotice(`${selection.segment.name}: added ${pixelAreaM2(pixels.length).toLocaleString()} m² of shade canopy on the clicked side.`);
    } else setPlacementNotice(`${selection.segment.name} has no available sidewalk coverage on that side; fabric and PV canopies cannot overlap.`);
  };

  const startShadeCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyEraseMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setShadeCanopyEraseBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveShadeCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyEraseMode || !shadeCanopyEraseBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setShadeCanopyEraseBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishShadeCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!shadeCanopyEraseMode || !shadeCanopyEraseBox) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = shadeCanopyMaskRef.current;
    const minX = Math.max(0, Math.floor(Math.min(shadeCanopyEraseBox.startX, shadeCanopyEraseBox.currentX)));
    const maxX = Math.min(current.width - 1, Math.ceil(Math.max(shadeCanopyEraseBox.startX, shadeCanopyEraseBox.currentX)));
    const minY = Math.max(0, Math.floor(Math.min(shadeCanopyEraseBox.startY, shadeCanopyEraseBox.currentY)));
    const maxY = Math.min(current.height - 1, Math.ceil(Math.max(shadeCanopyEraseBox.startY, shadeCanopyEraseBox.currentY)));
    const bits = current.bits.slice();
    const pixels: number[] = [];
    const icons = shadeCanopyIcons.filter((icon) => icon.x >= minX && icon.x <= maxX && icon.y >= minY && icon.y <= maxY);
    if (maxX - minX >= 3 && maxY - minY >= 3) for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const pixel = y * current.width + x;
      if (!hasMaskPixel(current, pixel)) continue;
      writeMaskPixel(bits, pixel, false);
      pixels.push(pixel);
    }
    if (pixels.length) {
      const next = { ...current, bits, count: current.count - pixels.length };
      shadeCanopyMaskRef.current = next;
      setShadeCanopyMask(next);
      if (icons.length) {
        const removedIds = new Set(icons.map((icon) => icon.id));
        setShadeCanopyIcons((currentIcons) => currentIcons.filter((icon) => !removedIds.has(icon.id)));
      }
      setActionHistory((history) => [...history, { type: "shade-canopy-remove", pixels, icons }]);
      setPlacementNotice(`Removed ${pixelAreaM2(pixels.length).toLocaleString()} m² of shade canopy.`);
    } else setPlacementNotice("The rectangle did not contain proposed shade canopy.");
    setShadeCanopyEraseBox(null);
  };

  const applySolarCanopyStamps = (points: MapPoint[], diameterM = solarCanopyWidthM) => {
    if (!manifest || !solarCanopyPlaceableMask || !points.length) return [] as number[];
    const current = solarCanopyMaskRef.current;
    const bits = current.bits.slice();
    const radius = diameterM / (2 * Math.max(manifest.resolution_m, 0.01));
    const changed: number[] = [];
    const visited = new Set<number>();
    let runningSpend = workspaceSpend();
    const pixelCost = manifest.resolution_m ** 2 * unitCost("solar_canopy");
    for (const point of points) {
      const minX = Math.max(0, Math.floor(point.x - radius));
      const maxX = Math.min(current.width - 1, Math.ceil(point.x + radius));
      const minY = Math.max(0, Math.floor(point.y - radius));
      const maxY = Math.min(current.height - 1, Math.ceil(point.y + radius));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 > radius ** 2) continue;
        const pixel = y * current.width + x;
        if (visited.has(pixel) || !canopyPixelIsValid(solarCanopyPlaceableMask, x, y, current) || treeOccupiesPixel(pixel, current.width) || hasMaskPixel(current, pixel) || hasMaskPixel(shadeCanopyMaskRef.current, pixel)) continue;
        if (runningSpend + pixelCost > policyScoringBudget + 0.000001) continue;
        visited.add(pixel);
        writeMaskPixel(bits, pixel, true);
        runningSpend += pixelCost;
        changed.push(pixel);
      }
    }
    if (changed.length) {
      const next = { ...current, bits, count: current.count + changed.length };
      solarCanopyMaskRef.current = next;
      setSolarCanopyMask(next);
    }
    return changed;
  };

  const addSolarCanopyIcons = (candidates: ShadeCanopyIcon[]) => {
    const accepted: ShadeCanopyIcon[] = [];
    const minimumSpacingSquared = (SHADE_CANOPY_ICON_SPACING_M * 0.6 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01)) ** 2;
    for (const icon of candidates) {
      if (!placementMask || !depavableMask || !manifest || !canopyIconIsNearEligibleGround(icon, placementMask, depavableMask, manifest.width, manifest.height, manifest.resolution_m)) continue;
      if ([...solarCanopyIcons, ...solarCanopyStrokeIcons.current, ...accepted].some((existing) => (existing.x - icon.x) ** 2 + (existing.y - icon.y) ** 2 < minimumSpacingSquared)) continue;
      accepted.push(icon);
    }
    if (accepted.length) setSolarCanopyIcons((current) => [...current, ...accepted]);
    return accepted;
  };

  const startSolarCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyBrushMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    if (!solarCanopyPlaceableMask) {
      setPlacementNotice(depavableMaskStatus === "loading" ? "The solar-canopy placement map is still loading." : "The solar-canopy placement map is unavailable.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    solarCanopyStrokeActive.current = true;
    solarCanopyStrokeLastPoint.current = point;
    solarCanopyStrokeChanges.current = [];
    solarCanopyStrokeIcons.current = [];
    solarCanopyStrokeLastIconPoint.current = point;
    setSolarCanopyCursor(point);
    solarCanopyStrokeChanges.current.push(...applySolarCanopyStamps([point], solarCanopyBrushDiameterM));
    solarCanopyStrokeIcons.current.push(...addSolarCanopyIcons([{ id: crypto.randomUUID(), x: point.x, y: point.y, angle: 0 }]));
  };

  const moveSolarCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyBrushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setSolarCanopyCursor(point);
    if (!solarCanopyStrokeActive.current || !point || !solarCanopyStrokeLastPoint.current) return;
    event.stopPropagation();
    const previous = solarCanopyStrokeLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const resolution = Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, solarCanopyBrushDiameterM * 0.28 / resolution)));
    const stamps = Array.from({ length: steps }, (_, index) => ({
      x: previous.x + ((point.x - previous.x) * (index + 1)) / steps,
      y: previous.y + ((point.y - previous.y) * (index + 1)) / steps,
    }));
    solarCanopyStrokeChanges.current.push(...applySolarCanopyStamps(stamps, solarCanopyBrushDiameterM));
    const iconStart = solarCanopyStrokeLastIconPoint.current ?? previous;
    const iconDistance = Math.hypot(point.x - iconStart.x, point.y - iconStart.y);
    const iconSpacing = SHADE_CANOPY_ICON_SPACING_M / resolution;
    if (iconDistance >= iconSpacing) {
      const iconSteps = Math.floor(iconDistance / iconSpacing);
      const angle = Math.atan2(point.y - iconStart.y, point.x - iconStart.x);
      const candidates = Array.from({ length: iconSteps }, (_, index) => {
        const distanceAlong = (index + 1) * iconSpacing;
        return { id: crypto.randomUUID(), x: iconStart.x + Math.cos(angle) * distanceAlong, y: iconStart.y + Math.sin(angle) * distanceAlong, angle: 0 };
      });
      solarCanopyStrokeIcons.current.push(...addSolarCanopyIcons(candidates));
      const lastCandidate = candidates[candidates.length - 1];
      solarCanopyStrokeLastIconPoint.current = { x: lastCandidate.x, y: lastCandidate.y };
    }
    solarCanopyStrokeLastPoint.current = point;
  };

  const finishSolarCanopyStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    solarCanopyStrokeActive.current = false;
    solarCanopyStrokeLastPoint.current = null;
    const pixels = solarCanopyStrokeChanges.current;
    const icons = solarCanopyStrokeIcons.current;
    solarCanopyStrokeChanges.current = [];
    solarCanopyStrokeIcons.current = [];
    solarCanopyStrokeLastIconPoint.current = null;
    if (pixels.length) setActionHistory((history) => [...history, { type: "solar-canopy-add", pixels, icons }]);
    else {
      if (icons.length) {
        const ids = new Set(icons.map((icon) => icon.id));
        setSolarCanopyIcons((current) => current.filter((icon) => !ids.has(icon.id)));
      }
      setPlacementNotice("No new sidewalk solar canopy was added. PV and fabric canopies cannot overlap.");
    }
  };

  const selectSolarCanopySegment = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!solarCanopySegmentMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point || !solarCanopyPlaceableMask) return;
    const selection = nearestStreetSide(point);
    const selectionDistance = Math.max(16, solarCanopyWidthM + 7) / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01);
    if (!selection.segment || selection.distanceSquared > selectionDistance ** 2) {
      setPlacementNotice("Click on the sidewalk side of a mapped street segment.");
      return;
    }
    const pixels = applySolarCanopyStamps(oneSidedSegmentStamps(selection.segment, selection.side, solarCanopyWidthM));
    if (pixels.length) {
      const icons = addSolarCanopyIcons(oneSidedSegmentIcons(selection.segment, selection.side, solarCanopyWidthM));
      setActionHistory((history) => [...history, { type: "solar-canopy-add", pixels, icons }]);
      setPlacementNotice(`${selection.segment.name}: added ${pixelAreaM2(pixels.length).toLocaleString()} m² of solar canopy on the clicked side.`);
    } else setPlacementNotice(`${selection.segment.name} has no available sidewalk coverage on that side; PV and fabric canopies cannot overlap.`);
  };

  const startSolarCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyEraseMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSolarCanopyEraseBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveSolarCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyEraseMode || !solarCanopyEraseBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setSolarCanopyEraseBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishSolarCanopyEraseBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!solarCanopyEraseMode || !solarCanopyEraseBox) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = solarCanopyMaskRef.current;
    const minX = Math.max(0, Math.floor(Math.min(solarCanopyEraseBox.startX, solarCanopyEraseBox.currentX)));
    const maxX = Math.min(current.width - 1, Math.ceil(Math.max(solarCanopyEraseBox.startX, solarCanopyEraseBox.currentX)));
    const minY = Math.max(0, Math.floor(Math.min(solarCanopyEraseBox.startY, solarCanopyEraseBox.currentY)));
    const maxY = Math.min(current.height - 1, Math.ceil(Math.max(solarCanopyEraseBox.startY, solarCanopyEraseBox.currentY)));
    const bits = current.bits.slice();
    const pixels: number[] = [];
    const icons = solarCanopyIcons.filter((icon) => icon.x >= minX && icon.x <= maxX && icon.y >= minY && icon.y <= maxY);
    if (maxX - minX >= 3 && maxY - minY >= 3) for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const pixel = y * current.width + x;
      if (!hasMaskPixel(current, pixel)) continue;
      writeMaskPixel(bits, pixel, false);
      pixels.push(pixel);
    }
    if (pixels.length) {
      const next = { ...current, bits, count: current.count - pixels.length };
      solarCanopyMaskRef.current = next;
      setSolarCanopyMask(next);
      if (icons.length) {
        const removedIds = new Set(icons.map((icon) => icon.id));
        setSolarCanopyIcons((currentIcons) => currentIcons.filter((icon) => !removedIds.has(icon.id)));
      }
      setActionHistory((history) => [...history, { type: "solar-canopy-remove", pixels, icons }]);
      setPlacementNotice(`Removed ${pixelAreaM2(pixels.length).toLocaleString()} m² of solar canopy.`);
    } else setPlacementNotice("The rectangle did not contain proposed solar canopy.");
    setSolarCanopyEraseBox(null);
  };

  const roofRegionIdAt = (pixel: number) => {
    if (!roofRegions) return 0;
    const offset = pixel * 4;
    return roofRegions.pixels[offset]
      | (roofRegions.pixels[offset + 1] << 8)
      | (roofRegions.pixels[offset + 2] << 16);
  };

  const applyRoofRegions = (regionIds: Set<number>, select: boolean, kind: RoofKind, recordHistory = true) => {
    const emptyChange = { changed: [] as number[], displaced: [] as number[] };
    if (!roofRegions || !regionIds.size) return emptyChange;
    const targetRef = kind === "green_roof" ? greenRoofMaskRef : coolRoofMaskRef;
    const otherRef = kind === "green_roof" ? coolRoofMaskRef : greenRoofMaskRef;
    const current = targetRef.current;
    const other = otherRef.current;
    const bits = current.bits.slice();
    const otherBits = other.bits.slice();
    const changed: number[] = [];
    const displaced: number[] = [];
    let runningSpend = workspaceSpend();
    const pixelArea = (manifest?.resolution_m ?? DEFAULT_RESOLUTION_M) ** 2;
    const targetUnitCost = unitCost(kind);
    const otherUnitCost = unitCost(kind === "green_roof" ? "cool_roof" : "green_roof");
    for (const regionId of regionIds) {
      const regionPixels = roofPixelsByRegionRef.current.get(regionId) ?? [];
      let regionSpendDelta = 0;
      for (const pixel of regionPixels) {
        const wasSet = (bits[pixel >> 3] & (1 << (pixel & 7))) !== 0;
        if (wasSet !== select) regionSpendDelta += (select ? 1 : -1) * pixelArea * targetUnitCost;
        if (select && (otherBits[pixel >> 3] & (1 << (pixel & 7))) !== 0) regionSpendDelta -= pixelArea * otherUnitCost;
      }
      if (select && runningSpend + regionSpendDelta > policyScoringBudget + 0.000001) continue;
      for (const pixel of regionPixels) {
        const wasSet = hasMaskPixel(current, pixel);
        if (wasSet !== select) {
          writeMaskPixel(bits, pixel, select);
          changed.push(pixel);
        }
        if (select && hasMaskPixel(other, pixel)) {
          writeMaskPixel(otherBits, pixel, false);
          displaced.push(pixel);
        }
      }
      runningSpend += regionSpendDelta;
    }
    if (changed.length) {
      const next = { ...current, bits, count: current.count + (select ? changed.length : -changed.length) };
      targetRef.current = next;
      if (kind === "green_roof") setGreenRoofMask(next);
      else setCoolRoofMask(next);
    }
    if (displaced.length) {
      const nextOther = { ...other, bits: otherBits, count: other.count - displaced.length };
      otherRef.current = nextOther;
      if (kind === "green_roof") setCoolRoofMask(nextOther);
      else setGreenRoofMask(nextOther);
    }
    if (recordHistory && (changed.length || displaced.length)) {
      setActionHistory((history) => [...history, { type: select ? "roof-add" : "roof-remove", kind, pixels: changed, displacedPixels: displaced }]);
    }
    return { changed, displaced };
  };

  const selectCoolRoof = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!coolRoofClickMode || !roofRegions) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    const x = Math.min(roofRegions.width - 1, Math.max(0, Math.floor(point.x)));
    const y = Math.min(roofRegions.height - 1, Math.max(0, Math.floor(point.y)));
    const pixel = y * roofRegions.width + x;
    const regionId = roofRegionIdAt(pixel);
    if (!regionId) {
      setPlacementNotice("Click a mapped building roof.");
      return;
    }
    const targetMask = activeRoofKind === "green_roof" ? greenRoofMaskRef.current : coolRoofMaskRef.current;
    const remove = hasMaskPixel(targetMask, pixel);
    const { changed, displaced } = applyRoofRegions(new Set([regionId]), !remove, activeRoofKind);
    setPlacementNotice(changed.length || displaced.length
      ? `${remove ? "Removed" : "Applied"} ${activeRoofLabel} on one building · ${pixelAreaM2(changed.length).toLocaleString()} m²${displaced.length ? ` · replaced ${pixelAreaM2(displaced.length).toLocaleString()} m² of the other roof treatment` : ""}.`
      : "That whole roof is already in the requested state.");
  };

  const coolRoofRegionIdsAtBrush = (point: MapPoint) => {
    if (!roofRegions || !manifest) return new Set<number>();
    const radius = coolRoofBrushDiameterM / (2 * Math.max(manifest.resolution_m, 0.01));
    const minX = Math.max(0, Math.floor(point.x - radius));
    const maxX = Math.min(roofRegions.width - 1, Math.ceil(point.x + radius));
    const minY = Math.max(0, Math.floor(point.y - radius));
    const maxY = Math.min(roofRegions.height - 1, Math.ceil(point.y + radius));
    const regionIds = new Set<number>();
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 > radius ** 2) continue;
        const regionId = roofRegionIdAt(y * roofRegions.width + x);
        if (regionId && !coolRoofStrokeRegionIds.current.has(regionId)) regionIds.add(regionId);
      }
    }
    return regionIds;
  };

  const applyCoolRoofBrushPoint = (point: MapPoint) => {
    const regionIds = coolRoofRegionIdsAtBrush(point);
    if (!regionIds.size) return;
    for (const id of regionIds) coolRoofStrokeRegionIds.current.add(id);
    const change = applyRoofRegions(regionIds, true, activeRoofKind, false);
    coolRoofStrokePixels.current.push(...change.changed);
    roofStrokeDisplacedPixels.current.push(...change.displaced);
  };

  const startCoolRoofBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!coolRoofBrushMode || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    if (!roofRegions) {
      setPlacementNotice(roofRegionsStatus === "loading" ? "The roof map is still loading." : "The roof map is unavailable.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    coolRoofStrokeActive.current = true;
    coolRoofStrokeLastPoint.current = point;
    coolRoofStrokeRegionIds.current = new Set();
    coolRoofStrokePixels.current = [];
    roofStrokeDisplacedPixels.current = [];
    setCoolRoofCursor(point);
    applyCoolRoofBrushPoint(point);
  };

  const moveCoolRoofBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!coolRoofBrushMode) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (point) setCoolRoofCursor(point);
    if (!coolRoofStrokeActive.current || !point || !coolRoofStrokeLastPoint.current) return;
    event.stopPropagation();
    const previous = coolRoofStrokeLastPoint.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const stepLength = Math.max(1, coolRoofBrushDiameterM * 0.3 / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01));
    const steps = Math.max(1, Math.ceil(distance / stepLength));
    for (let step = 1; step <= steps; step += 1) applyCoolRoofBrushPoint({
      x: previous.x + ((point.x - previous.x) * step) / steps,
      y: previous.y + ((point.y - previous.y) * step) / steps,
    });
    coolRoofStrokeLastPoint.current = point;
  };

  const finishCoolRoofBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!coolRoofStrokeActive.current) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    coolRoofStrokeActive.current = false;
    coolRoofStrokeLastPoint.current = null;
    const pixels = coolRoofStrokePixels.current;
    const displacedPixels = roofStrokeDisplacedPixels.current;
    coolRoofStrokePixels.current = [];
    roofStrokeDisplacedPixels.current = [];
    coolRoofStrokeRegionIds.current = new Set();
    if (pixels.length || displacedPixels.length) {
      setActionHistory((history) => [...history, { type: "roof-add", kind: activeRoofKind, pixels, displacedPixels }]);
      setPlacementNotice(`Applied whole ${activeRoofLabel}s · ${pixelAreaM2(pixels.length).toLocaleString()} m² added${displacedPixels.length ? ` · replaced ${pixelAreaM2(displacedPixels.length).toLocaleString()} m² of the other treatment` : ""}.`);
    } else {
      setPlacementNotice("The brush did not touch an unselected building roof.");
    }
  };

  const startCoolRoofBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((!coolRoofBoxMode && !coolRoofEraseMode) || event.button !== 0) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCoolRoofBox({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };

  const moveCoolRoofBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((!coolRoofBoxMode && !coolRoofEraseMode) || !coolRoofBox) return;
    const point = mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.stopPropagation();
    setCoolRoofBox((current) => current ? { ...current, currentX: point.x, currentY: point.y } : null);
  };

  const finishCoolRoofBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((!coolRoofBoxMode && !coolRoofEraseMode) || !coolRoofBox || !roofRegions) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const minX = Math.max(0, Math.floor(Math.min(coolRoofBox.startX, coolRoofBox.currentX)));
    const maxX = Math.min(roofRegions.width - 1, Math.ceil(Math.max(coolRoofBox.startX, coolRoofBox.currentX)));
    const minY = Math.max(0, Math.floor(Math.min(coolRoofBox.startY, coolRoofBox.currentY)));
    const maxY = Math.min(roofRegions.height - 1, Math.ceil(Math.max(coolRoofBox.startY, coolRoofBox.currentY)));
    const regionIds = new Set<number>();
    if (maxX - minX >= 3 && maxY - minY >= 3) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const id = roofRegionIdAt(y * roofRegions.width + x);
          if (id) regionIds.add(id);
        }
      }
    }
    const { changed, displaced } = applyRoofRegions(regionIds, !coolRoofEraseMode, activeRoofKind);
    setPlacementNotice(changed.length || displaced.length
      ? `${coolRoofEraseMode ? "Removed" : "Applied"} ${activeRoofLabel}s ${coolRoofEraseMode ? "from" : "to"} ${regionIds.size} building${regionIds.size === 1 ? "" : "s"} · ${pixelAreaM2(changed.length).toLocaleString()} m² ${coolRoofEraseMode ? "removed" : "added"}${displaced.length ? ` · replaced ${pixelAreaM2(displaced.length).toLocaleString()} m² of the other treatment` : ""}.`
      : coolRoofEraseMode ? `The rectangle did not contain any selected ${activeRoofLabel}s.` : "Drag across one or more unselected building roofs.");
    setCoolRoofBox(null);
  };

  const undoLastAction = () => {
    const action = actionHistory[actionHistory.length - 1];
    if (!action) return;
    if (action.type === "solar-canopy-add" || action.type === "solar-canopy-remove") {
      const target = solarCanopyMaskRef.current;
      const restore = action.type === "solar-canopy-remove";
      const bits = target.bits.slice();
      for (const pixel of action.pixels) writeMaskPixel(bits, pixel, restore);
      const next = { ...target, bits, count: target.count + (restore ? action.pixels.length : -action.pixels.length) };
      solarCanopyMaskRef.current = next;
      setSolarCanopyMask(next);
      if (action.icons.length) {
        if (action.type === "solar-canopy-add") {
          const ids = new Set(action.icons.map((icon) => icon.id));
          setSolarCanopyIcons((current) => current.filter((icon) => !ids.has(icon.id)));
        } else {
          setSolarCanopyIcons((current) => {
            const ids = new Set(current.map((icon) => icon.id));
            return [...current, ...action.icons.filter((icon) => !ids.has(icon.id))];
          });
        }
      }
      setActionHistory((history) => history.slice(0, -1));
      return;
    }
    if (action.type === "shade-canopy-add" || action.type === "shade-canopy-remove") {
      const target = shadeCanopyMaskRef.current;
      const restore = action.type === "shade-canopy-remove";
      const bits = target.bits.slice();
      for (const pixel of action.pixels) writeMaskPixel(bits, pixel, restore);
      const next = { ...target, bits, count: target.count + (restore ? action.pixels.length : -action.pixels.length) };
      shadeCanopyMaskRef.current = next;
      setShadeCanopyMask(next);
      if (action.icons.length) {
        if (action.type === "shade-canopy-add") {
          const ids = new Set(action.icons.map((icon) => icon.id));
          setShadeCanopyIcons((current) => current.filter((icon) => !ids.has(icon.id)));
        } else {
          setShadeCanopyIcons((current) => {
            const ids = new Set(current.map((icon) => icon.id));
            return [...current, ...action.icons.filter((icon) => !ids.has(icon.id))];
          });
        }
      }
      setActionHistory((history) => history.slice(0, -1));
      return;
    }
    if (action.type === "depave-add" || action.type === "depave-remove") {
      const target = depavedMaskRef.current;
      const restore = action.type === "depave-remove";
      const bits = target.bits.slice();
      for (const pixel of action.pixels) writeMaskPixel(bits, pixel, restore);
      const next = { ...target, bits, count: target.count + (restore ? action.pixels.length : -action.pixels.length) };
      depavedMaskRef.current = next;
      setDepavedMask(next);
      if (action.displacedReflectivePixels.length) {
        const reflective = reflectiveMaskRef.current;
        const reflectiveBits = reflective.bits.slice();
        for (const pixel of action.displacedReflectivePixels) writeMaskPixel(reflectiveBits, pixel, true);
        const nextReflective = { ...reflective, bits: reflectiveBits, count: reflective.count + action.displacedReflectivePixels.length };
        reflectiveMaskRef.current = nextReflective;
        setReflectiveMask(nextReflective);
      }
      setActionHistory((history) => history.slice(0, -1));
      return;
    }
    if (action.type === "roof-add" || action.type === "roof-remove") {
      const targetRef = action.kind === "green_roof" ? greenRoofMaskRef : coolRoofMaskRef;
      const otherRef = action.kind === "green_roof" ? coolRoofMaskRef : greenRoofMaskRef;
      const target = targetRef.current;
      const restoreTarget = action.type === "roof-remove";
      const targetBits = target.bits.slice();
      for (const pixel of action.pixels) writeMaskPixel(targetBits, pixel, restoreTarget);
      const nextTarget = { ...target, bits: targetBits, count: target.count + (restoreTarget ? action.pixels.length : -action.pixels.length) };
      targetRef.current = nextTarget;
      if (action.kind === "green_roof") setGreenRoofMask(nextTarget);
      else setCoolRoofMask(nextTarget);
      if (action.displacedPixels.length) {
        const other = otherRef.current;
        const otherBits = other.bits.slice();
        for (const pixel of action.displacedPixels) writeMaskPixel(otherBits, pixel, true);
        const nextOther = { ...other, bits: otherBits, count: other.count + action.displacedPixels.length };
        otherRef.current = nextOther;
        if (action.kind === "green_roof") setCoolRoofMask(nextOther);
        else setGreenRoofMask(nextOther);
      }
      setActionHistory((history) => history.slice(0, -1));
      return;
    }
    if (action.type === "reflective-paint" || action.type === "reflective-erase") {
      const target = reflectiveMaskRef.current;
      const restore = action.type === "reflective-erase";
      const targetBits = target.bits.slice();
      for (const pixel of action.pixels) writeMaskPixel(targetBits, pixel, restore);
      const next = { ...target, bits: targetBits, count: target.count + (restore ? action.pixels.length : -action.pixels.length) };
      reflectiveMaskRef.current = next;
      setReflectiveMask(next);
      const displacedDepaved = action.displacedDepavedPixels ?? [];
      if (displacedDepaved.length) {
        const depaved = depavedMaskRef.current;
        const depavedBits = depaved.bits.slice();
        for (const pixel of displacedDepaved) writeMaskPixel(depavedBits, pixel, true);
        const nextDepaved = { ...depaved, bits: depavedBits, count: depaved.count + displacedDepaved.length };
        depavedMaskRef.current = nextDepaved;
        setDepavedMask(nextDepaved);
      }
      setActionHistory((history) => history.slice(0, -1));
      return;
    }
    if (action.type === "place" || action.type === "remove") {
      const actionIds = new Set(action.trees.map((tree) => tree.id));
      if (action.type === "place") {
        setTrees((current) => current.filter((tree) => !actionIds.has(tree.id)));
        if (selectedTreeId && actionIds.has(selectedTreeId)) setSelectedTreeId(null);
      } else {
        setTrees((current) => {
          const currentIds = new Set(current.map((tree) => tree.id));
          return [...current, ...action.trees.filter((tree) => !currentIds.has(tree.id))];
        });
      }
    }
    setActionHistory((current) => current.slice(0, -1));
  };

  const saveLayout = () => {
    localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(trees));
    storeRasterMask(REFLECTIVE_STORAGE_KEY, reflectiveMask);
    storeRasterMask(COOL_ROOF_STORAGE_KEY, coolRoofMask);
    storeRasterMask(GREEN_ROOF_STORAGE_KEY, greenRoofMask);
    storeRasterMask(DEPAVED_STORAGE_KEY, depavedMask);
    storeRasterMask(SHADE_CANOPY_STORAGE_KEY, shadeCanopyMask);
    if (shadeCanopyIcons.length) localStorage.setItem(SHADE_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(shadeCanopyIcons));
    storeRasterMask(SOLAR_CANOPY_STORAGE_KEY, solarCanopyMask);
    if (solarCanopyIcons.length) localStorage.setItem(SOLAR_CANOPY_ICONS_STORAGE_KEY, JSON.stringify(solarCanopyIcons));
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 1600);
  };

  const resetWorkspace = async () => {
    if (simulationJob && ["queued", "running"].includes(simulationJob.state)) {
      try {
        await fetch(`/api/solweig/run/${simulationJob.id}`, { method: "DELETE" });
      } catch {
        // Local state is still safe to reset if the process has already stopped.
      }
    }
    if (policyScoreJob && ["queued", "running"].includes(policyScoreJob.state)) {
      try {
        await fetch(`/api/scoring/run/${policyScoreJob.id}`, { method: "DELETE" });
      } catch {
        // The score process may already have stopped; browser state can still reset.
      }
    }
    localStorage.removeItem(TREE_STORAGE_KEY);
    localStorage.removeItem(SIMULATION_STORAGE_KEY);
    localStorage.removeItem(BASELINE_STORAGE_KEY);
    localStorage.removeItem(POLICY_SCORE_STORAGE_KEY);
    localStorage.removeItem(REFLECTIVE_STORAGE_KEY);
    localStorage.removeItem(COOL_ROOF_STORAGE_KEY);
    localStorage.removeItem(GREEN_ROOF_STORAGE_KEY);
    localStorage.removeItem(DEPAVED_STORAGE_KEY);
    localStorage.removeItem(SHADE_CANOPY_STORAGE_KEY);
    localStorage.removeItem(SHADE_CANOPY_ICONS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SHADE_CANOPY_ICONS_STORAGE_KEY);
    localStorage.removeItem(SOLAR_CANOPY_STORAGE_KEY);
    localStorage.removeItem(SOLAR_CANOPY_ICONS_STORAGE_KEY);
    window.location.reload();
  };

  const selectStudyArea = (area: OverviewArea) => {
    localStorage.setItem(STUDY_AREA_STORAGE_KEY, area.id);
    if (area.id === ACTIVE_AOI) setOverviewOpen(false);
    else window.location.reload();
  };

  const zoomAt = (nextZoom: number, anchorX: number, anchorY: number) => {
    setCamera((current) => {
      const zoom = Math.min(2.2, Math.max(0.65, nextZoom));
      const ratio = zoom / current.zoom;
      return {
        zoom,
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
      };
    });
  };

  const startPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, input")) return;
    if ((placementMode || brushMode || removalMode || reflectiveBrushMode || reflectiveSegmentMode || reflectiveEraseMode || depaveBrushMode || depaveBoxMode || depaveEraseMode || shadeCanopySegmentMode || shadeCanopyBrushMode || shadeCanopyEraseMode || solarCanopySegmentMode || solarCanopyBrushMode || solarCanopyEraseMode || coolRoofClickMode || coolRoofBrushMode || coolRoofBoxMode || coolRoofEraseMode) && (event.target as HTMLElement).closest(".raster-frame")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = { pointerX: event.clientX, pointerY: event.clientY, cameraX: camera.x, cameraY: camera.y };
    setIsPanning(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isPanning) return;
    setCamera((current) => ({
      ...current,
      x: dragOrigin.current.cameraX + event.clientX - dragOrigin.current.pointerX,
      y: dragOrigin.current.cameraY + event.clientY - dragOrigin.current.pointerY,
    }));
  };

  const endPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isPanning) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsPanning(false);
  };

  const wheelZoom = (event: ReactWheelEvent<HTMLElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    zoomAt(camera.zoom * (event.deltaY < 0 ? 1.12 : 0.89), event.clientX - bounds.left, event.clientY - bounds.top);
  };

  const setComparisonFromPointer = (clientX: number) => {
    const bounds = rasterFrameRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setComparisonSplit(Math.min(92, Math.max(8, ((clientX - bounds.left) / bounds.width) * 100)));
  };

  const startComparisonDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setComparisonDragging(true);
    setComparisonFromPointer(event.clientX);
  };

  const moveComparisonDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!comparisonDragging) return;
    event.stopPropagation();
    setComparisonFromPointer(event.clientX);
  };

  const endComparisonDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!comparisonDragging) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    setComparisonDragging(false);
  };

  const toggleLayer = (layer: Layer) => {
    if (!layer.ready) return;
    setVisible((current) => ({ ...current, [layer.id]: !current[layer.id] }));
  };

  const togglePlacement = () => {
    setDesignIntervention("trees");
    setPlacementMode((current) => !current);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const toggleBrush = () => {
    setDesignIntervention("trees");
    setBrushMode((current) => !current);
    setPlacementMode(false);
    setRemovalMode(false);
    setRemovalBox(null);
    setBrushCursor(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const toggleRemoval = () => {
    setDesignIntervention("trees");
    setRemovalMode((current) => !current);
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const activateReflectiveTool = (tool: "brush" | "segment" | "erase") => {
    setDesignIntervention("reflective");
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode((current) => tool === "brush" ? !current : false);
    setReflectiveSegmentMode((current) => tool === "segment" ? !current : false);
    setReflectiveEraseMode((current) => tool === "erase" ? !current : false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const activateDepaveTool = (tool: "brush" | "box" | "erase") => {
    setDesignIntervention("depave");
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode((current) => tool === "brush" ? !current : false);
    setDepaveBoxMode((current) => tool === "box" ? !current : false);
    setDepaveEraseMode((current) => tool === "erase" ? !current : false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const activateShadeCanopyTool = (tool: "segment" | "brush" | "erase") => {
    setDesignIntervention("shade_canopy");
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setShadeCanopySegmentMode((current) => tool === "segment" ? !current : false);
    setShadeCanopyBrushMode((current) => tool === "brush" ? !current : false);
    setShadeCanopyEraseMode((current) => tool === "erase" ? !current : false);
    setShadeCanopyEraseBox(null);
    setShadeCanopyCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const activateSolarCanopyTool = (tool: "segment" | "brush" | "erase") => {
    setDesignIntervention("solar_canopy");
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setShadeCanopySegmentMode(false);
    setShadeCanopyBrushMode(false);
    setShadeCanopyEraseMode(false);
    setShadeCanopyEraseBox(null);
    setShadeCanopyCursor(null);
    setSolarCanopySegmentMode((current) => tool === "segment" ? !current : false);
    setSolarCanopyBrushMode((current) => tool === "brush" ? !current : false);
    setSolarCanopyEraseMode((current) => tool === "erase" ? !current : false);
    setSolarCanopyEraseBox(null);
    setSolarCanopyCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const activateRoofTool = (kind: RoofKind, tool: "click" | "brush" | "box" | "erase") => {
    setDesignIntervention(kind);
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setCoolRoofClickMode((current) => tool === "click" ? !current : false);
    setCoolRoofBrushMode((current) => tool === "brush" ? !current : false);
    setCoolRoofBoxMode((current) => tool === "box" ? !current : false);
    setCoolRoofEraseMode((current) => tool === "erase" ? !current : false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const selectDesignIntervention = (intervention: "trees" | "reflective" | "depave" | "shade_canopy" | "solar_canopy" | RoofKind) => {
    setDesignIntervention(intervention);
    setPlacementMode(false);
    setBrushMode(false);
    setBrushCursor(null);
    setRemovalMode(false);
    setRemovalBox(null);
    setReflectiveBrushMode(false);
    setReflectiveSegmentMode(false);
    setReflectiveEraseMode(false);
    setReflectiveEraseBox(null);
    setReflectiveCursor(null);
    setDepaveBrushMode(false);
    setDepaveBoxMode(false);
    setDepaveEraseMode(false);
    setDepaveBox(null);
    setDepaveCursor(null);
    setShadeCanopySegmentMode(false);
    setShadeCanopyBrushMode(false);
    setShadeCanopyEraseMode(false);
    setShadeCanopyEraseBox(null);
    setShadeCanopyCursor(null);
    setSolarCanopySegmentMode(false);
    setSolarCanopyBrushMode(false);
    setSolarCanopyEraseMode(false);
    setSolarCanopyEraseBox(null);
    setSolarCanopyCursor(null);
    setCoolRoofClickMode(false);
    setCoolRoofBrushMode(false);
    setCoolRoofBoxMode(false);
    setCoolRoofEraseMode(false);
    setCoolRoofBox(null);
    setCoolRoofCursor(null);
  };

  const mapNoteTitle = autoresearchMode ? autoresearchLayoutReady ? `Archived iteration · ${autoresearchCandidate?.policy_name ?? "policy"}` : "Loading archived policy"
    : coolRoofEraseMode ? `Erase ${activeRoofLabel}s by area`
    : coolRoofBoxMode ? "Select buildings by area"
    : coolRoofBrushMode ? `Brush whole ${activeRoofLabel}s`
    : coolRoofClickMode ? "Select a whole roof"
    : shadeCanopyEraseMode ? "Erase shade canopies by area"
    : shadeCanopyBrushMode ? "Brush shade canopies"
    : shadeCanopySegmentMode ? "Select one side for shade canopies"
    : solarCanopyEraseMode ? "Erase solar canopies by area"
    : solarCanopyBrushMode ? "Brush solar canopies"
    : solarCanopySegmentMode ? "Select one side for solar canopies"
    : depaveEraseMode ? "Erase grass conversion by area"
    : depaveBoxMode ? "Select one side to convert"
    : depaveBrushMode ? "Brush pavement-to-grass conversion"
    : reflectiveEraseMode ? "Erase reflective pavement by area"
    : reflectiveSegmentMode ? "Select a street segment"
      : reflectiveBrushMode ? "Paint reflective coating"
        : removalMode ? "Remove trees"
          : brushMode ? "Brush trees"
            : placementMode ? "Place a tree"
              : activeView === "results" ? resultsUnavailable ? "SOLWEIG unavailable" : resultsAwaitingSolweig ? "Preparing SOLWEIG result" : simulatedMetric ? simulationMatchesLayout ? "SOLWEIG result" : "SOLWEIG-calibrated result" : baselineMetric ? hasInterventions ? "SOLWEIG baseline + fast estimate" : "SOLWEIG existing conditions" : "Screening estimate"
                : comparisonActive ? "Layer comparison" : manifest ? "Local layers ready" : "Loading local layers";
  const mapNoteDetail = autoresearchMode ? activeView === "design" ? "Read-only policy preview · use Copy to editable Design to make changes" : activeView === "results" ? "Archived layout is simulated automatically when a cached physical result is unavailable" : "Move through feasible iterations with the autoresearch controls"
    : coolRoofEraseMode ? "Drag a rectangle; every selected roof it touches is removed"
    : coolRoofBoxMode ? `Drag a rectangle across every building to receive a ${activeRoofLabel}`
    : coolRoofBrushMode ? "Drag the brush; touching any part applies the whole roof"
    : coolRoofClickMode ? "Click a building to toggle its entire roof"
    : shadeCanopyEraseMode ? "Drag a rectangle around canopy coverage to remove it"
    : shadeCanopyBrushMode ? "Drag over eligible non-road pavement; the surface treatment remains visible below"
    : shadeCanopySegmentMode ? "Click the desired side of a mapped segment; repeated canopy panels follow that side"
    : solarCanopyEraseMode ? "Drag a rectangle around solar-canopy coverage to remove it"
    : solarCanopyBrushMode ? "Drag over eligible non-road pavement; panels remain visible above ground treatments"
    : solarCanopySegmentMode ? "Click the desired side of a mapped segment; repeated PV panels follow that side"
    : depaveEraseMode ? "Drag a rectangle around proposed grass to restore baseline pavement"
    : depaveBoxMode ? "Click the desired side of a mapped segment; eligible non-road pavement on that side is converted"
    : depaveBrushMode ? "Drag over eligible non-road pavement; road lanes remain blocked"
    : reflectiveEraseMode ? "Drag a rectangle around the silver pavement to remove"
    : reflectiveSegmentMode ? "Click a mapped street; coating clips to pavement"
      : reflectiveBrushMode ? "Drag over roads, sidewalks, plazas, or parking pavement"
        : removalMode ? "Drag a rectangle around trees to delete them"
          : brushMode ? "Drag to paint policy-valid street trees · siting and budget enforced"
            : placementMode ? "Click a policy-valid planting location · siting and budget enforced"
              : resultsUnavailable ? "No fallback result map is displayed"
                : resultsAwaitingSolweig ? "The map will appear when the simulation completes"
                  : activeView === "results" && !hasInterventions ? "Existing conditions · scroll or use +/− to zoom"
                    : activeView === "results" || comparisonActive ? "Grab the comparison divider · scroll or use +/− to zoom" : "Drag to move · scroll or use +/− to zoom";

  const studyAreaLabel = manifest?.label ?? ACTIVE_AOI.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
  const gridPercent = (value: number, axis: "x" | "y" = "x") => (value / Math.max(axis === "x" ? manifest?.width ?? DEFAULT_GRID_SIZE : manifest?.height ?? DEFAULT_GRID_SIZE, 1)) * 100;
  const displayPixelsForMeters = (meters: number) => (meters / Math.max(manifest?.resolution_m ?? DEFAULT_RESOLUTION_M, 0.01)) * (MAP_DISPLAY_SIZE / Math.max(manifest?.width ?? DEFAULT_GRID_SIZE, 1));

  return (
    <div className={`app-shell ${autoresearchMode ? "autoresearch-active" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          <button className="icon-button mobile-menu" aria-label="Open menu"><Menu size={19} /></button>
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">SHADE</div>
            <div className="brand-caption">Urban cooling studio</div>
          </div>
        </div>

        <button className="project-title" onClick={() => setOverviewOpen(true)}>
          <span className="status-dot" />
          <span>{studyAreaLabel} study</span>
          <span className="bare-button" aria-hidden="true"><ChevronDown size={16} /></span>
        </button>

        <div className="top-actions">
          <button className={`button autoresearch-toggle ${autoresearchMode ? "active" : ""}`} onClick={autoresearchMode ? disableAutoresearch : enableAutoresearch}>
            <GitBranch size={16} /> {autoresearchMode ? "Autoresearch on" : "Autoresearch"}
          </button>
          <div className="offline-pill"><span /> Offline workspace</div>
          <button className="button secondary" disabled={autoresearchMode} title={autoresearchMode ? "Copy the archived policy to Design before saving it" : undefined} onClick={saveLayout}><Save size={16} /> {savedNotice ? "Saved" : "Save"}</button>
          <button className="button secondary reset-button" disabled={autoresearchMode} onClick={() => setResetConfirmOpen(true)}><RotateCcw size={16} /> Reset</button>
          <button className="icon-button" aria-label="Help"><CircleHelp size={19} /></button>
        </div>
      </header>

      {autoresearchMode && <AutoresearchNavigator
        activeAoi={ACTIVE_AOI}
        onLayout={applyAutoresearchLayout}
        onUnavailable={clearAutoresearchLayout}
        onCopy={copyAutoresearchToDesign}
        onSelectAoi={selectAutoresearchAoi}
      />}

      <aside className="rail" aria-label="Primary navigation">
        <button className={`rail-item ${activeView === "map" ? "active" : ""}`} onClick={openMap}><Map size={20} /><span>Map</span></button>
        <button className={`rail-item ${activeView === "design" ? "active" : ""}`} onClick={() => { setActiveView("design"); setComparisonActive(false); setPanelOpen(true); }}><TreePine size={20} /><span>Design</span></button>
        <button className={`rail-item ${activeView === "results" ? "active" : ""}`} title={hasInterventions ? "View intervention results" : "View existing-condition SOLWEIG results"} onClick={openResults}><Sparkles size={20} /><span>Results</span></button>
      </aside>

      <main className={`workspace ${panelOpen ? "" : "panel-collapsed"}`}>
        <section
          ref={mapStageRef}
          className={`map-stage ${isPanning ? "is-panning" : ""} ${placementMode ? "is-placing" : ""} ${brushMode ? "is-brushing" : ""} ${removalMode ? "is-removing" : ""} ${reflectiveBrushMode || reflectiveSegmentMode || reflectiveEraseMode ? "is-coating" : ""} ${depaveBrushMode || depaveBoxMode || depaveEraseMode ? "is-depaving" : ""} ${shadeCanopySegmentMode || shadeCanopyBrushMode || shadeCanopyEraseMode || solarCanopySegmentMode || solarCanopyBrushMode || solarCanopyEraseMode ? "is-canopying" : ""} ${coolRoofClickMode || coolRoofBrushMode || coolRoofBoxMode || coolRoofEraseMode ? "is-roofing" : ""}`}
          aria-label={`${studyAreaLabel} map preview`}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onWheel={wheelZoom}
        >
          <div
            className="map-paper"
            style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}
          >
            <div className="map-grid" />
            <div
              className={`raster-frame ${autoresearchMode ? "autoresearch-readonly" : ""}`}
              ref={rasterFrameRef}
              onClick={(event) => { placeTree(event); selectStreetSegment(event); selectDepaveSegment(event); selectShadeCanopySegment(event); selectSolarCanopySegment(event); selectCoolRoof(event); }}
              onPointerDown={(event) => { startRemovalBox(event); startBrushStroke(event); startReflectiveStroke(event); startReflectiveEraseBox(event); startDepaveStroke(event); startDepaveBox(event); startShadeCanopyStroke(event); startShadeCanopyEraseBox(event); startSolarCanopyStroke(event); startSolarCanopyEraseBox(event); startCoolRoofBrush(event); startCoolRoofBox(event); }}
              onPointerMove={(event) => { moveRemovalBox(event); moveBrushStroke(event); moveReflectiveStroke(event); moveReflectiveEraseBox(event); moveDepaveStroke(event); moveDepaveBox(event); moveShadeCanopyStroke(event); moveShadeCanopyEraseBox(event); moveSolarCanopyStroke(event); moveSolarCanopyEraseBox(event); moveCoolRoofBrush(event); moveCoolRoofBox(event); }}
              onPointerUp={(event) => { finishRemovalBox(event); finishBrushStroke(event); finishReflectiveStroke(event); finishReflectiveEraseBox(event); finishDepaveStroke(event); finishDepaveBox(event); finishShadeCanopyStroke(event); finishShadeCanopyEraseBox(event); finishSolarCanopyStroke(event); finishSolarCanopyEraseBox(event); finishCoolRoofBrush(event); finishCoolRoofBox(event); }}
              onPointerCancel={(event) => { setRemovalBox(null); setReflectiveEraseBox(null); setDepaveBox(null); setShadeCanopyEraseBox(null); setSolarCanopyEraseBox(null); setCoolRoofBox(null); finishBrushStroke(event); finishReflectiveStroke(event); finishDepaveStroke(event); finishShadeCanopyStroke(event); finishSolarCanopyStroke(event); finishCoolRoofBrush(event); }}
              onPointerLeave={() => { if (!brushStrokeActive.current) setBrushCursor(null); if (!reflectiveStrokeActive.current) setReflectiveCursor(null); if (!depaveStrokeActive.current) setDepaveCursor(null); if (!shadeCanopyStrokeActive.current) setShadeCanopyCursor(null); if (!solarCanopyStrokeActive.current) setSolarCanopyCursor(null); if (!coolRoofStrokeActive.current) setCoolRoofCursor(null); }}
            >
              {visible.base && <img className="raster-layer" src={`${dataRoot}/base.png`} alt={`${studyAreaLabel} local cartographic base`} draggable="false" />}
              {manifest ? (
                <InterventionMapLayers
                  showLand={Boolean(visible.land)}
                  showCanopy={Boolean(visible.canopy)}
                  trees={trees}
                  width={manifest.width}
                  height={manifest.height}
                  dataRoot={dataRoot}
                  resolutionM={manifest.resolution_m}
                  comparisonActive={comparisonActive && (!resultVisible || resultDataReady)}
                  afterClipPercent={comparisonClip}
                />
              ) : <>
                {visible.land && <img className="raster-layer" src={`${dataRoot}/landcover.png`} alt={`${studyAreaLabel} land-cover classes`} draggable="false" />}
                {visible.canopy && <img className="raster-layer" src={`${dataRoot}/canopy.png`} alt={`${studyAreaLabel} tree-canopy height`} draggable="false" />}
              </>}
              {depavedPixelCount > 0 && activeView !== "results" && (
                <DepavedLayer
                  mask={depavedMask}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  textured={activeView === "design"}
                />
              )}
              {shadeCanopyPixelCount > 0 && activeView !== "results" && (
                <ShadeCanopyLayer
                  mask={shadeCanopyMask}
                  icons={shadeCanopyIcons}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  detailed={activeView === "design"}
                />
              )}
              {solarCanopyPixelCount > 0 && activeView !== "results" && (
                <ShadeCanopyLayer
                  mask={solarCanopyMask}
                  icons={solarCanopyIcons}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  detailed={activeView === "design"}
                  variant="solar"
                />
              )}
              {reflectivePixelCount > 0 && activeView !== "results" && (
                <ReflectivePavementLayer
                  mask={reflectiveMask}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  textured={activeView === "design"}
                />
              )}
              {coolRoofPixelCount > 0 && activeView !== "results" && (
                <CoolRoofLayer
                  mask={coolRoofMask}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  textured={activeView === "design"}
                />
              )}
              {greenRoofPixelCount > 0 && activeView !== "results" && (
                <GreenRoofLayer
                  mask={greenRoofMask}
                  comparisonActive={activeView === "map" && comparisonActive}
                  afterClipPercent={comparisonClip}
                  textured={activeView === "design"}
                />
              )}
              {visible.heat && <img className="raster-layer heat-layer" src={`${dataRoot}/heat_ta3pm.png`} alt={`${studyAreaLabel} 3 PM air-temperature model`} draggable="false" />}
              {resultRasterVisible && manifest?.screening_metrics && metricDisplayMin !== undefined && metricDisplayMax !== undefined && (
                <ScreeningMetricLayer
                  metric={metric}
                  trees={trees}
                  reflectiveMask={reflectiveMask}
                  width={manifest.width}
                  height={manifest.height}
                  metricsUrl={`${dataRoot}/${manifest.screening_metrics.file}`}
                  resolutionM={manifest.resolution_m}
                  displayMin={metricDisplayMin}
                  displayMax={metricDisplayMax}
                  afterClipPercent={comparisonClip}
                  comparisonActive={comparisonActive}
                  simulation={mapSimulation}
                />
              )}
              <div className="aoi-edge" />
              {activeView === "design" && <div className="tree-intervention-layer">
                {trees.map((tree, index) => (
                  <button
                    key={tree.id}
                    className={`tree-marker ${selectedTreeId === tree.id ? "selected" : ""}`}
                    style={{ left: `${gridPercent(tree.x)}%`, top: `${gridPercent(tree.y, "y")}%`, "--tree-marker-size": `${tree.size === "small" ? 14 : 17}px` } as CSSProperties}
                    aria-label={`Tree ${index + 1}, ${tree.size}`}
                    title={`${tree.size === "small" ? "Small" : "Medium"} tree · ${tree.crownDiameterM} m crown`}
                    onClick={(event) => {
                      if (reflectiveBrushMode || reflectiveSegmentMode || reflectiveEraseMode || depaveBrushMode || depaveBoxMode || depaveEraseMode || shadeCanopySegmentMode || shadeCanopyBrushMode || shadeCanopyEraseMode || solarCanopySegmentMode || solarCanopyBrushMode || solarCanopyEraseMode || coolRoofClickMode || coolRoofBrushMode || coolRoofBoxMode || coolRoofEraseMode) return;
                      event.stopPropagation();
                      setSelectedTreeId(tree.id);
                    }}
                    onPointerDown={(event) => startTreeDrag(event, tree.id)}
                    onPointerMove={moveTree}
                    onPointerUp={endTreeDrag}
                    onPointerCancel={endTreeDrag}
                  >
                    <img src="/assets/tree-cel.png" alt="" draggable="false" />
                  </button>
                ))}
              </div>}
              {brushMode && brushCursor && (
                <div
                  className="brush-cursor"
                  style={{
                    left: `${gridPercent(brushCursor.x)}%`,
                    top: `${gridPercent(brushCursor.y, "y")}%`,
                    width: `${displayPixelsForMeters(brushDiameterM)}px`,
                    height: `${displayPixelsForMeters(brushDiameterM)}px`,
                  }}
                />
              )}
              {reflectiveBrushMode && reflectiveCursor && (
                <div
                  className="reflective-brush-cursor"
                  style={{
                    left: `${gridPercent(reflectiveCursor.x)}%`,
                    top: `${gridPercent(reflectiveCursor.y, "y")}%`,
                    width: `${displayPixelsForMeters(reflectiveBrushDiameterM)}px`,
                    height: `${displayPixelsForMeters(reflectiveBrushDiameterM)}px`,
                  }}
                />
              )}
              {depaveBrushMode && depaveCursor && (
                <div className="depave-brush-cursor" style={{
                  left: `${gridPercent(depaveCursor.x)}%`,
                  top: `${gridPercent(depaveCursor.y, "y")}%`,
                  width: `${displayPixelsForMeters(depaveBrushDiameterM)}px`,
                  height: `${displayPixelsForMeters(depaveBrushDiameterM)}px`,
                }} />
              )}
              {shadeCanopyBrushMode && shadeCanopyCursor && (
                <div className="shade-canopy-brush-cursor" style={{
                  left: `${gridPercent(shadeCanopyCursor.x)}%`,
                  top: `${gridPercent(shadeCanopyCursor.y, "y")}%`,
                  width: `${displayPixelsForMeters(shadeCanopyBrushDiameterM)}px`,
                  height: `${displayPixelsForMeters(shadeCanopyBrushDiameterM)}px`,
                }} />
              )}
              {solarCanopyBrushMode && solarCanopyCursor && (
                <div className="solar-canopy-brush-cursor" style={{
                  left: `${gridPercent(solarCanopyCursor.x)}%`,
                  top: `${gridPercent(solarCanopyCursor.y, "y")}%`,
                  width: `${displayPixelsForMeters(solarCanopyBrushDiameterM)}px`,
                  height: `${displayPixelsForMeters(solarCanopyBrushDiameterM)}px`,
                }} />
              )}
              {coolRoofBrushMode && coolRoofCursor && (
                <div
                  className={`cool-roof-brush-cursor ${activeRoofKind === "green_roof" ? "green" : ""}`}
                  style={{
                    left: `${gridPercent(coolRoofCursor.x)}%`,
                    top: `${gridPercent(coolRoofCursor.y, "y")}%`,
                    width: `${displayPixelsForMeters(coolRoofBrushDiameterM)}px`,
                    height: `${displayPixelsForMeters(coolRoofBrushDiameterM)}px`,
                  }}
                />
              )}
              {removalBox && (
                <div
                  className="removal-box"
                  style={{
                    left: `${gridPercent(Math.min(removalBox.startX, removalBox.currentX))}%`,
                    top: `${gridPercent(Math.min(removalBox.startY, removalBox.currentY), "y")}%`,
                    width: `${gridPercent(Math.abs(removalBox.currentX - removalBox.startX))}%`,
                    height: `${gridPercent(Math.abs(removalBox.currentY - removalBox.startY), "y")}%`,
                  }}
                />
              )}
              {coolRoofBox && (
                <div
                  className={`cool-roof-box ${activeRoofKind === "green_roof" ? "green" : ""} ${coolRoofEraseMode ? "erase" : ""}`}
                  style={{
                    left: `${gridPercent(Math.min(coolRoofBox.startX, coolRoofBox.currentX))}%`,
                    top: `${gridPercent(Math.min(coolRoofBox.startY, coolRoofBox.currentY), "y")}%`,
                    width: `${gridPercent(Math.abs(coolRoofBox.currentX - coolRoofBox.startX))}%`,
                    height: `${gridPercent(Math.abs(coolRoofBox.currentY - coolRoofBox.startY), "y")}%`,
                  }}
                />
              )}
              {reflectiveEraseBox && (
                <div
                  className="reflective-erase-box"
                  style={{
                    left: `${gridPercent(Math.min(reflectiveEraseBox.startX, reflectiveEraseBox.currentX))}%`,
                    top: `${gridPercent(Math.min(reflectiveEraseBox.startY, reflectiveEraseBox.currentY), "y")}%`,
                    width: `${gridPercent(Math.abs(reflectiveEraseBox.currentX - reflectiveEraseBox.startX))}%`,
                    height: `${gridPercent(Math.abs(reflectiveEraseBox.currentY - reflectiveEraseBox.startY), "y")}%`,
                  }}
                />
              )}
              {depaveBox && (
                <div className={`depave-box ${depaveEraseMode ? "erase" : ""}`} style={{
                  left: `${gridPercent(Math.min(depaveBox.startX, depaveBox.currentX))}%`,
                  top: `${gridPercent(Math.min(depaveBox.startY, depaveBox.currentY), "y")}%`,
                  width: `${gridPercent(Math.abs(depaveBox.currentX - depaveBox.startX))}%`,
                  height: `${gridPercent(Math.abs(depaveBox.currentY - depaveBox.startY), "y")}%`,
                }} />
              )}
              {shadeCanopyEraseBox && (
                <div className="shade-canopy-erase-box" style={{
                  left: `${gridPercent(Math.min(shadeCanopyEraseBox.startX, shadeCanopyEraseBox.currentX))}%`,
                  top: `${gridPercent(Math.min(shadeCanopyEraseBox.startY, shadeCanopyEraseBox.currentY), "y")}%`,
                  width: `${gridPercent(Math.abs(shadeCanopyEraseBox.currentX - shadeCanopyEraseBox.startX))}%`,
                  height: `${gridPercent(Math.abs(shadeCanopyEraseBox.currentY - shadeCanopyEraseBox.startY), "y")}%`,
                }} />
              )}
              {solarCanopyEraseBox && (
                <div className="solar-canopy-erase-box" style={{
                  left: `${gridPercent(Math.min(solarCanopyEraseBox.startX, solarCanopyEraseBox.currentX))}%`,
                  top: `${gridPercent(Math.min(solarCanopyEraseBox.startY, solarCanopyEraseBox.currentY), "y")}%`,
                  width: `${gridPercent(Math.abs(solarCanopyEraseBox.currentX - solarCanopyEraseBox.startX))}%`,
                  height: `${gridPercent(Math.abs(solarCanopyEraseBox.currentY - solarCanopyEraseBox.startY), "y")}%`,
                }} />
              )}
              <div className="raster-caption"><strong>{studyAreaLabel.toUpperCase()}</strong><span>{manifest?.resolution_m ?? DEFAULT_RESOLUTION_M} m local grid · EPSG:26986</span></div>
            </div>
          </div>

          {(resultsAwaitingSolweig || resultsUnavailable) && (
            <div className={`results-loading-overlay ${resultsUnavailable ? "error" : ""}`} role="status" aria-live="polite">
              <div className="results-loading-card">
                <span className="results-loading-icon">{resultsUnavailable ? <Info size={22} /> : <Cpu size={22} />}</span>
                <div className="results-loading-copy">
                  <strong>{resultsUnavailable ? "SOLWEIG result unavailable" : "SOLWEIG simulation running"}</strong>
                  <span>{resultsUnavailable ? simulationError ?? "The local SOLWEIG environment is not ready." : resultLoadingStage}</span>
                </div>
                {!resultsUnavailable && <output>{activeSimulationRunning ? `${resultLoadingProgress}%` : "Preparing"}</output>}
                {!resultsUnavailable && <progress max="100" value={activeSimulationRunning ? resultLoadingProgress : undefined} />}
                <small>{resultsUnavailable ? "No earlier or approximate temperature map is being substituted." : "The result map will appear automatically when this run finishes."}</small>
              </div>
            </div>
          )}

          <div className="map-note">
            <span className={`note-icon ${removalMode || reflectiveEraseMode || depaveEraseMode || shadeCanopyEraseMode || solarCanopyEraseMode || coolRoofEraseMode ? "remove" : ""}`}>{removalMode || reflectiveEraseMode || depaveEraseMode || shadeCanopyEraseMode || solarCanopyEraseMode || coolRoofEraseMode ? <Trash2 size={16} /> : brushMode || reflectiveBrushMode || depaveBrushMode || shadeCanopyBrushMode || solarCanopyBrushMode || coolRoofBrushMode ? <Paintbrush size={16} /> : placementMode ? <Plus size={16} /> : shadeCanopySegmentMode || solarCanopySegmentMode ? <Umbrella size={16} /> : coolRoofClickMode ? <Building2 size={16} /> : coolRoofBoxMode || reflectiveSegmentMode || depaveBoxMode ? <MousePointer2 size={16} /> : activeView === "results" ? resultsUnavailable ? <Info size={16} /> : resultsAwaitingSolweig || simulatedMetric || baselineMetric ? <Cpu size={16} /> : <Sparkles size={16} /> : <Layers3 size={16} />}</span>
            <div><strong>{mapNoteTitle}</strong><span>{mapNoteDetail}</span></div>
          </div>

          {placementNotice && <div className="placement-notice" role="status">{placementNotice}</div>}

          {(resultVisible || visible.heat || visible.canopy || visible.land) && (
            <div className="legend-stack">
              {resultRasterVisible && manifest?.screening_metrics && metricDisplayMin !== undefined && metricDisplayMax !== undefined && <div className="map-legend estimate-legend"><strong>{metricDefinition.label} · {simulatedMetric ? simulationMatchesLayout ? "SOLWEIG" : "SOLWEIG + adjustment" : baselineMetric ? hasInterventions ? "SOLWEIG baseline + adjustment" : "SOLWEIG baseline" : "approximate"}</strong><div className="screening-ramp" /><div className="legend-range"><span>{metricDisplayMin.toFixed(1)}°C</span><span>{metricDisplayMax.toFixed(1)}°C</span></div><small>{hasInterventions ? resultRequiresSimulation ? solarCanopyRequiresSimulation ? "Solar canopies require full SOLWEIG" : shadeCanopyRequiresSimulation ? "Shade canopies require full SOLWEIG" : depavedRequiresSimulation ? "Grass conversion requires full SOLWEIG" : roofRequiresSimulation ? "Roof treatments require full SOLWEIG" : "Coating MRT requires full SOLWEIG" : "Baseline left · intervention right" : "Existing conditions"}</small></div>}
              {visible.heat && <div className="map-legend"><strong>3 PM air temperature</strong><div className="heat-ramp" /><div className="legend-range"><span>{manifest?.heat_ta3pm_c.display_min ?? "–"}°C</span><span>{manifest?.heat_ta3pm_c.display_max ?? "–"}°C</span></div></div>}
              {visible.canopy && <div className="map-legend"><strong>Canopy height</strong><div className="canopy-ramp" /><div className="legend-range"><span>Low</span><span>25+ m</span></div>{trees.length > 0 && <small>Includes {trees.length} proposed crown{trees.length === 1 ? "" : "s"} on the intervention side</small>}</div>}
              {visible.land && <div className="map-legend"><strong>Land cover · buildings/existing canopy excluded</strong><div className="landcover-key"><span className="paved">Pavement</span><span className="vegetation">Grass / soil</span><span className="water">Water</span></div>{trees.length > 0 && <small>Proposed tree footprint uses the existing vegetation color</small>}</div>}
              {reflectivePixelCount > 0 && activeView !== "results" && <div className="map-legend reflective-legend"><strong>Reflective pavement</strong><div className="reflective-legend-swatch" /><small>{Math.round(reflectiveAreaM2).toLocaleString()} m² · proposed albedo 0.45</small></div>}
              {coolRoofPixelCount > 0 && activeView !== "results" && <div className="map-legend cool-roof-legend"><strong>Cool roofs</strong><div className="cool-roof-legend-swatch" /><small>{Math.round(coolRoofAreaM2).toLocaleString()} m² · proposed albedo 0.50</small></div>}
              {greenRoofPixelCount > 0 && activeView !== "results" && <div className="map-legend green-roof-legend"><strong>Green roofs</strong><div className="green-roof-legend-swatch" /><small>{Math.round(greenRoofAreaM2).toLocaleString()} m² · vegetation · albedo 0.25</small></div>}
              {depavedPixelCount > 0 && activeView !== "results" && <div className="map-legend depaved-legend"><strong>Converted to grass</strong><div className="depaved-legend-swatch" /><small>{Math.round(depavedAreaM2).toLocaleString()} m² · non-road pavement · albedo 0.25</small></div>}
              {shadeCanopyPixelCount > 0 && activeView !== "results" && <div className="map-legend shade-canopy-legend"><strong>Shade canopies</strong><div className="shade-canopy-legend-swatch" /><small>{Math.round(shadeCanopyAreaM2).toLocaleString()} m² · 3 m high · 50% transmission approximation</small></div>}
              {solarCanopyPixelCount > 0 && activeView !== "results" && <div className="map-legend solar-canopy-legend"><strong>PV solar canopies</strong><div className="solar-canopy-legend-swatch" /><small>{Math.round(solarCanopyAreaM2).toLocaleString()} m² · 3.5 m high · full-footprint shade</small></div>}
            </div>
          )}

          <div className="map-toolbar">
            <button className={`tool-button ${activeView === "map" ? "active" : ""}`} onClick={openMap}><Layers3 size={17} /> Layers</button>
            {!autoresearchMode && <>
            {activeView === "design" && designIntervention === "trees" && <button className={`tool-button ${placementMode ? "active placement-active" : ""}`} onClick={togglePlacement}><TreePine size={17} /> {placementMode ? "Finish placing" : "Place trees"}</button>}
            {activeView === "design" && designIntervention === "trees" && <button className={`tool-button ${brushMode ? "active placement-active" : ""}`} onClick={toggleBrush}><Paintbrush size={16} /> {brushMode ? "Finish brushing" : "Brush trees"}</button>}
            {activeView === "design" && designIntervention === "trees" && <button className={`tool-button remove-tool ${removalMode ? "active" : ""}`} onClick={toggleRemoval}><Trash2 size={16} /> {removalMode ? "Finish removing" : "Remove trees"}</button>}
            {activeView === "design" && designIntervention === "reflective" && <button className={`tool-button ${reflectiveBrushMode ? "active placement-active" : ""}`} onClick={() => activateReflectiveTool("brush")}><Paintbrush size={16} /> {reflectiveBrushMode ? "Finish painting" : "Paint coating"}</button>}
            {activeView === "design" && designIntervention === "reflective" && <button className={`tool-button ${reflectiveSegmentMode ? "active placement-active" : ""}`} onClick={() => activateReflectiveTool("segment")}><MousePointer2 size={16} /> {reflectiveSegmentMode ? "Finish selecting" : "Select segment"}</button>}
            {activeView === "design" && designIntervention === "reflective" && <button className={`tool-button remove-tool ${reflectiveEraseMode ? "active" : ""}`} onClick={() => activateReflectiveTool("erase")}><Trash2 size={16} /> {reflectiveEraseMode ? "Finish erasing" : "Erase area"}</button>}
            {activeView === "design" && designIntervention === "depave" && <button className={`tool-button ${depaveBrushMode ? "active placement-active" : ""}`} onClick={() => activateDepaveTool("brush")}><Paintbrush size={16} /> {depaveBrushMode ? "Finish brushing" : "Brush grass"}</button>}
            {activeView === "design" && designIntervention === "depave" && <button className={`tool-button ${depaveBoxMode ? "active placement-active" : ""}`} onClick={() => activateDepaveTool("box")}><MousePointer2 size={16} /> {depaveBoxMode ? "Finish selecting" : "Select side"}</button>}
            {activeView === "design" && designIntervention === "depave" && <button className={`tool-button remove-tool ${depaveEraseMode ? "active" : ""}`} onClick={() => activateDepaveTool("erase")}><Trash2 size={16} /> {depaveEraseMode ? "Finish erasing" : "Erase area"}</button>}
            {activeView === "design" && designIntervention === "shade_canopy" && <button className={`tool-button ${shadeCanopySegmentMode ? "active placement-active" : ""}`} onClick={() => activateShadeCanopyTool("segment")}><Umbrella size={16} /> {shadeCanopySegmentMode ? "Finish selecting" : "Select side"}</button>}
            {activeView === "design" && designIntervention === "shade_canopy" && <button className={`tool-button ${shadeCanopyBrushMode ? "active placement-active" : ""}`} onClick={() => activateShadeCanopyTool("brush")}><Paintbrush size={16} /> {shadeCanopyBrushMode ? "Finish brushing" : "Brush canopies"}</button>}
            {activeView === "design" && designIntervention === "shade_canopy" && <button className={`tool-button remove-tool ${shadeCanopyEraseMode ? "active" : ""}`} onClick={() => activateShadeCanopyTool("erase")}><Trash2 size={16} /> {shadeCanopyEraseMode ? "Finish erasing" : "Erase area"}</button>}
            {activeView === "design" && designIntervention === "solar_canopy" && <button className={`tool-button ${solarCanopySegmentMode ? "active placement-active" : ""}`} onClick={() => activateSolarCanopyTool("segment")}><Umbrella size={16} /> {solarCanopySegmentMode ? "Finish selecting" : "Select side"}</button>}
            {activeView === "design" && designIntervention === "solar_canopy" && <button className={`tool-button ${solarCanopyBrushMode ? "active placement-active" : ""}`} onClick={() => activateSolarCanopyTool("brush")}><Paintbrush size={16} /> {solarCanopyBrushMode ? "Finish brushing" : "Brush panels"}</button>}
            {activeView === "design" && designIntervention === "solar_canopy" && <button className={`tool-button remove-tool ${solarCanopyEraseMode ? "active" : ""}`} onClick={() => activateSolarCanopyTool("erase")}><Trash2 size={16} /> {solarCanopyEraseMode ? "Finish erasing" : "Erase area"}</button>}
            {activeView === "design" && (designIntervention === "cool_roof" || designIntervention === "green_roof") && <button className={`tool-button ${coolRoofClickMode ? "active placement-active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "click")}><Building2 size={16} /> {coolRoofClickMode ? "Finish selecting" : "Select roof"}</button>}
            {activeView === "design" && (designIntervention === "cool_roof" || designIntervention === "green_roof") && <button className={`tool-button ${coolRoofBrushMode ? "active placement-active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "brush")}><Paintbrush size={16} /> {coolRoofBrushMode ? "Finish brushing" : "Brush roofs"}</button>}
            {activeView === "design" && (designIntervention === "cool_roof" || designIntervention === "green_roof") && <button className={`tool-button ${coolRoofBoxMode ? "active placement-active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "box")}><MousePointer2 size={16} /> {coolRoofBoxMode ? "Finish area" : "Select area"}</button>}
            {activeView === "design" && (designIntervention === "cool_roof" || designIntervention === "green_roof") && <button className={`tool-button remove-tool ${coolRoofEraseMode ? "active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "erase")}><Trash2 size={16} /> {coolRoofEraseMode ? "Finish erasing" : "Erase roofs"}</button>}
            </>}
            {activeView !== "design" && <button
              className={`tool-button ${comparisonActive ? "active" : ""} ${hasInterventions ? "" : "unavailable"}`}
              disabled={!hasInterventions}
              title={hasInterventions ? "Show baseline and intervention divider" : "Add an intervention to compare"}
              onClick={() => {
                const next = !comparisonActive;
                if (!next) {
                  setComparisonActive(false);
                } else if (activeView === "results") {
                  openResults();
                } else {
                  positionComparisonBeforeInterventions();
                  setComparisonActive(true);
                }
              }}
            >
              <SlidersHorizontal size={17} /> Before / after
            </button>}
          </div>

          <div className="zoom-controls">
            <button aria-label="Zoom in" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom * 1.2, 500, 420); }}>+</button>
            <button aria-label="Zoom out" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom / 1.2, 500, 420); }}>−</button>
          </div>
          <div className="north-arrow"><span>N</span><i /></div>
          <div className="scale">200 m</div>

          {(!resultVisible || resultDataReady) && comparisonActive && hasInterventions ? (
            <div className="comparison-ui" style={{ "--comparison-position": `${comparisonDividerX}px` } as CSSProperties}>
              <div className="comparison-side baseline-side"><span>Baseline</span><small>Existing conditions</small></div>
              <div className="comparison-side intervention-side"><span>With interventions</span><small>{activeView === "results" ? simulatedMetric ? simulationMatchesLayout ? "SOLWEIG result" : "SOLWEIG + adjustment" : baselineMetric ? "SOLWEIG + fast estimate" : "Screening estimate" : "Layer changes"}</small></div>
              <div className="comparison-hint">Grab divider to compare</div>
              <div
                className={`comparison-divider ${comparisonDragging ? "dragging" : ""}`}
                role="slider"
                tabIndex={0}
                aria-label="Baseline and intervention comparison position"
                aria-valuemin={8}
                aria-valuemax={92}
                aria-valuenow={Math.round(comparisonSplit)}
                onPointerDown={startComparisonDrag}
                onPointerMove={moveComparisonDrag}
                onPointerUp={endComparisonDrag}
                onPointerCancel={endComparisonDrag}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  setComparisonSplit((current) => Math.min(92, Math.max(8, current + (event.key === "ArrowLeft" ? -2 : 2))));
                }}
              ><span><SlidersHorizontal size={14} /></span></div>
            </div>
          ) : (!resultVisible || resultDataReady) ? <div className="comparison-label baseline-only">{resultVisible ? hasInterventions ? "Intervention estimate" : "Existing conditions" : "Baseline preview"}</div> : null}
        </section>

        <aside className={`control-panel ${panelOpen ? "" : "closed"} ${autoresearchMode ? "autoresearch-preview" : ""}`}>
          <div className="panel-header">
            <div><span className="eyebrow">{activeView === "map" ? "Explore" : activeView === "design" ? "Design" : resultsUnavailable ? "Unavailable" : resultsAwaitingSolweig ? "Initializing" : simulatedMetric ? "Simulation" : baselineMetric ? "Hybrid" : "Screening"}</span><h1>{activeView === "map" ? `${studyAreaLabel} baseline` : activeView === "design" ? designIntervention === "trees" ? "Tree interventions" : designIntervention === "reflective" ? "Reflective pavement" : designIntervention === "depave" ? "Pavement to grass" : designIntervention === "shade_canopy" ? "Shade canopies" : designIntervention === "solar_canopy" ? "PV solar canopies" : designIntervention === "green_roof" ? "Green roofs" : "Cool roofs" : resultsUnavailable ? "SOLWEIG unavailable" : resultsAwaitingSolweig ? "Preparing SOLWEIG" : simulatedMetric ? simulationMatchesLayout ? "SOLWEIG results" : "Calibrated results" : baselineMetric ? "SOLWEIG-based results" : "Estimated results"}</h1></div>
            <button className="icon-button" aria-label="Close controls" onClick={() => setPanelOpen(false)}><PanelRightClose size={19} /></button>
          </div>

          {activeView === "map" ? (
            <>
              <section className="panel-section">
                <div className="section-heading"><h2>Map layers</h2><span>{Object.values(visible).filter(Boolean).length} of 4</span></div>
                <div className="layer-list">
                  {layers.map((layer) => (
                    <button className={`layer-row ${layer.ready ? "" : "disabled"}`} key={layer.id} onClick={() => toggleLayer(layer)}>
                      <span className="swatch" style={{ background: layer.color }} />
                      <span className="layer-copy"><strong>{layer.label}</strong><small>{layer.detail}</small></span>
                      {!layer.ready && <span className="soon">Soon</span>}
                      {layer.ready && (visible[layer.id] ? <Eye size={17} /> : <EyeOff size={17} />)}
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel-section scenario-section">
                <div className="section-heading"><h2>Conditions</h2><CloudSun size={17} /></div>
                <label className="field-label" htmlFor="scenario">Climate scenario</label>
                <div className="select-wrap">
                  <select id="scenario" value={scenario} onChange={(event) => setScenario(event.target.value as ScenarioKey)}>
                    {(Object.entries(SCENARIOS) as [ScenarioKey, typeof SCENARIOS[ScenarioKey]][]).map(([key, option]) => (
                      <option key={key} value={key}>{option.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
                <span className="scenario-description">{selectedScenario.description}</span>
                <label className="field-label time-field-label">Time of day</label>
                <div className="time-selector" role="group" aria-label="Simulation time of day">
                  {TIME_OPTIONS.map((option) => (
                    <button
                      key={option.hour}
                      type="button"
                      className={`time-option ${option.body} ${simulationHour === option.hour ? "selected" : ""}`}
                      aria-pressed={simulationHour === option.hour}
                      aria-label={`${option.label}, ${option.detail}`}
                      title={`${option.label} · ${option.detail}`}
                      onClick={() => setSimulationHour(option.hour)}
                    >
                      <span className="sky-window" aria-hidden="true">
                        <span className="horizon" />
                        <span className="celestial-body" style={{ "--celestial-y": `${option.bodyY}px` } as CSSProperties}>
                          {option.body === "sun" ? <Sun size={17} /> : <Moon size={16} />}
                        </span>
                      </span>
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </button>
                  ))}
                </div>
                <div className="weather-card">
                  <div><strong>{selectedWeather.temperature.toFixed(1)}°</strong><span>Weather air temperature</span></div>
                  <div><strong>{selectedWeather.humidity}%</strong><span>Relative humidity</span></div>
                  <div><strong>{selectedWeather.wind.toFixed(1)} m/s</strong><span>Wind</span></div>
                </div>
                <p className="provenance-note">Boston Logan TMYx · July 27. Warming cases are uniform stress tests, not downscaled forecasts.</p>
              </section>

            </>
          ) : activeView === "design" ? (
            <>
              <section className="panel-section intervention-picker-section">
                <div className="section-heading"><h2>Intervention type</h2><span>7 options</span></div>
                <div className="intervention-picker">
                  <button className={designIntervention === "trees" ? "active" : ""} onClick={() => selectDesignIntervention("trees")}><TreePine size={17} /><span><strong>Trees</strong><small>Points and brush</small></span></button>
                  <button className={designIntervention === "reflective" ? "active" : ""} onClick={() => selectDesignIntervention("reflective")}><Sparkles size={17} /><span><strong>Reflective pavement</strong><small>{Math.round(reflectiveAreaM2).toLocaleString()} m² coated</small></span></button>
                  <button className={designIntervention === "cool_roof" ? "active" : ""} onClick={() => selectDesignIntervention("cool_roof")}><Building2 size={17} /><span><strong>Cool roofs</strong><small>{Math.round(coolRoofAreaM2).toLocaleString()} m² selected</small></span></button>
                  <button className={designIntervention === "green_roof" ? "active" : ""} onClick={() => selectDesignIntervention("green_roof")}><Building2 size={17} /><span><strong>Green roofs</strong><small>{Math.round(greenRoofAreaM2).toLocaleString()} m² selected</small></span></button>
                  <button className={designIntervention === "depave" ? "active" : ""} onClick={() => selectDesignIntervention("depave")}><Sprout size={17} /><span><strong>Pavement to grass</strong><small>{Math.round(depavedAreaM2).toLocaleString()} m² converted</small></span></button>
                  <button className={designIntervention === "shade_canopy" ? "active" : ""} onClick={() => selectDesignIntervention("shade_canopy")}><Umbrella size={17} /><span><strong>Shade canopies</strong><small>{Math.round(shadeCanopyAreaM2).toLocaleString()} m² proposed</small></span></button>
                  <button className={designIntervention === "solar_canopy" ? "active" : ""} onClick={() => selectDesignIntervention("solar_canopy")}><Sparkles size={17} /><span><strong>PV solar canopies</strong><small>{Math.round(solarCanopyAreaM2).toLocaleString()} m² proposed</small></span></button>
                </div>
              </section>
              {autoresearchMode && <section className="panel-section autoresearch-design-note">
                <strong>Archived intervention preview</strong>
                <span>The policy remains read-only while Autoresearch mode is on. Its tree and canopy icons are visible here; switch intervention types to inspect each treatment, or copy this iteration into Design to edit it.</span>
              </section>}
              {designIntervention === "trees" ? <>
              <section className="panel-section placement-section">
                <div className="section-heading"><h2>Add trees</h2><span>{trees.length} placed</span></div>
                <div className="tree-tool-card">
                  <img src="/assets/tree-cel.png" alt="Cel-shaded deciduous tree" />
                  <div><strong>Deciduous street tree</strong><span>Pedestrian planting pixels only; roadbeds, crossings, narrow walks, obstructions, existing canopy, overlaps, and overspend are blocked.</span></div>
                </div>
                <label className="field-label" htmlFor="new-tree-size">Placement size</label>
                <div className="select-wrap">
                  <select id="new-tree-size" value={newTreeSize} onChange={(event) => setNewTreeSize(event.target.value as TreeSize)}>
                    <option value="small">Small · 3 m crown</option>
                    <option value="medium">Medium · 5 m crown</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
                <div className="tree-mode-actions">
                  <button className={`placement-button ${placementMode ? "active" : ""}`} onClick={togglePlacement}>
                    {placementMode ? <MousePointer2 size={17} /> : <Plus size={17} />}
                    {placementMode ? "Finish" : "Single tree"}
                  </button>
                  <button className={`placement-button ${brushMode ? "active" : ""}`} onClick={toggleBrush}>
                    <Paintbrush size={16} />
                    {brushMode ? "Finish" : "Brush"}
                  </button>
                  <button className={`placement-button remove ${removalMode ? "active" : ""}`} onClick={toggleRemoval}>
                    <Trash2 size={16} />
                    {removalMode ? "Finish" : "Remove"}
                  </button>
                </div>
                {brushMode && (
                  <div className="brush-settings">
                    <label htmlFor="brush-diameter"><span>Brush diameter</span><output>{brushDiameterM} m</output></label>
                    <input id="brush-diameter" type="range" min="10" max="80" step="5" value={brushDiameterM} onChange={(event) => setBrushDiameterM(Number(event.target.value))} />
                    <label htmlFor="brush-density"><span>Tree density</span><output>{brushDensity} / 1,000 m²</output></label>
                    <input id="brush-density" type="range" min="2" max="24" step="1" value={brushDensity} onChange={(event) => setBrushDensity(Number(event.target.value))} />
                    <small>Drag one stroke to place separately selectable trees. One stroke is one undo action.</small>
                  </div>
                )}
                <div className={`placement-status ${placementMaskStatus}`}><span />{placementMaskStatus === "ready" ? "Strict policy siting check ready" : placementMaskStatus === "loading" ? "Loading strict policy siting check…" : "Placement check unavailable"}</div>
                {lastAction && (lastAction.type === "place" || lastAction.type === "remove") && (
                  <div className={`action-result ${lastAction.type}`}><span>{lastAction.type === "place" ? "Placed" : "Removed"} {lastAction.trees.length} tree{lastAction.trees.length === 1 ? "" : "s"}.</span><button onClick={undoLastAction}>Undo</button></div>
                )}
              </section>

              <section className="panel-section tree-editor-section">
                <div className="section-heading"><h2>Selected tree</h2>{selectedTree && <span>#{trees.findIndex((tree) => tree.id === selectedTree.id) + 1}</span>}</div>
                {selectedTree ? (
                  <div className="tree-editor">
                    <label className="field-label" htmlFor="tree-size">Size preset</label>
                    <div className="select-wrap">
                      <select id="tree-size" value={selectedTree.size} onChange={(event) => {
                        const size = event.target.value as TreeSize;
                        updateTree(selectedTree.id, { size, heightM: 5, crownDiameterM: size === "small" ? 3 : 5 });
                      }}>
                        <option value="small">Small street tree</option>
                        <option value="medium">Medium street tree</option>
                      </select>
                      <ChevronDown size={16} />
                    </div>
                    <div className="number-grid">
                      <label><span>Height</span><div><input type="number" min="2" max="30" step="0.5" value={selectedTree.heightM} onChange={(event) => updateTree(selectedTree.id, { heightM: Number(event.target.value) })} /><small>m</small></div></label>
                      <label><span>Crown diameter</span><div><input type="number" min="2" max="20" step="0.5" value={selectedTree.crownDiameterM} onChange={(event) => updateTree(selectedTree.id, { crownDiameterM: Number(event.target.value) })} /><small>m</small></div></label>
                    </div>
                    <div className="coordinate-row"><span>Position</span><strong>{manifest ? `${Math.round(manifest.bbox[0] + selectedTree.x)}, ${Math.round(manifest.bbox[3] - selectedTree.y)}` : `${Math.round(selectedTree.x)}, ${Math.round(selectedTree.y)}`}</strong><small>EPSG:26986</small></div>
                    <button className="delete-tree" onClick={() => { setActionHistory((current) => [...current, { type: "remove", trees: [selectedTree] }]); setTrees((current) => current.filter((tree) => tree.id !== selectedTree.id)); setSelectedTreeId(null); }}><Trash2 size={15} /> Delete tree</button>
                  </div>
                ) : (
                  <div className="empty-selection"><TreePine size={23} /><strong>No tree selected</strong><span>Place a new tree or click an existing tree on the map.</span></div>
                )}
              </section>
              </> : designIntervention === "reflective" ? <>
                <section className="panel-section reflective-section">
                  <div className="section-heading"><h2>Reflective pavement</h2><span>{Math.round(reflectiveAreaM2).toLocaleString()} m²</span></div>
                  <div className="reflective-tool-card">
                    <span className="reflective-swatch" aria-hidden="true" />
                    <div><strong>High-SRI coating</strong><span>Silver reflective treatment · pavement only · albedo 0.45</span></div>
                  </div>
                  <div className="tree-mode-actions reflective-mode-actions">
                    <button className={`placement-button ${reflectiveBrushMode ? "active" : ""}`} onClick={() => activateReflectiveTool("brush")}><Paintbrush size={16} />{reflectiveBrushMode ? "Finish" : "Brush"}</button>
                    <button className={`placement-button ${reflectiveSegmentMode ? "active" : ""}`} onClick={() => activateReflectiveTool("segment")}><MousePointer2 size={16} />{reflectiveSegmentMode ? "Finish" : "Segment"}</button>
                    <button className={`placement-button remove ${reflectiveEraseMode ? "active" : ""}`} onClick={() => activateReflectiveTool("erase")}><Trash2 size={16} />{reflectiveEraseMode ? "Finish" : "Erase area"}</button>
                  </div>
                  <div className="brush-settings reflective-settings">
                    <label htmlFor="reflective-diameter"><span>Coating width</span><output>{reflectiveBrushDiameterM} m</output></label>
                    <input id="reflective-diameter" type="range" min="4" max="40" step="2" value={reflectiveBrushDiameterM} onChange={(event) => setReflectiveBrushDiameterM(Number(event.target.value))} />
                    <small>The brush clips to any pavement. Segment selection follows one mapped street segment at this width. Erase uses a rectangle instead of this brush width.</small>
                  </div>
                  <div className={`placement-status ${pavementMaskStatus}`}><span />{pavementMaskStatus === "ready" ? `${streetSegments.length} street segments · offline pavement mask ready` : pavementMaskStatus === "loading" ? "Loading pavement map…" : "Pavement map unavailable"}</div>
                  <div className="reflective-totals"><div><span>Valid coated area</span><strong>{Math.round(reflectiveAreaM2).toLocaleString()} m²</strong></div><div><span>Estimated cost</span><strong>{formatCost(reflectiveCostEstimate)}</strong></div></div>
                  {lastAction && (lastAction.type === "reflective-paint" || lastAction.type === "reflective-erase") && (
                    <div className={`action-result ${lastAction.type === "reflective-paint" ? "place" : "remove"}`}><span>{lastAction.type === "reflective-paint" ? "Coated" : "Erased"} {pixelAreaM2(lastAction.pixels.length).toLocaleString()} m².</span><button onClick={undoLastAction}>Undo</button></div>
                  )}
                </section>
                <section className="panel-section reflective-model-section">
                  <div className="section-heading"><h2>Model behavior</h2><span>Shade overlap allowed</span></div>
                  <p>Full SOLWEIG runs combine the coating's per-pixel albedo with tree and building shadow. Before a full run, the map uses the Boston study's 6.1°C surface and 0.8°C perceived-temperature effects; MRT is left unestimated.</p>
                </section>
              </> : designIntervention === "depave" ? <>
                <section className="panel-section depave-section">
                  <div className="section-heading"><h2>Pavement to grass</h2><span>{Math.round(depavedAreaM2).toLocaleString()} m²</span></div>
                  <div className="depave-tool-card">
                    <span className="depave-swatch" aria-hidden="true" />
                    <div><strong>Low grass conversion</strong><span>Sidewalks, plazas, and parking · road lanes excluded · albedo 0.25</span></div>
                  </div>
                  <div className="tree-mode-actions depave-mode-actions">
                    <button className={`placement-button ${depaveBrushMode ? "active" : ""}`} onClick={() => activateDepaveTool("brush")}><Paintbrush size={16} />{depaveBrushMode ? "Finish" : "Brush"}</button>
                    <button className={`placement-button ${depaveBoxMode ? "active" : ""}`} onClick={() => activateDepaveTool("box")}><MousePointer2 size={16} />{depaveBoxMode ? "Finish" : "Select side"}</button>
                    <button className={`placement-button remove ${depaveEraseMode ? "active" : ""}`} onClick={() => activateDepaveTool("erase")}><Trash2 size={16} />{depaveEraseMode ? "Finish" : "Erase area"}</button>
                  </div>
                  {(depaveBrushMode || depaveBoxMode) && <div className="brush-settings depave-settings">
                    <label htmlFor="depave-diameter"><span>{depaveBoxMode ? "Segment conversion width" : "Brush diameter"}</span><output>{depaveBrushDiameterM} m</output></label>
                    <input id="depave-diameter" type="range" min="4" max="50" step="2" value={depaveBrushDiameterM} onChange={(event) => setDepaveBrushDiameterM(Number(event.target.value))} />
                    <small>The brush clips to eligible non-road pavement. Select side fills one side of a mapped street segment; erase uses a rectangle.</small>
                  </div>}
                  <div className={`placement-status ${depavableMaskStatus}`}><span />{depavableMaskStatus === "ready" ? "Offline sidewalk, plaza, and parking eligibility ready" : depavableMaskStatus === "loading" ? "Loading non-road pavement map…" : "Non-road pavement map unavailable"}</div>
                  <div className="reflective-totals"><div><span>Converted area</span><strong>{Math.round(depavedAreaM2).toLocaleString()} m²</strong></div><div><span>Estimated cost</span><strong>{formatCost(depavedCostEstimate)}</strong></div></div>
                  {lastAction && (lastAction.type === "depave-add" || lastAction.type === "depave-remove") && (
                    <div className={`action-result ${lastAction.type === "depave-add" ? "place" : "remove"}`}><span>{lastAction.type === "depave-add" ? "Converted" : "Restored"} {pixelAreaM2(lastAction.pixels.length).toLocaleString()} m².</span><button onClick={undoLastAction}>Undo</button></div>
                  )}
                  <p className="cool-roof-help">Grass conversion and reflective coating are mutually exclusive pixel by pixel. Applying either one replaces the other, and Undo restores it. Trees may be planted on converted grass.</p>
                </section>
                <section className="panel-section reflective-model-section">
                  <div className="section-heading"><h2>Model behavior</h2><span>Full simulation</span></div>
                  <p>No fast temperature effect is assumed. A full SOLWEIG run changes selected pavement from land-cover class 1 to class 5 grass, with albedo 0.25 and the model's grass thermal-response properties.</p>
                  <p>SOLWEIG does not explicitly model soil moisture or evapotranspiration here. Estimated implementation cost is $90/m².</p>
                </section>
              </> : designIntervention === "shade_canopy" ? <>
                <section className="panel-section shade-canopy-section">
                  <div className="section-heading"><h2>Shade canopies</h2><span>{Math.round(shadeCanopyAreaM2).toLocaleString()} m²</span></div>
                  <div className="shade-canopy-tool-card">
                    <span className="shade-canopy-swatch" aria-hidden="true"><i /><i /><i /></span>
                    <div><strong>Fabric shade canopy</strong><span>Repeated panels · 3 m high · approximately 50% sunlight transmission</span></div>
                  </div>
                  <div className="tree-mode-actions shade-canopy-mode-actions">
                    <button className={`placement-button ${shadeCanopySegmentMode ? "active" : ""}`} onClick={() => activateShadeCanopyTool("segment")}><Umbrella size={16} />{shadeCanopySegmentMode ? "Finish" : "Select side"}</button>
                    <button className={`placement-button ${shadeCanopyBrushMode ? "active" : ""}`} onClick={() => activateShadeCanopyTool("brush")}><Paintbrush size={16} />{shadeCanopyBrushMode ? "Finish" : "Brush"}</button>
                    <button className={`placement-button remove ${shadeCanopyEraseMode ? "active" : ""}`} onClick={() => activateShadeCanopyTool("erase")}><Trash2 size={16} />{shadeCanopyEraseMode ? "Finish" : "Erase area"}</button>
                  </div>
                  <div className="brush-settings shade-canopy-settings">
                    <label htmlFor="shade-canopy-width"><span>Segment canopy width</span><output>{shadeCanopyWidthM} m</output></label>
                    <input id="shade-canopy-width" type="range" min="3" max="14" step="1" value={shadeCanopyWidthM} onChange={(event) => setShadeCanopyWidthM(Number(event.target.value))} />
                    <label htmlFor="shade-canopy-brush-diameter"><span>Brush diameter</span><output>{shadeCanopyBrushDiameterM} m</output></label>
                    <input id="shade-canopy-brush-diameter" type="range" min="3" max="30" step="1" value={shadeCanopyBrushDiameterM} onChange={(event) => setShadeCanopyBrushDiameterM(Number(event.target.value))} />
                    <small>Select side and Brush use the shared sidewalk canopy eligibility map. Sail icons are spaced every {SHADE_CANOPY_ICON_SPACING_M} m and may bridge gaps up to {CANOPY_ICON_PAVEMENT_TOLERANCE_M} m from pavement, but never building roofs.</small>
                    <small>Fabric and PV canopies are alternative overhead treatments and cannot occupy the same pixel.</small>
                  </div>
                  <div className={`placement-status ${depavableMaskStatus}`}><span />{depavableMaskStatus === "ready" ? `${streetSegments.length} mapped segments · strict pedestrian siting ready` : depavableMaskStatus === "loading" ? "Loading policy-valid pavement and segments…" : "Canopy placement map unavailable"}</div>
                  <div className="reflective-totals"><div><span>Canopy area</span><strong>{Math.round(shadeCanopyAreaM2).toLocaleString()} m²</strong></div><div><span>Estimated cost</span><strong>{formatCost(shadeCanopyCostEstimate)}</strong></div></div>
                  {lastAction && (lastAction.type === "shade-canopy-add" || lastAction.type === "shade-canopy-remove") && (
                    <div className={`action-result ${lastAction.type === "shade-canopy-add" ? "place" : "remove"}`}><span>{lastAction.type === "shade-canopy-add" ? "Added" : "Removed"} {pixelAreaM2(lastAction.pixels.length).toLocaleString()} m².</span><button onClick={undoLastAction}>Undo</button></div>
                  )}
                </section>
                <section className="panel-section reflective-model-section">
                  <div className="section-heading"><h2>Model behavior</h2><span>Full simulation</span></div>
                  <p>No fast temperature effect is assumed. Full SOLWEIG runs add a thin overhead shade layer at 3 m while keeping the pavement below walkable.</p>
                  <p>Because SOLWEIG supports one vegetation transmissivity per run, the requested 50% fabric transmission is represented by a fine 50/50 shaded-and-open footprint. Trees retain their normal leaf-on transmissivity. Estimated cost is $200/m².</p>
                </section>
              </> : designIntervention === "solar_canopy" ? <>
                <section className="panel-section shade-canopy-section solar-canopy-section">
                  <div className="section-heading"><h2>PV solar canopies</h2><span>{Math.round(solarCanopyAreaM2).toLocaleString()} m²</span></div>
                  <div className="shade-canopy-tool-card solar-canopy-tool-card">
                    <span className="solar-canopy-swatch" aria-hidden="true"><i /><i /><i /></span>
                    <div><strong>Photovoltaic canopy</strong><span>Repeated opaque panels · 3.5 m high · electricity co-benefit</span></div>
                  </div>
                  <div className="tree-mode-actions shade-canopy-mode-actions">
                    <button className={`placement-button ${solarCanopySegmentMode ? "active" : ""}`} onClick={() => activateSolarCanopyTool("segment")}><Umbrella size={16} />{solarCanopySegmentMode ? "Finish" : "Select side"}</button>
                    <button className={`placement-button ${solarCanopyBrushMode ? "active" : ""}`} onClick={() => activateSolarCanopyTool("brush")}><Paintbrush size={16} />{solarCanopyBrushMode ? "Finish" : "Brush"}</button>
                    <button className={`placement-button remove ${solarCanopyEraseMode ? "active" : ""}`} onClick={() => activateSolarCanopyTool("erase")}><Trash2 size={16} />{solarCanopyEraseMode ? "Finish" : "Erase area"}</button>
                  </div>
                  <div className="brush-settings shade-canopy-settings">
                    <label htmlFor="solar-canopy-width"><span>Segment canopy width</span><output>{solarCanopyWidthM} m</output></label>
                    <input id="solar-canopy-width" type="range" min="3" max="14" step="1" value={solarCanopyWidthM} onChange={(event) => setSolarCanopyWidthM(Number(event.target.value))} />
                    <label htmlFor="solar-canopy-brush-diameter"><span>Brush diameter</span><output>{solarCanopyBrushDiameterM} m</output></label>
                    <input id="solar-canopy-brush-diameter" type="range" min="3" max="30" step="1" value={solarCanopyBrushDiameterM} onChange={(event) => setSolarCanopyBrushDiameterM(Number(event.target.value))} />
                    <small>Select side and Brush use the same sidewalk eligibility map as fabric canopies. PV icons are spaced every {SHADE_CANOPY_ICON_SPACING_M} m and may bridge gaps up to {CANOPY_ICON_PAVEMENT_TOLERANCE_M} m from pavement, but never building roofs.</small>
                    <small>PV and fabric canopies are alternative overhead treatments and cannot occupy the same pixel.</small>
                  </div>
                  <div className={`placement-status ${depavableMaskStatus}`}><span />{depavableMaskStatus === "ready" ? `${streetSegments.length} mapped segments · strict pedestrian siting ready` : depavableMaskStatus === "loading" ? "Loading policy-valid pavement and segments…" : "Solar-canopy placement map unavailable"}</div>
                  <div className="reflective-totals"><div><span>Canopy area</span><strong>{Math.round(solarCanopyAreaM2).toLocaleString()} m²</strong></div><div><span>Estimated cost</span><strong>{formatCost(solarCanopyCostEstimate)}</strong></div></div>
                  {lastAction && (lastAction.type === "solar-canopy-add" || lastAction.type === "solar-canopy-remove") && (
                    <div className={`action-result ${lastAction.type === "solar-canopy-add" ? "place" : "remove"}`}><span>{lastAction.type === "solar-canopy-add" ? "Added" : "Removed"} {pixelAreaM2(lastAction.pixels.length).toLocaleString()} m².</span><button onClick={undoLastAction}>Undo</button></div>
                  )}
                </section>
                <section className="panel-section reflective-model-section">
                  <div className="section-heading"><h2>Model behavior</h2><span>Full simulation</span></div>
                  <p>No fast temperature effect is assumed. Full SOLWEIG runs add a near-opaque overhead layer at 3.5 m while keeping the pavement below walkable.</p>
                  <p>PV canopies use every selected pixel rather than the fabric canopy's 50/50 footprint. SOLWEIG's shared leaf-on transmission leaves approximately 8% light through the modeled layer. Estimated implementation cost is $450/m²; electricity generation is noted as a co-benefit but is not yet quantified.</p>
                </section>
              </> : <>
                <section className={`panel-section cool-roof-section ${activeRoofKind === "green_roof" ? "green-roof-section" : ""}`}>
                  <div className="section-heading"><h2>{activeRoofKind === "green_roof" ? "Green roofs" : "Cool roofs"}</h2><span>{Math.round(activeRoofKind === "green_roof" ? greenRoofAreaM2 : coolRoofAreaM2).toLocaleString()} m²</span></div>
                  <div className={`cool-roof-tool-card ${activeRoofKind === "green_roof" ? "green-roof-tool-card" : ""}`}>
                    <span className={activeRoofKind === "green_roof" ? "green-roof-swatch" : "cool-roof-swatch"} aria-hidden="true" />
                    <div><strong>{activeRoofKind === "green_roof" ? "Extensive vegetated roof" : "Light-coloured roof treatment"}</strong><span>{activeRoofKind === "green_roof" ? "Whole mapped roofs · light green · albedo 0.25" : "Whole mapped roofs · light blue · albedo 0.50"}</span></div>
                  </div>
                  <div className="cool-roof-mode-actions">
                    <button className={`placement-button ${coolRoofClickMode ? "active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "click")}><Building2 size={16} />{coolRoofClickMode ? "Finish" : "Whole roof"}</button>
                    <button className={`placement-button ${coolRoofBrushMode ? "active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "brush")}><Paintbrush size={16} />{coolRoofBrushMode ? "Finish" : "Brush"}</button>
                    <button className={`placement-button ${coolRoofBoxMode ? "active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "box")}><MousePointer2 size={16} />{coolRoofBoxMode ? "Finish" : "Area select"}</button>
                    <button className={`placement-button remove ${coolRoofEraseMode ? "active" : ""}`} onClick={() => activateRoofTool(activeRoofKind, "erase")}><Trash2 size={16} />{coolRoofEraseMode ? "Finish" : "Erase area"}</button>
                  </div>
                  {coolRoofBrushMode && <div className="brush-settings cool-roof-brush-settings">
                    <label htmlFor="cool-roof-diameter"><span>Brush diameter</span><output>{coolRoofBrushDiameterM} m</output></label>
                    <input id="cool-roof-diameter" type="range" min="6" max="50" step="2" value={coolRoofBrushDiameterM} onChange={(event) => setCoolRoofBrushDiameterM(Number(event.target.value))} />
                    <small>Touching any pixel of a mapped building applies the treatment to that whole roof.</small>
                  </div>}
                  <div className={`placement-status ${roofRegionsStatus}`}><span />{roofRegionsStatus === "ready" ? "Whole-roof policy siting check ready" : roofRegionsStatus === "loading" ? "Loading policy-valid roof regions…" : "Roof selection map unavailable"}</div>
                  <div className="reflective-totals"><div><span>Selected roof area</span><strong>{Math.round(activeRoofKind === "green_roof" ? greenRoofAreaM2 : coolRoofAreaM2).toLocaleString()} m²</strong></div><div><span>Estimated cost</span><strong>{formatCost(activeRoofKind === "green_roof" ? greenRoofCostEstimate : coolRoofCostEstimate)}</strong></div></div>
                  {lastAction && (lastAction.type === "roof-add" || lastAction.type === "roof-remove") && lastAction.kind === activeRoofKind && (
                    <div className={`action-result ${lastAction.type === "roof-add" ? "place" : "remove"}`}><span>{lastAction.type === "roof-add" ? "Added" : "Removed"} {pixelAreaM2(lastAction.pixels.length).toLocaleString()} m² of roof.</span><button onClick={undoLastAction}>Undo</button></div>
                  )}
                  <p className="cool-roof-help">Click toggles one whole roof. The brush and area selector always apply complete roofs. Erase removes every selected roof intersecting its rectangle.</p>
                </section>
                <section className="panel-section reflective-model-section">
                  <div className="section-heading"><h2>Model behavior</h2><span>Full simulation</span></div>
                  <p>{activeRoofKind === "green_roof" ? "Green roofs are not given a fast temperature estimate. A full SOLWEIG run preserves each selected pixel as a building roof while applying albedo 0.25, emissivity 0.94, and SOLWEIG's grass thermal-response parameters." : "Cool roofs are not given a fast temperature estimate. Run SOLWEIG to model the selected roofs at albedo 0.50 together with building geometry, weather, shade, trees, and reflective pavement."}</p>
                  <p>{activeRoofKind === "green_roof" ? "Estimated implementation cost is $250/m². Selecting a green roof replaces any cool-roof treatment on that building; Undo restores it." : "Estimated implementation cost is $25/m². Selecting a cool roof replaces any green-roof treatment on that building; Undo restores it."}</p>
                </section>
              </>}
            </>
          ) : !resultDataReady ? (
            <section className={`panel-section results-waiting-section ${resultsUnavailable ? "error" : ""}`} aria-live="polite">
              <span className="results-waiting-icon">{resultsUnavailable ? <Info size={25} /> : <Cpu size={25} />}</span>
              <h2>{resultsUnavailable ? "No SOLWEIG result to display" : "Simulation in progress"}</h2>
              <p>{resultsUnavailable ? simulationError ?? "The local simulation environment is unavailable." : resultLoadingStage}</p>
              {!resultsUnavailable && (
                <div className="results-waiting-progress">
                  <div><span>Building the result map</span><output>{activeSimulationRunning ? `${resultLoadingProgress}%` : "Preparing"}</output></div>
                  <progress max="100" value={activeSimulationRunning ? resultLoadingProgress : undefined} />
                </div>
              )}
              <small>{resultsUnavailable ? "An earlier or approximate map will not be shown in its place." : "This panel and the map will update automatically when SOLWEIG finishes."}</small>
              {activeSimulationRunning && <button className="button secondary" onClick={cancelSimulation}><X size={14} /> Cancel run</button>}
            </section>
          ) : (
            <>
              <section className="panel-section result-summary-section">
                <div className={`estimate-status ${baselineJobRunning ? "hybrid" : simulatedMetric ? simulationMatchesLayout ? "simulated" : "hybrid" : baselineMetric ? "hybrid" : ""}`}>
                  {baselineJobRunning ? <Cpu size={15} /> : simulatedMetric ? simulationMatchesLayout ? <CheckCircle2 size={15} /> : <Cpu size={15} /> : baselineMetric ? <Cpu size={15} /> : <Sparkles size={15} />}
                  <span>{baselineJobRunning ? "Running initial SOLWEIG baseline" : simulatedMetric ? simulationMatchesLayout ? "SOLWEIG result" : "SOLWEIG-calibrated estimate" : baselineMetric ? hasInterventions ? "SOLWEIG baseline + fast estimate" : "SOLWEIG existing conditions" : "Screening estimate"}</span>
                  <small>{baselineJobRunning ? `${simulationJob?.progress ?? 0}%` : simulatedMetric ? simulationMatchesLayout ? "Current layout" : `${changedSinceSimulation} edit${changedSinceSimulation === 1 ? "" : "s"}` : baselineMetric ? hasInterventions ? "Baseline simulated · interventions estimated" : "No intervention" : metric === "surface" && simulationResult ? "Screening only" : "Not SOLWEIG"}</small>
                </div>
                <label className="field-label" htmlFor="result-metric">Result metric</label>
                <div className="select-wrap">
                  <select id="result-metric" value={metric} onChange={(event) => setMetric(event.target.value as MetricKey)}>
                    <option value="mrt">Mean radiant temperature{resultRequiresSimulation ? " · requires SOLWEIG" : ""}</option>
                    <option value="utci">UTCI / perceived temperature{roofRequiresSimulation || depavedRequiresSimulation || shadeCanopyRequiresSimulation || solarCanopyRequiresSimulation ? " · requires SOLWEIG" : ""}</option>
                    <option value="surface">Surface temperature{coolRoofPixelCount || greenRoofPixelCount || depavedPixelCount || shadeCanopyPixelCount || solarCanopyPixelCount ? " · unavailable for physical-only interventions" : ""}</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
                <div className="estimate-hero">
                  <span>{existingConditionsOnly ? metric === "utci" ? "Existing-condition walkable-area mean" : "Existing-condition area mean" : resultRequiresSimulation ? solarCanopyRequiresSimulation ? "Solar-canopy temperature effect" : shadeCanopyRequiresSimulation ? "Shade-canopy temperature effect" : depavedRequiresSimulation ? "Pavement-to-grass temperature effect" : roofRequiresSimulation ? "Roof-treatment temperature effect" : "Reflective-pavement MRT effect" : simulatedMetric ? metric === "utci" ? "Walkable-area mean effect" : "Study-area mean effect" : metric === "utci" ? "Estimated walkable-area effect" : "Estimated study-area effect"}</span>
                  <strong className={resultRequiresSimulation ? "text-result" : ""}>{resultRequiresSimulation ? "Not estimated" : existingConditionsOnly ? formatEstimate(resultHeroValue) : formatEffect(resultHeroValue)}</strong>
                  <small>{existingConditionsOnly ? `SOLWEIG · July 27 at ${selectedTime.label}` : resultRequiresSimulation ? solarCanopyRequiresSimulation ? "Run full SOLWEIG; no fast solar-canopy temperature value is assumed" : shadeCanopyRequiresSimulation ? "Run full SOLWEIG; no fast canopy temperature value is assumed" : depavedRequiresSimulation ? "Run full SOLWEIG; no fast grass-conversion temperature value is assumed" : roofRequiresSimulation ? "Run full SOLWEIG; no fast roof-treatment temperature value is assumed" : "Run full SOLWEIG to calculate reflected radiation together with shade" : simulatedMetric ? simulationMatchesLayout ? `SOLWEIG · ${simulationResult?.date} at ${simulationResult?.hour}:00` : "latest SOLWEIG result plus area-weighted heuristic edit delta" : baselineMetric ? "area-weighted fast adjustment over the SOLWEIG baseline" : "area-weighted screening estimate"}</small>
                </div>
                <div className="estimate-stats">
                  <div><span>Trees</span><strong>{trees.length}</strong></div>
                  <div><span>Added canopy</span><strong>{Math.round(addedCanopyArea).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>Reflective pavement</span><strong>{Math.round(reflectiveAreaM2).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>Cool roofs</span><strong>{Math.round(coolRoofAreaM2).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>Green roofs</span><strong>{Math.round(greenRoofAreaM2).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>Pavement converted to grass</span><strong>{Math.round(depavedAreaM2).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>Shade canopies</span><strong>{Math.round(shadeCanopyAreaM2).toLocaleString()} m²</strong></div>
                  <div className="wide"><span>PV solar canopies</span><strong>{Math.round(solarCanopyAreaM2).toLocaleString()} m²</strong></div>
                  {simulatedMetric && <div className="wide"><span>Mean {metric === "utci" ? "walkable-area " : ""}effect near simulated interventions</span><strong>{formatEffect(simulatedMetric.local_mean_reduction)}</strong></div>}
                  {!simulatedMetric && baselineMetric && !existingConditionsOnly && <div className="wide"><span>Existing-conditions SOLWEIG {metric === "utci" ? "walkable-area" : "area"} mean</span><strong>{formatEstimate(baselineMetric.baseline_mean)}</strong></div>}
                </div>
              </section>

              <section className="panel-section uncertainty-section">
                <div className="section-heading"><h2>Uncertainty</h2><span>{existingConditionsOnly || (simulatedMetric && simulationMatchesLayout) ? "Model output" : simulatedMetric || baselineMetric ? "Hybrid" : "Low confidence"}</span></div>
                <div className="uncertainty-range"><span>{existingConditionsOnly ? "Completed baseline" : resultRequiresSimulation ? "Physical interaction" : simulatedMetric && simulationMatchesLayout ? "Completed result" : "Indicative range"}</span><strong>{existingConditionsOnly ? formatEstimate(resultHeroValue) : resultRequiresSimulation ? "Requires full run" : simulatedMetric && simulationMatchesLayout ? formatEffect(estimateValue) : `${formatEstimate(estimateLow)}–${formatEstimate(estimateHigh)}`}</strong></div>
                <p><Info size={14} /> {existingConditionsOnly || (simulatedMetric && simulationMatchesLayout) ? "SOLWEIG models time-specific shade, radiation, weather, vegetation, and building geometry. Input quality and model assumptions still matter." : simulatedMetric ? `The completed SOLWEIG raster is retained; only the ${changedSinceSimulation} later edit${changedSinceSimulation === 1 ? "" : "s"} ${changedSinceSimulation === 1 ? "uses" : "use"} the ±${Math.round(uncertaintyFraction * 100)}% heuristic band.` : baselineMetric ? `The existing-conditions field is SOLWEIG output; the proposed-tree change uses the ±${Math.round(uncertaintyFraction * 100)}% fast heuristic until you run the optional full simulation.` : `±${Math.round(uncertaintyFraction * 100)}% screening band. This simplified estimate does not model time-specific shadows, radiation, wind, humidity, tree overlap, or building interactions.`}</p>
              </section>

              <section className="panel-section cost-section">
                <div className="section-heading"><h2>Intervention cost</h2><span>Non-spatial</span></div>
                <div className="cost-total"><span>Estimated total</span><strong>{formatCost(costEstimate)}</strong><small>{formatCost(costLow)}–{formatCost(costHigh)} indicative range</small></div>
                <div className="cost-breakdown">
                  <div><span>Small trees</span><strong>{smallTreeCount} × {formatUnitCost(treeCost.small)}</strong></div>
                  <div><span>Medium trees</span><strong>{mediumTreeCount} × {formatUnitCost(treeCost.medium)}</strong></div>
                  {reflectivePixelCount > 0 && <div><span>Reflective pavement</span><strong>{Math.round(reflectiveAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("light_road"))}</strong></div>}
                  {coolRoofPixelCount > 0 && <div><span>Cool roofs</span><strong>{Math.round(coolRoofAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("cool_roof"))}</strong></div>}
                  {greenRoofPixelCount > 0 && <div><span>Green roofs</span><strong>{Math.round(greenRoofAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("green_roof"))}</strong></div>}
                  {depavedPixelCount > 0 && <div><span>Pavement to grass</span><strong>{Math.round(depavedAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("grass_conversion"))}</strong></div>}
                  {shadeCanopyPixelCount > 0 && <div><span>Shade canopies</span><strong>{Math.round(shadeCanopyAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("shade_canopy"))}</strong></div>}
                  {solarCanopyPixelCount > 0 && <div><span>PV solar canopies</span><strong>{Math.round(solarCanopyAreaM2).toLocaleString()} m² × {formatUnitCost(unitCost("solar_canopy"))}</strong></div>}
                </div>
                <p>Order-of-magnitude installation costs with a ±35% uncertainty band; they remain intentionally separate from the map.</p>
              </section>

              <section className="panel-section policy-score-section">
                <div className="section-heading"><h2>Policy score</h2><span>Audit + SOLWEIG</span></div>
                <p className="policy-score-intro">{autoresearchMode ? "Archived score for the selected feasible policy. Use the progress controls above to compare it with other iterations." : "Evaluate this layout with the repository's policy contract: physical siting, budget, pedestrian heat relief, access, equity, co-benefits, and cost efficiency."}</p>
                <label className="policy-budget-field" htmlFor="policy-budget">
                  <span>Budget for {studyAreaLabel}</span>
                  <div><span>$</span><input id="policy-budget" type="number" min="1" max="1000000000" step="10000" value={policyScoringBudget} disabled={policyScoreRunning || autoresearchMode} onChange={(event) => setPolicyScoringBudget(Math.max(1, Math.min(1_000_000_000, Number(event.target.value) || 1)))} /></div>
                  <small>Repository standard: $500,000 · current estimated spend: {formatCost(costEstimate)}</small>
                </label>
                {budgetExceeded && <div className="simulation-error">This layout is {formatCost(costEstimate - policyScoringBudget)} over budget. Remove interventions or raise the budget before scoring.</div>}

                {policyScoreRunning ? (
                  <div className="simulation-progress-card policy-score-progress" aria-live="polite">
                    <div><Cpu size={18} /><span><strong>{policyScoreJob?.stage}</strong><small>{policyScoreJob?.elapsed_seconds ? `${Math.round(policyScoreJob.elapsed_seconds)} s elapsed` : "Starting local scorer…"}</small></span><output>{policyScoreJob?.progress ?? 0}%</output></div>
                    <progress max="100" value={policyScoreJob?.progress ?? 0} />
                    <button onClick={cancelPolicyScoring}><X size={14} /> Cancel score</button>
                  </div>
                ) : policyScore ? (
                  <>
                    <div className={`policy-verdict ${policyScore.verdict} ${policyScoreMatchesLayout ? "" : "stale"}`}>
                      {policyScore.verdict === "feasible" ? <CheckCircle2 size={19} /> : <Info size={19} />}
                      <div><strong>{policyScore.verdict === "feasible" ? "Feasible policy" : "Layout needs revision"}</strong><span>{policyScoreMatchesLayout ? autoresearchMode ? `Archived ${policyScore.run.scenarios.join(", ")} score · 10 AM, 1 PM, and 4 PM` : `${selectedScenario.shortLabel} · 10 AM, 1 PM, and 4 PM` : "Saved score · layout, scenario, or budget has changed"}</span></div>
                    </div>
                    {policyScore.objectives ? (
                      <div className="policy-objective-grid">
                        <div className="primary"><span>Pedestrian UTCI relief</span><strong>{formatPolicyMetric(policyScore.objectives.heat_relief_c, "°C")}</strong><small>Population-weighted</small></div>
                        <div><span>Expected relief</span><strong>{formatPolicyMetric(policyScore.objectives.expected_relief_c, "°C")}</strong><small>Lifecycle-adjusted</small></div>
                        <div><span>Access gain</span><strong>{formatPolicyMetric(policyScore.objectives.access_gain_pp, " pp")}</strong><small>Moved below 32°C UTCI</small></div>
                        <div><span>Equity ratio</span><strong>{formatPolicyMetric(policyScore.objectives.equity_ratio, "×")}</strong><small>Top-vulnerability relief ÷ overall</small></div>
                        <div><span>Greened area</span><strong>{formatPolicyMetric(policyScore.objectives.cobenefit_greened_pct, "%")}</strong><small>Share of walkable ground</small></div>
                        <div><span>Cost efficiency</span><strong>{formatPolicyMetric(policyScore.objectives.cost_efficiency_person_c_per_100k, "")}</strong><small>person-°C per $100k</small></div>
                        <div><span>MRT relief</span><strong>{formatPolicyMetric(policyScore.objectives.tmrt_relief_c, "°C")}</strong><small>Diagnostic</small></div>
                        <div><span>PV generation</span><strong>{formatPolicyMetric(policyScore.objectives.pv_mwh_per_yr, " MWh/yr", 1)}</strong><small>Order-of-magnitude co-benefit</small></div>
                      </div>
                    ) : (
                      <div className="policy-violations">
                        <strong>Audit messages</strong>
                        {Object.entries(policyScore.violations).flatMap(([aoi, messages]) => messages.map((message, index) => <p key={`${aoi}-${index}`}><Info size={14} /><span>{message}</span></p>))}
                        <small>No SOLWEIG simulation was run because feasibility is all-or-nothing.</small>
                      </div>
                    )}
                    {!autoresearchMode && <button className="policy-score-run" disabled={!hasInterventions || !policyScoringReady || activeSimulationRunning || budgetExceeded} onClick={startPolicyScoring}>{policyScoreMatchesLayout ? "Score this layout again" : "Score current layout"}</button>}
                  </>
                ) : (
                  <div className="policy-score-empty">
                    <Cpu size={20} />
                    <div><strong>No policy score yet</strong><span>The audit is fast; a feasible design then runs three daytime SOLWEIG timesteps and can take several minutes.</span></div>
                    {!autoresearchMode && <button disabled={!hasInterventions || !policyScoringReady || activeSimulationRunning || budgetExceeded} onClick={startPolicyScoring}>Run policy score</button>}
                  </div>
                )}
                {policyScoringChecked && !policyScoringReady && <div className="simulation-error">The local policy scorer or required {studyAreaLabel} inputs are unavailable.</div>}
                {activeSimulationRunning && !policyScoreRunning && <small className="policy-score-note">Wait for the current map simulation to finish before starting the policy score.</small>}
                {policyScoreError && <div className="simulation-error">{policyScoreError}</div>}
                <p className="policy-score-note">Scored on the {manifest?.resolution_m ?? DEFAULT_RESOLUTION_M} m {studyAreaLabel} grid for the selected climate scenario, July 27 at 10 AM, 1 PM, and 4 PM. Compare policy scores only at the same resolution, scenario, budget, and lifecycle horizon.</p>
              </section>

              <section className="panel-section assumptions-section">
                <div className="section-heading"><h2>What this estimate uses</h2></div>
                <ul>
                  <li>{selectedScenario.shortLabel} on July 27 at {selectedTime.label}.</li>
                  {simulatedMetric ? <>
                    <li>{simulationResult?.model} with local {manifest?.resolution_m ?? DEFAULT_RESOLUTION_M} m DSM, DEM, canopy, and land cover.</li>
                    <li>{simulationMatchesLayout ? "The displayed layout matches the completed simulation." : "The physical simulation is the baseline; later design edits are layered on with the fast heuristic."}</li>
                  </> : baselineMetric ? <>
                    <li>{solweigBaseline?.model} existing-conditions field with local {manifest?.resolution_m ?? DEFAULT_RESOLUTION_M} m DSM, DEM, canopy, and land cover.</li>
                    <li>{hasInterventions ? "The proposed intervention difference is a fast spatial heuristic until the current layout is simulated." : "No proposed intervention is included in this baseline."}</li>
                    {reflectivePixelCount > 0 && <li>Reflective pavement uses 6.1°C local surface and 0.8°C local UTCI screening effects, area-weighted for the study summary; MRT requires a full SOLWEIG run.</li>}
                    {coolRoofPixelCount > 0 && <li>Cool roofs have no heuristic temperature adjustment; their albedo effect is included only after a full SOLWEIG run.</li>}
                    {greenRoofPixelCount > 0 && <li>Green roofs have no heuristic temperature adjustment; full runs retain building geometry and apply albedo 0.25 plus grass emissivity and thermal-response parameters.</li>}
                    {depavedPixelCount > 0 && <li>Pavement-to-grass conversion has no heuristic adjustment; full runs change eligible non-road pavement from land-cover class 1 to class 5 with albedo 0.25 and grass thermal properties.</li>}
                    {shadeCanopyPixelCount > 0 && <li>Shade canopies have no heuristic adjustment; full runs use a 3 m overhead CDSM/TDSM layer with a 50/50 shaded-and-open footprint approximating 50% fabric transmission.</li>}
                    {solarCanopyPixelCount > 0 && <li>PV solar canopies have no heuristic adjustment; full runs use a near-opaque 3.5 m overhead CDSM/TDSM layer across every selected pixel.</li>}
                  </> : <>
                    <li>{metric === "utci" ? "Medium-tree perceived cooling anchored at 2.8°C." : metric === "surface" ? "Medium-tree surface cooling anchored at 8.3°C." : "Medium-tree MRT heuristic anchored at 10°C."}</li>
                    <li>Tree height and crown diameter apply a capped size adjustment.</li>
                  </>}
                  {metric === "utci" && <li>Perceived-temperature means include every valid AOI cell except baseline building-roof pixels.</li>}
                </ul>
                <p>{metric === "surface" && (simulationResult || solweigBaseline) ? "This SOLWEIG build does not expose surface temperature as a summary grid, so surface temperature remains explicitly screening-only." : simulatedMetric ? "Run SOLWEIG again whenever you want later edits incorporated into a new physical result." : baselineMetric ? hasInterventions ? "Run the optional full simulation to replace fast intervention adjustments with joint physical output for this layout." : "Add an intervention in Design when you are ready to compare against this physical baseline." : "Use the screening result for early comparison, or start the optional full simulation below."}</p>
              </section>

              <section className="panel-section simulation-section">
                <div className="section-heading"><h2>{baselineJobRunning ? "Initial SOLWEIG baseline" : "Full simulation"}</h2><span>{baselineJobRunning ? "Automatic" : "Optional"}</span></div>
                {simulationJob && ["queued", "running"].includes(simulationJob.state) ? (
                  <div className="simulation-progress-card">
                    <div><Cpu size={18} /><span><strong>{simulationJob.stage}</strong><small>{simulationJob.elapsed_seconds ? `${Math.round(simulationJob.elapsed_seconds)} s elapsed` : "Starting local process…"}</small></span><output>{simulationJob.progress}%</output></div>
                    <progress max="100" value={simulationJob.progress} />
                    <button onClick={cancelSimulation}><X size={14} /> Cancel run</button>
                  </div>
                ) : simulationSetupOpen ? (
                  <div className="simulation-setup-card">
                    <div className="simulation-setting"><span>Weather</span><strong>{selectedScenario.label}</strong></div>
                    <div className="simulation-setting"><span>Time</span><strong>July 27 · {selectedTime.label}</strong></div>
                    <div className="simulation-setting"><span>Snapshot</span><strong>{trees.length} tree{trees.length === 1 ? "" : "s"} · {Math.round(reflectiveAreaM2).toLocaleString()} m² reflective · {Math.round(depavedAreaM2).toLocaleString()} m² grass conversion · {Math.round(shadeCanopyAreaM2).toLocaleString()} m² shade canopy · {Math.round(solarCanopyAreaM2).toLocaleString()} m² solar canopy · {Math.round(coolRoofAreaM2).toLocaleString()} m² cool roof · {Math.round(greenRoofAreaM2).toLocaleString()} m² green roof</strong></div>
                    <p>Runs existing conditions and all current interventions together. Pavement and roof albedo are evaluated with tree and building shade. The first run may take several minutes; matching cached inputs are reused.</p>
                    {simulationError && <div className="simulation-error">{simulationError}</div>}
                    <div className="simulation-actions"><button className="button secondary" onClick={() => setSimulationSetupOpen(false)}>Not now</button><button className="button primary" disabled={!simulationReady || !hasInterventions} onClick={startFullSimulation}><Play size={15} /> Start SOLWEIG</button></div>
                  </div>
                ) : (
                  <div className="simulation-summary-card">
                    {simulationResult ? <><CheckCircle2 size={20} /><div><strong>Latest run saved</strong><span>{SCENARIOS[simulationResult.scenario as ScenarioKey]?.shortLabel ?? simulationResult.scenario} · {TIME_OPTIONS.find((option) => option.hour === simulationResult.hour)?.label ?? `${simulationResult.hour}:00`} · {simulationResult.tree_snapshot.length} tree{simulationResult.tree_snapshot.length === 1 ? "" : "s"} · {pixelAreaM2(simulationResult.reflective_snapshot?.count ?? 0).toLocaleString()} m² reflective · {pixelAreaM2(simulationResult.depaved_pavement_snapshot?.count ?? 0).toLocaleString()} m² grass conversion · {pixelAreaM2(simulationResult.shade_canopy_snapshot?.count ?? 0).toLocaleString()} m² shade canopy · {pixelAreaM2(simulationResult.solar_canopy_snapshot?.count ?? 0).toLocaleString()} m² solar canopy · {pixelAreaM2(simulationResult.cool_roof_snapshot?.count ?? 0).toLocaleString()} m² cool roof · {pixelAreaM2(simulationResult.green_roof_snapshot?.count ?? 0).toLocaleString()} m² green roof</span></div></> : <><Cpu size={20} /><div><strong>No full result yet</strong><span>The fast estimate remains active until you choose to run.</span></div></>}
                    <button disabled={!simulationReady || !hasInterventions} onClick={() => { setSimulationError(null); setSimulationSetupOpen(true); }}>{simulationResult ? "Run current layout" : "Set up full run"}</button>
                    {!simulationReady && <small>Start the local app with the project virtual environment and generated weather data.</small>}
                    {simulationError && <div className="simulation-error">{simulationError}</div>}
                  </div>
                )}
              </section>
            </>
          )}

          <div className="panel-footer">
            {autoresearchMode ? <><button className="button primary" disabled={!autoresearchLayoutReady} onClick={copyAutoresearchToDesign}><Save size={16} /> Copy to editable Design</button><p>{activeView === "results" ? "Missing physical results are simulated and cached automatically." : "The archived workspace stays read-only until copied."}</p></> : activeView === "results" ? !resultDataReady ? <><button className="button primary" disabled><Cpu size={16} /> {resultsUnavailable ? "Result unavailable" : "SOLWEIG running"}</button><p>{resultsUnavailable ? "Check the simulation setup, then return to Results." : "The result will appear automatically when complete."}</p></> : <><button className="button primary" disabled={!hasInterventions || !simulationReady || Boolean(simulationJob && ["queued", "running"].includes(simulationJob.state))} onClick={() => setSimulationSetupOpen(true)}><Play size={16} /> {simulationResult ? "Run SOLWEIG again" : "Run full SOLWEIG"}</button><p>{simulationResult ? "The latest completed run remains active until a new one finishes." : "Optional; the fast estimate uses this completed physical baseline."}</p></> : activeView === "map" ? <><button className="button primary" disabled={!hasInterventions || !simulationReady} onClick={() => { openResults(); setSimulationSetupOpen(true); }}><Play size={16} /> Run full simulation</button><p>Optional physical simulation of all current interventions.</p></> : <><button className="button primary" disabled={!hasInterventions} onClick={saveLayout}><Save size={16} /> Save intervention layout</button><p>{hasInterventions ? "Changes are also saved automatically in this browser." : "Add at least one intervention to save a layout."}</p></>}
          </div>
        </aside>

        {!panelOpen && <button className="reopen-panel" onClick={() => setPanelOpen(true)}><SlidersHorizontal size={18} /> Controls</button>}
      </main>

      <StudyAreaOverview
        open={overviewOpen}
        selectedArea={ACTIVE_AOI}
        onClose={() => setOverviewOpen(false)}
        onSelect={selectStudyArea}
      />

      {resetConfirmOpen && (
        <div className="reset-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setResetConfirmOpen(false); }}>
          <div className="reset-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title" aria-describedby="reset-description">
            <span className="reset-dialog-icon"><RotateCcw size={20} /></span>
            <div>
              <h2 id="reset-title">Reset to a new workspace?</h2>
              <p id="reset-description">This clears the {studyAreaLabel} workspace: interventions, saved SOLWEIG results, the latest policy score, cached browser baselines, tool history, and view settings. Other study areas are unchanged.</p>
            </div>
            <div className="reset-dialog-actions">
              <button className="button secondary" onClick={() => setResetConfirmOpen(false)}>Cancel</button>
              <button className="button reset-confirm" onClick={resetWorkspace}><RotateCcw size={15} /> Reset and reload</button>
            </div>
            <small>The reusable numerical physics cache stays on this computer, so identical conditions do not need to be recomputed.</small>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
