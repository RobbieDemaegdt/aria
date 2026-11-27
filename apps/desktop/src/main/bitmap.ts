/**
 * The little drawing the app still does in code: the red dot that says something needs you. Everything else it shows of itself is
 * an image file (images.ts). The bitmaps are BGRA with premultiplied alpha, which is what Electron's `NativeImage.toBitmap()` gives
 * and `nativeImage.createFromBitmap()` takes. Pure (no Electron), so a unit test holds it.
 */

/** A colour, red then green then blue (0 to 255). */
export type Rgb = readonly [number, number, number];

/** The red of the "needs you" dot. */
export const RED: Rgb = [248, 81, 73];
/** The dark rim round the dot on the tray image, so it shows on a light taskbar as well as on a dark one. */
export const RIM: Rgb = [13, 17, 23];

/** How much of a pixel a disc covers: 1 inside, 0 outside, antialiased over one pixel at its edge (d is the pixel's distance from the centre). */
export const coverage = (d: number, radius: number): number => Math.max(0, Math.min(1, radius - d + 0.5));

/** Lays a disc of one colour over a size × size bitmap ("over" compositing, in place). Centre and radius are in pixels of the bitmap. */
export function paintDisc(bitmap: Buffer, size: number, cx: number, cy: number, radius: number, [r, g, b]: Rgb): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), radius);
      if (a === 0) continue;
      const i = (y * size + x) * 4;
      const keep = 1 - a;
      bitmap[i] = Math.round(b * a + bitmap[i]! * keep);
      bitmap[i + 1] = Math.round(g * a + bitmap[i + 1]! * keep);
      bitmap[i + 2] = Math.round(r * a + bitmap[i + 2]! * keep);
      bitmap[i + 3] = Math.round(255 * a + bitmap[i + 3]! * keep);
    }
  }
}

/** A size × size bitmap that is transparent. */
export const blankBitmap = (size: number): Buffer => Buffer.alloc(size * size * 4);

/** The "needs you" dot over the bottom-right corner of a tray bitmap: red, with a dark rim (at 32 px: centre 25, 25; radius 6, rim to 7.5). */
export function paintNeedsYouDot(bitmap: Buffer, size: number): void {
  const k = size / 32;
  paintDisc(bitmap, size, 25 * k, 25 * k, 7.5 * k, RIM);
  paintDisc(bitmap, size, 25 * k, 25 * k, 6 * k, RED);
}

/** The red dot Windows shows over the taskbar button when something needs you (a plain red disc filling the bitmap, to 13 of 16). */
export function redDotBitmap(size: number): Buffer {
  const bitmap = blankBitmap(size);
  paintDisc(bitmap, size, size / 2, size / 2, (13 / 16) * (size / 2), RED);
  return bitmap;
}
