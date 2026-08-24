import { useEffect, useRef } from "react";
import { hasMaskPixel, type RasterMask } from "./reflectivePavement";

type Props = {
  mask: RasterMask;
  comparisonActive: boolean;
  afterClipPercent: number;
  textured: boolean;
};

export default function ReflectivePavementLayer({ mask, comparisonActive, afterClipPercent, textured }: Props) {
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
      const glint = textured && ((x + y) % 11 < 2 || (x - y + mask.height) % 17 < 1);
      image.data[offset] = glint ? 239 : 190;
      image.data[offset + 1] = glint ? 243 : 199;
      image.data[offset + 2] = glint ? 245 : 204;
      image.data[offset + 3] = textured ? 218 : 178;
    }
    context.putImageData(image, 0, 0);
  }, [mask, textured]);

  return (
    <canvas
      ref={canvasRef}
      className={`reflective-pavement-layer ${textured ? "textured" : ""}`}
      width={mask.width}
      height={mask.height}
      style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      aria-label="Proposed high-reflectance pavement coating"
    />
  );
}
