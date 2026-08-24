export type RasterMask = {
  width: number;
  height: number;
  bits: Uint8Array;
  count: number;
};

export type StreetSegment = {
  id: number;
  name: string;
  paths: [number, number][][];
};

export const emptyRasterMask = (width = 1001, height = 1001): RasterMask => ({
  width,
  height,
  bits: new Uint8Array(Math.ceil((width * height) / 8)),
  count: 0,
});

export const hasMaskPixel = (mask: RasterMask, pixel: number) => (
  (mask.bits[pixel >> 3] & (1 << (pixel & 7))) !== 0
);

export const writeMaskPixel = (bits: Uint8Array, pixel: number, value: boolean) => {
  const byte = pixel >> 3;
  const flag = 1 << (pixel & 7);
  if (value) bits[byte] |= flag;
  else bits[byte] &= ~flag;
};

const BYTE_POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let remaining = value;
  let count = 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
});

export const countMaskPixels = (bits: Uint8Array, width: number, height: number) => {
  const pixelCount = width * height;
  const fullBytes = Math.floor(pixelCount / 8);
  let count = 0;
  for (let byte = 0; byte < fullBytes; byte += 1) count += BYTE_POPCOUNT[bits[byte]];
  const remainingBits = pixelCount & 7;
  if (remainingBits) count += BYTE_POPCOUNT[bits[fullBytes] & ((1 << remainingBits) - 1)];
  return count;
};

export const encodeMaskBits = (bits: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bits.length; offset += chunkSize) {
    binary += String.fromCharCode(...bits.subarray(offset, Math.min(bits.length, offset + chunkSize)));
  }
  return btoa(binary);
};

export const decodeMaskBits = (encoded: string) => {
  const binary = atob(encoded);
  const bits = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bits[index] = binary.charCodeAt(index);
  return bits;
};

export const loadRasterMask = (storageKey: string, width = 1001, height = 1001): RasterMask => {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return emptyRasterMask(width, height);
    const parsed = JSON.parse(stored) as { width: number; height: number; count: number; data: string };
    if (parsed.width !== width || parsed.height !== height) return emptyRasterMask(width, height);
    const bits = decodeMaskBits(parsed.data);
    if (bits.length !== Math.ceil((width * height) / 8)) return emptyRasterMask(width, height);
    return { width, height, bits, count: countMaskPixels(bits, width, height) };
  } catch {
    return emptyRasterMask(width, height);
  }
};

export const storeRasterMask = (storageKey: string, mask: RasterMask) => {
  const count = countMaskPixels(mask.bits, mask.width, mask.height);
  if (!count) {
    localStorage.removeItem(storageKey);
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify({
    width: mask.width,
    height: mask.height,
    count,
    data: encodeMaskBits(mask.bits),
  }));
};

export const nearestPointOnSegmentSquared = (
  point: { x: number; y: number },
  start: [number, number],
  end: [number, number],
) => {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared > 0
    ? Math.min(1, Math.max(0, ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / lengthSquared))
    : 0;
  const x = start[0] + dx * fraction;
  const y = start[1] + dy * fraction;
  return (point.x - x) ** 2 + (point.y - y) ** 2;
};
