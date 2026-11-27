/**
 * Where the app's image files are when it runs. electron-vite turns each `?asset` import into a path that is right in development and in a
 * packaged build: the file is copied next to the main bundle (`out/main/chunks/`, under a hashed name), which `electron-builder.yml`'s
 * `files: out/**` takes into `app.asar`. (Not in a folder called `resources`: electron-vite treats that one as its public folder and
 * leaves the files where they are, which a packaged build wouldn't have.)
 *
 * - The tray's two PNGs stay in the archive: images.ts reads them with `fs`, which reads inside an asar archive.
 * - The window's `.ico` is `?asset&asarUnpack`: Windows reads an icon from a real file, so its path points into `app.asar.unpacked`, where
 *   `electron-builder.yml`'s `asarUnpack` puts it. If it isn't there the window has the program's own icon, which is the same art.
 */
import appIcon from "../../build/icon.ico?asset&asarUnpack";
import tray16 from "../../images/tray-16.png?asset";
import tray32 from "../../images/tray-32.png?asset";
import type { ImageFiles } from "./images.ts";

export const IMAGE_FILES: ImageFiles = { appIcon, tray16, tray32 };
