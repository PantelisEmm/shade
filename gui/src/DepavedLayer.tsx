import { useEffect, useRef } from "react";
import { hasMaskPixel, type RasterMask } from "./reflectivePavement";

type Props = {
  mask: RasterMask;
  comparisonActive: boolean;
  afterClipPercent: number;
  textured: boolean;
};

export default function DepavedLayer({ mask, comparisonActive, afterClipPercent, textured }: Props) {
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
      const grassLine = textured && ((x + y * 2) % 13 < 2 || (x * 3 - y + mask.height) % 19 < 1);
      image.data[offset] = grassLine ? 69 : 119;
      image.data[offset + 1] = grassLine ? 151 : 190;
      image.data[offset + 2] = grassLine ? 67 : 91;
      image.data[offset + 3] = textured ? 230 : 190;
    }
    context.putImageData(image, 0, 0);
  }, [mask, textured]);

  return (
    <canvas
      ref={canvasRef}
      className={`depaved-layer ${textured ? "textured" : ""}`}
      width={mask.width}
      height={mask.height}
      style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      aria-label="Proposed pavement converted to low grass"
    />
  );
}
