import { useEffect, useRef } from "react";
import { hasMaskPixel, type RasterMask } from "./reflectivePavement";

type Props = {
  mask: RasterMask;
  comparisonActive: boolean;
  afterClipPercent: number;
  textured: boolean;
};

export default function CoolRoofLayer({ mask, comparisonActive, afterClipPercent, textured }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const image = context.createImageData(mask.width, mask.height);
    for (let pixel = 0; pixel < mask.width * mask.height; pixel += 1) {
      if (!hasMaskPixel(mask, pixel)) continue;
      const offset = pixel * 4;
      const x = pixel % mask.width;
      const y = Math.floor(pixel / mask.width);
      const highlight = textured && ((x + y) % 13 < 2);
      image.data[offset] = highlight ? 214 : 154;
      image.data[offset + 1] = highlight ? 239 : 207;
      image.data[offset + 2] = highlight ? 250 : 229;
      image.data[offset + 3] = textured ? 225 : 188;
    }
    context.putImageData(image, 0, 0);
  }, [mask, textured]);

  return (
    <canvas
      ref={canvasRef}
      className={`cool-roof-layer ${textured ? "textured" : ""}`}
      width={mask.width}
      height={mask.height}
      style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      aria-label="Proposed light-coloured cool roofs"
    />
  );
}
