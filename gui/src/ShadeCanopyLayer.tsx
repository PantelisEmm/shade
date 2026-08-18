import { useEffect, useRef } from "react";
import type { RasterMask } from "./reflectivePavement";

type Props = {
  mask: RasterMask;
  icons: { x: number; y: number; angle: number }[];
  comparisonActive: boolean;
  afterClipPercent: number;
  detailed: boolean;
  variant?: "shade" | "solar";
};

export default function ShadeCanopyLayer({ mask, icons, comparisonActive, afterClipPercent, detailed, variant = "shade" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, mask.width, mask.height);
    context.lineWidth = detailed ? 1 : 0.85;
    for (const icon of icons) {
      if (icon.x < 0 || icon.x >= mask.width || icon.y < 0 || icon.y >= mask.height) continue;
      context.save();
      context.translate(icon.x, icon.y);
      context.beginPath();
      if (variant === "solar") {
        context.rect(-3.4, -2.5, 6.8, 5);
      } else {
        context.moveTo(0, -2.7);
        context.lineTo(3.2, 0);
        context.lineTo(0, 2.7);
        context.lineTo(-3.2, 0);
      }
      context.closePath();
      context.fillStyle = variant === "solar"
        ? detailed ? "rgba(35, 69, 91, .98)" : "rgba(33, 62, 82, .96)"
        : detailed ? "rgba(255, 224, 154, .96)" : "rgba(245, 193, 111, .88)";
      context.fill();
      context.strokeStyle = variant === "solar"
        ? "rgba(170, 210, 225, .96)"
        : detailed ? "rgba(133, 87, 42, .94)" : "rgba(129, 83, 39, .82)";
      context.stroke();
      if (variant === "solar") {
        context.beginPath();
        context.moveTo(0, -2.3);
        context.lineTo(0, 2.3);
        context.moveTo(-3.1, 0);
        context.lineTo(3.1, 0);
        context.strokeStyle = "rgba(124, 173, 193, .8)";
        context.stroke();
      }
      context.beginPath();
      context.moveTo(-2.6, 0.4);
      context.lineTo(-2.6, 3.7);
      context.moveTo(2.6, 0.4);
      context.lineTo(2.6, 3.7);
      context.strokeStyle = variant === "solar" ? "rgba(47, 58, 63, .96)" : "rgba(91, 68, 47, .9)";
      context.stroke();
      context.restore();
    }
  }, [mask, icons, detailed, variant]);

  return (
    <canvas
      ref={canvasRef}
      className={`shade-canopy-layer ${variant === "solar" ? "solar" : ""} ${detailed ? "detailed" : ""}`}
      width={mask.width}
      height={mask.height}
      style={{ clipPath: comparisonActive ? `inset(0 0 0 ${afterClipPercent}%)` : "none" }}
      aria-label={variant === "solar" ? "Proposed PV solar canopies" : "Proposed fabric shade canopies"}
    />
  );
}
