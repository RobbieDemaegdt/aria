/**
 * The images the app shows of itself (PLAN.md §4.1, §4.7): the window icon, the tray icon, and the red dot that says something needs
 * you. The artwork is image files (`build/icon.ico`, `images/tray-16.png`, `images/tray-32.png`; image-files.ts says where
 * the build puts them); only the red dot is drawn in code (bitmap.ts), over the tray image or alone as the taskbar overlay.
 */
import fs from "node:fs";
import path from "node:path";
import { nativeImage, type NativeImage } from "electron";
import { blankBitmap, paintNeedsYouDot, redDotBitmap } from "./bitmap.ts";

/** Where the image files are: the window's `.ico`, and the tray's 16 px and 32 px (2×) PNGs. */
export interface ImageFiles {
  appIcon: string;
  tray16: string;
  tray32: string;
}

export interface Images {
  /** The window's icon, or undefined when the `.ico` can't be read (the window then has the program's own icon, which is the same art). */
  appIcon(): NativeImage | undefined;
  /** The tray icon at 16 px (1×) and 32 px (2×), with the red dot when `needsYou`. */
  trayIcon(needsYou: boolean): NativeImage;
  /** The red dot over the taskbar button. */
  overlayDot(): NativeImage;
  /** One line for the log: which files the window icon and the tray icon came from, and their sizes (file names only). */
  describe(): string;
}

/** The pixels of a PNG file as a size × size BGRA bitmap. The file is read with `fs`, which also reads from inside the app's asar archive. */
function pngBitmap(file: string, size: number): Buffer {
  let image = nativeImage.createFromBuffer(fs.readFileSync(file));
  if (image.isEmpty()) throw new Error(`The image ${file} can't be read.`);
  const have = image.getSize();
  if (have.width !== size || have.height !== size) image = image.resize({ width: size, height: size, quality: "best" });
  const bitmap = image.toBitmap();
  return bitmap.length === size * size * 4 ? bitmap : blankBitmap(size);
}

export function createImages(files: ImageFiles): Images {
  const trayBitmaps = new Map<boolean, NativeImage>();
  const notes = new Map<string, string>();
  let base: { one: Buffer; two: Buffer } | undefined;
  return {
    appIcon() {
      const image = nativeImage.createFromPath(files.appIcon);
      const name = path.basename(files.appIcon);
      notes.set("window icon", image.isEmpty() ? `${name} (missing: the window has the program's own icon)` : `${name} (${image.getSize().width} px)`);
      return image.isEmpty() ? undefined : image;
    },
    trayIcon(needsYou) {
      const cached = trayBitmaps.get(needsYou);
      if (cached) return cached;
      base ??= { one: pngBitmap(files.tray16, 16), two: pngBitmap(files.tray32, 32) };
      notes.set("tray icon", `${path.basename(files.tray16)} (16 px) and ${path.basename(files.tray32)} (32 px)`);
      const one = Buffer.from(base.one);
      const two = Buffer.from(base.two);
      if (needsYou) {
        paintNeedsYouDot(one, 16);
        paintNeedsYouDot(two, 32);
      }
      const image = nativeImage.createFromBitmap(one, { width: 16, height: 16, scaleFactor: 1 });
      image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: two });
      trayBitmaps.set(needsYou, image);
      return image;
    },
    overlayDot() {
      return nativeImage.createFromBitmap(redDotBitmap(32), { width: 32, height: 32, scaleFactor: 2 });
    },
    describe() {
      return `Images: ${[...notes].map(([what, from]) => `${what} from ${from}`).join("; ") || "none loaded yet"}`;
    },
  };
}
