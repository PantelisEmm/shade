import { useEffect, useRef } from "react";
import { hasMaskPixel, type RasterMask } from "./reflectivePavement";

type TemperatureMetric = "mrt" | "utci" | "surface";

type ScreeningTree = {
  id?: string;
  x: number;
  y: number;
  size: "small" | "medium";
  heightM: number;
  crownDiameterM: number;
};

type SimulationLayer = {
  baselineUrl: string;
  interventionUrl: string;
  snapshotTrees: ScreeningTree[];
  snapshotReflectiveMask: RasterMask;
};

type Props = {
  metric: TemperatureMetric;
  trees: ScreeningTree[];
  reflectiveMask: RasterMask;
  width: number;
  height: number;
  displayMin: number;
  displayMax: number;
  afterClipPercent: number;
  comparisonActive: boolean;
  simulation?: SimulationLayer | null;
};

const CHANNEL: Record<TemperatureMetric, number> = { mrt: 0, utci: 1, surface: 2 };
const MEDIUM_EFFECT: Record<TemperatureMetric, number> = { mrt: 10, utci: 2.8, surface: 8.3 };
const SMALL_EFFECT: Record<TemperatureMetric, number> = { mrt: 6.5, utci: 1.8, surface: 5.4 };
const COLOR_STOPS = [
  [42, 82, 146],
  [64, 146, 174],
  [103, 181, 154],
  [239, 211, 116],
  [225, 119, 73],
  [147, 48, 61],
];

let encodedMetricsPromise: Promise<HTMLImageElement> | null = null;

const loadEncodedMetrics = () => {
  if (!encodedMetricsPromise) {
    encodedMetricsPromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Screening metric raster is unavailable"));
      image.src = "/data/chinatown/screening_metrics.png";
    });
  }
  return encodedMetricsPromise;
};

const buildPalette = () => {
  const palette = new Uint8ClampedArray(256 * 3);
  for (let value = 0; value < 256; value += 1) {
    const scaled = (value / 255) * (COLOR_STOPS.length - 1);
    const left = Math.min(COLOR_STOPS.length - 2, Math.floor(scaled));
    const blend = scaled - left;
    for (let channel = 0; channel < 3; channel += 1) {
      palette[value * 3 + channel] = Math.round(COLOR_STOPS[left][channel] + (COLOR_STOPS[left + 1][channel] - COLOR_STOPS[left][channel]) * blend);
    }
  }
  return palette;
};

const PALETTE = buildPalette();

const exactImagePromises = new Map<string, Promise<HTMLImageElement>>();

const loadExactImage = (source: string) => {
  if (!exactImagePromises.has(source)) {
    exactImagePromises.set(source, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Simulation raster is unavailable: ${source}`));
      image.src = source;
    }));
  }
  return exactImagePromises.get(source)!;
};

const buildReduction = (trees: ScreeningTree[], metric: TemperatureMetric, width: number, height: number) => {
  const reduction = new Float32Array(width * height);
  for (const tree of trees) {
    const presetDiameter = tree.size === "small" ? 3 : 5;
    const sizeScale = Math.min(1.6, Math.max(0.55, Math.sqrt(tree.crownDiameterM / presetDiameter) * Math.sqrt(tree.heightM / 5)));
    const peakReduction = (tree.size === "small" ? SMALL_EFFECT[metric] : MEDIUM_EFFECT[metric]) * sizeScale;
    const sigma = Math.max(12, tree.crownDiameterM * 3.4);
    const radius = Math.ceil(sigma * 3.2);
    const minX = Math.max(0, Math.floor(tree.x - radius));
    const maxX = Math.min(width - 1, Math.ceil(tree.x + radius));
    const minY = Math.max(0, Math.floor(tree.y - radius));
    const maxY = Math.min(height - 1, Math.ceil(tree.y + radius));
    const denominator = 2 * sigma * sigma;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const localReduction = peakReduction * Math.exp(-((x - tree.x) ** 2 + (y - tree.y) ** 2) / denominator);
        const pixel = y * width + x;
        reduction[pixel] = Math.max(reduction[pixel], localReduction);
      }
    }
  }
  return reduction;
};

const buildReflectiveReduction = (mask: RasterMask, metric: TemperatureMetric, width: number, height: number) => {
  const reduction = new Float32Array(width * height);
  const effect = metric === "surface" ? 6.1 : metric === "utci" ? 0.8 : 0;
  if (!effect) return reduction;
  const copyWidth = Math.min(width, mask.width);
  const copyHeight = Math.min(height, mask.height);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      if (hasMaskPixel(mask, y * mask.width + x)) reduction[y * width + x] = effect;
    }
  }
  return reduction;
};

export default function ScreeningMetricLayer({
  metric,
  trees,
  reflectiveMask,
  width,
  height,
  displayMin,
  displayMax,
  afterClipPercent,
  comparisonActive,
  simulation,
}: Props) {
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;

    const usesSimulation = Boolean(simulation && metric !== "surface");
    const images = usesSimulation && simulation
      ? Promise.all([loadExactImage(simulation.baselineUrl), loadExactImage(simulation.interventionUrl)])
      : loadEncodedMetrics().then((image) => [image, image]);

    images.then(([baselineImage, interventionImage]) => {
      if (cancelled || !beforeRef.current || !afterRef.current) return;

      const readImage = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const encodedBaseline = readImage(baselineImage);
      const encodedIntervention = readImage(interventionImage);
      if (!encodedBaseline || !encodedIntervention) return;

      const pixelCount = width * height;
      const baseline = new Float32Array(pixelCount);
      const channel = CHANNEL[metric];

      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        baseline[pixel] = displayMin + (encodedBaseline[pixel * 4 + channel] / 255) * (displayMax - displayMin);
      }

      const currentReduction = buildReduction(trees, metric, width, height);
      const snapshotReduction = usesSimulation && simulation ? buildReduction(simulation.snapshotTrees, metric, width, height) : null;
      const currentReflectiveReduction = buildReflectiveReduction(reflectiveMask, metric, width, height);
      const snapshotReflectiveReduction = usesSimulation && simulation ? buildReflectiveReduction(simulation.snapshotReflectiveMask, metric, width, height) : null;

      const beforeContext = beforeRef.current.getContext("2d");
      const afterContext = afterRef.current.getContext("2d");
      if (!beforeContext || !afterContext) return;
      const beforeImage = beforeContext.createImageData(width, height);
      const afterImage = afterContext.createImageData(width, height);

      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        const valid = encodedBaseline[offset + 3] > 0 && encodedIntervention[offset + 3] > 0;
        const beforePaletteOffset = encodedBaseline[offset + channel] * 3;
        const simulatedValue = displayMin + (encodedIntervention[offset + channel] / 255) * (displayMax - displayMin);
        const afterValue = usesSimulation
          ? simulatedValue + (snapshotReduction?.[pixel] ?? 0) + (snapshotReflectiveReduction?.[pixel] ?? 0) - currentReduction[pixel] - currentReflectiveReduction[pixel]
          : baseline[pixel] - currentReduction[pixel] - currentReflectiveReduction[pixel];
        const afterNormalized = Math.min(1, Math.max(0, (afterValue - displayMin) / Math.max(displayMax - displayMin, 1e-6)));
        const afterPaletteOffset = Math.round(afterNormalized * 255) * 3;
        beforeImage.data[offset] = PALETTE[beforePaletteOffset];
        beforeImage.data[offset + 1] = PALETTE[beforePaletteOffset + 1];
        beforeImage.data[offset + 2] = PALETTE[beforePaletteOffset + 2];
        beforeImage.data[offset + 3] = valid ? 242 : 0;
        afterImage.data[offset] = PALETTE[afterPaletteOffset];
        afterImage.data[offset + 1] = PALETTE[afterPaletteOffset + 1];
        afterImage.data[offset + 2] = PALETTE[afterPaletteOffset + 2];
        afterImage.data[offset + 3] = valid ? 242 : 0;
      }

      beforeContext.putImageData(beforeImage, 0, 0);
      afterContext.putImageData(afterImage, 0, 0);
    }).catch(() => {
      // The map remains usable if the generated screening raster is absent.
    });

    return () => { cancelled = true; };
  }, [metric, trees, reflectiveMask, width, height, displayMin, displayMax, simulation]);

  return (
    <div className="screening-metric-layer" aria-label={`${metric} ${simulation && metric !== "surface" ? "SOLWEIG-calibrated" : "screening"} comparison raster`}>
      <canvas
        ref={beforeRef}
        width={width}
        height={height}
        className="screening-raster before"
        style={{ clipPath: comparisonActive ? `inset(0 ${100 - afterClipPercent}% 0 0)` : "inset(0 100% 0 0)" }}
      />
      <canvas
        ref={afterRef}
        width={width}
        height={height}
        className="screening-raster after"
        style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      />
    </div>
  );
}
