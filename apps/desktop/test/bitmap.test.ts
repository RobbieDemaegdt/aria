import { describe, expect, it } from "vitest";
import { blankBitmap, coverage, paintDisc, paintNeedsYouDot, RED, redDotBitmap } from "../src/main/bitmap";

/** One pixel of a BGRA bitmap as [r, g, b, a]. */
const pixel = (bitmap: Buffer, size: number, x: number, y: number): number[] => {
  const i = (y * size + x) * 4;
  return [bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!, bitmap[i + 3]!];
};

describe("the red dot, the one thing the app still draws", () => {
  it("covers a pixel by how much of it the disc takes: all inside, none outside, part at the edge", () => {
    expect(coverage(0, 6)).toBe(1);
    expect(coverage(5.5, 6)).toBe(1);
    expect(coverage(6, 6)).toBe(0.5);
    expect(coverage(6.5, 6)).toBe(0);
    expect(coverage(7, 6)).toBe(0);
  });

  it("lays a disc over a transparent bitmap: the colour in the middle, nothing in the corners", () => {
    const bitmap = blankBitmap(16);
    paintDisc(bitmap, 16, 8, 8, 5, RED);
    expect(pixel(bitmap, 16, 8, 8)).toEqual([...RED, 255]);
    expect(pixel(bitmap, 16, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(bitmap, 16, 15, 15)).toEqual([0, 0, 0, 0]);
  });

  it("composites over what is there, in premultiplied BGRA (an opaque pixel stays opaque, a half-covered one mixes)", () => {
    const size = 8;
    const bitmap = Buffer.alloc(size * size * 4, 255); // opaque white
    paintDisc(bitmap, size, 4, 4, 2, [0, 0, 0]);
    expect(pixel(bitmap, size, 4, 4)).toEqual([0, 0, 0, 255]);
    expect(pixel(bitmap, size, 0, 0)).toEqual([255, 255, 255, 255]);
    const edge = pixel(bitmap, size, 5, 5); // its centre is 2.12 from the disc's: the radius-2 disc covers it by about a third
    expect(edge[3]).toBe(255);
    expect(edge[0]).toBeGreaterThan(140);
    expect(edge[0]).toBeLessThan(175);
  });

  it("puts the tray's dot in the bottom-right corner and leaves the rest of the image as it was", () => {
    for (const size of [16, 32]) {
      const bitmap = Buffer.alloc(size * size * 4, 90);
      const before = Buffer.from(bitmap);
      paintNeedsYouDot(bitmap, size);
      const c = Math.round((25 / 32) * size);
      expect(pixel(bitmap, size, c, c)).toEqual([...RED, 255]);
      expect(pixel(bitmap, size, 1, 1)).toEqual(pixel(before, size, 1, 1));
      expect(pixel(bitmap, size, size - 1, 1)).toEqual(pixel(before, size, size - 1, 1));
      expect(pixel(bitmap, size, 1, size - 1)).toEqual(pixel(before, size, 1, size - 1));
    }
  });

  it("makes the taskbar's overlay: a plain red disc in a transparent square", () => {
    const bitmap = redDotBitmap(32);
    expect(bitmap.length).toBe(32 * 32 * 4);
    expect(pixel(bitmap, 32, 16, 16)).toEqual([...RED, 255]);
    expect(pixel(bitmap, 32, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(bitmap, 32, 16, 5)).toEqual([...RED, 255]); // 11 px from the centre: inside
    expect(pixel(bitmap, 32, 16, 1)[3]).toBe(0); // 15 px: outside
  });
});
