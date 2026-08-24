import { useEffect, useRef } from "react";
import { hasMaskPixel, type RasterMask } from "./reflectivePavement";

type Props = {
  mask: RasterMask;
  comparisonActive: boolean;
  afterClipPercent: number;
  textured: boolean;
};

export default function GreenRoofLayer({ mask, comparisonActive, afterClipPercent, textured }: Props) {
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
      const highlight = textured && ((x * 3 + y * 5) % 17 < 3);
      image.data[offset] = highlight ? 207 : 148;
      image.data[offset + 1] = highlight ? 241 : 211;
      image.data[offset + 2] = highlight ? 220 : 176;
      image.data[offset + 3] = textured ? 225 : 188;
    }
    context.putImageData(image, 0, 0);
  }, [mask, textured]);

  return (
    <canvas
      ref={canvasRef}
      className={`green-roof-layer ${textured ? "textured" : ""}`}
      width={mask.width}
      height={mask.height}
      style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      aria-label="Proposed vegetated green roofs"
    />
  );
}
