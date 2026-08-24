import { useEffect, useRef } from "react";

type LayerTree = {
  id: string;
  x: number;
  y: number;
  heightM: number;
  crownDiameterM: number;
};

type Props = {
  showLand: boolean;
  showCanopy: boolean;
  trees: LayerTree[];
  width: number;
  height: number;
  dataRoot: string;
  resolutionM: number;
  comparisonActive: boolean;
  afterClipPercent: number;
};

const imagePromises = new Map<string, Promise<HTMLImageElement>>();

const loadImage = (source: string) => {
  if (!imagePromises.has(source)) {
    imagePromises.set(source, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load ${source}`));
      image.src = source;
    }));
  }
  return imagePromises.get(source)!;
};

const crownPath = (context: CanvasRenderingContext2D, tree: LayerTree, resolutionM: number) => {
  const radius = Math.max(1.25, tree.crownDiameterM / (2 * resolutionM));
  const seed = [...tree.id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const points = 14;
  context.beginPath();
  for (let point = 0; point < points; point += 1) {
    const angle = (point / points) * Math.PI * 2;
    const variation = .86 + .11 * Math.sin(point * 2.7 + seed * .13) + .05 * Math.cos(point * 4.1 + seed * .07);
    const x = tree.x + Math.cos(angle) * radius * variation;
    const y = tree.y + Math.sin(angle) * radius * variation;
    if (point === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
};

const replaceCrownPixels = (context: CanvasRenderingContext2D, tree: LayerTree, color: string, resolutionM: number) => {
  const radius = Math.max(1.5, tree.crownDiameterM / (2 * resolutionM) + 1);
  context.save();
  crownPath(context, tree, resolutionM);
  context.clip();
  context.clearRect(tree.x - radius, tree.y - radius, radius * 2, radius * 2);
  context.fillStyle = color;
  context.fillRect(tree.x - radius, tree.y - radius, radius * 2, radius * 2);
  context.restore();
};

const canopyColor = (heightM: number) => {
  const amount = Math.min(1, Math.max(0, heightM / 25));
  const low = [93, 154, 92];
  const high = [22, 78, 49];
  const color = low.map((channel, index) => Math.round(channel + (high[index] - channel) * amount));
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${215 / 255})`;
};

export default function InterventionMapLayers({
  showLand,
  showCanopy,
  trees,
  width,
  height,
  dataRoot,
  resolutionM,
  comparisonActive,
  afterClipPercent,
}: Props) {
  const landAfterRef = useRef<HTMLCanvasElement>(null);
  const canopyAfterRef = useRef<HTMLCanvasElement>(null);
  const beforeClip = comparisonActive ? `inset(0 ${100 - afterClipPercent}% 0 0)` : "inset(0 100% 0 0)";
  const afterClip = comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none";

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadImage(`${dataRoot}/landcover.png`),
      loadImage(`${dataRoot}/canopy.png`),
    ]).then(([landImage, canopyImage]) => {
      if (cancelled) return;
      const landContext = landAfterRef.current?.getContext("2d");
      const canopyContext = canopyAfterRef.current?.getContext("2d");
      if (landContext) {
        landContext.clearRect(0, 0, width, height);
        landContext.drawImage(landImage, 0, 0, width, height);
        for (const tree of trees) replaceCrownPixels(landContext, tree, `rgba(116, 157, 91, ${120 / 255})`, resolutionM);
      }
      if (canopyContext) {
        canopyContext.clearRect(0, 0, width, height);
        canopyContext.drawImage(canopyImage, 0, 0, width, height);
        for (const tree of trees) replaceCrownPixels(canopyContext, tree, canopyColor(tree.heightM), resolutionM);
      }
    }).catch(() => {
      // Baseline map layers remain available if an intervention canvas fails.
    });
    return () => { cancelled = true; };
  }, [showLand, showCanopy, trees, width, height, dataRoot, resolutionM]);

  return (
    <div className="intervention-map-layers">
      {showLand && <>
        <img className="intervention-raster land before" src={`${dataRoot}/landcover.png`} alt="Baseline land cover" draggable="false" style={{ clipPath: beforeClip }} />
        <canvas ref={landAfterRef} className="intervention-raster land after" width={width} height={height} style={{ clipPath: afterClip }} aria-label="Land cover with proposed trees" />
      </>}
      {showCanopy && <>
        <img className="intervention-raster canopy before" src={`${dataRoot}/canopy.png`} alt="Baseline tree canopy" draggable="false" style={{ clipPath: beforeClip }} />
        <canvas ref={canopyAfterRef} className="intervention-raster canopy after" width={width} height={height} style={{ clipPath: afterClip }} aria-label="Canopy with proposed trees" />
      </>}
    </div>
  );
}
