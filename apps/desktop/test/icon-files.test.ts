import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "..");
const read = (rel: string): Buffer => readFileSync(path.join(desktop, rel));
const text = (rel: string): string => read(rel).toString("utf8").replace(/\r\n/g, "\n");

/** Width, height, bit depth and colour type from a PNG's IHDR (colour type 6 is RGBA). */
function pngHeader(file: Buffer): { width: number; height: number; depth: number; type: number } {
  expect(file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  expect(file.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20), depth: file[24]!, type: file[25]! };
}

describe("the app's image files, and how the build ships them", () => {
  it("has the owner's 1024 px art as build/icon.png", () => {
    expect(pngHeader(read("build/icon.png"))).toMatchObject({ width: 1024, height: 1024 });
  });

  it("has an .ico of nine frames, 16 to 256 px, each a 32-bpp image that lies inside the file", () => {
    const ico = read("build/icon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const size = ico[entry] || 256;
      sizes.push(size);
      expect(ico[entry + 1] || 256).toBe(size);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      // a DIB frame: its header says the same width, twice the height (image and mask), 32 bits
      expect([ico.readUInt32LE(offset), ico.readInt32LE(offset + 4), ico.readInt32LE(offset + 8), ico.readUInt16LE(offset + 14)]).toEqual([40, size, size * 2, 32]);
    }
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
  });

  it("has the tray's two images, 16 and 32 px, RGBA", () => {
    expect(pngHeader(read("images/tray-16.png"))).toEqual({ width: 16, height: 16, depth: 8, type: 6 });
    expect(pngHeader(read("images/tray-32.png"))).toEqual({ width: 32, height: 32, depth: 8, type: 6 });
  });

  it("builds the installer's icon from that .ico, and unpacks it for the window (the tray's PNGs are read inside the archive)", () => {
    const yml = text("electron-builder.yml");
    expect(yml).toMatch(/^ {2}icon: build\/icon\.ico$/m);
    expect(yml).toMatch(/^files:\n {2}- "out\/\*\*\/\*"/m);
    expect(yml).toMatch(/^asarUnpack:\n(?: {2}.*\n)*? {2}- "out\/main\/chunks\/\*\.ico"$/m);
    expect(yml).not.toMatch(/chunks\/\*\.png/);
  });

  it("imports the three files as electron-vite assets, from folders the build treats as ordinary (not its public folder, `resources`)", () => {
    const source = text("src/main/image-files.ts");
    expect(source).toContain('"../../build/icon.ico?asset&asarUnpack"');
    expect(source).toContain('"../../images/tray-16.png?asset"');
    expect(source).toContain('"../../images/tray-32.png?asset"');
    expect(source).not.toMatch(/resources\//);
    expect(existsSync(path.join(desktop, "resources"))).toBe(false);
  });

  it("no longer draws the icon: no generator script, and no `icon` step in pack or dist", () => {
    const pkg = JSON.parse(text("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.icon).toBeUndefined();
    expect(pkg.scripts.pack).toBe("electron-vite build && electron-builder --dir --publish never");
    expect(pkg.scripts.dist).toBe("electron-vite build && electron-builder --win nsis --publish never");
    expect(existsSync(path.join(desktop, "scripts", "generate-icon.ts"))).toBe(false);
  });
});
