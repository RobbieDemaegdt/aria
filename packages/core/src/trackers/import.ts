/**
 * Importing a tracker config: the picked file's text is checked as a whole, then
 * copied into the trackers folder as `<id>.json`, after asking when that file is there already. Nothing else writes there.
 */
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadTrackerConfig, parseTrackerConfig, trackersDir } from "./config/load.ts";
import type { TrackerConfig } from "./config/schema.ts";

export type ImportOutcome =
  | { status: "invalid"; errors: string[] }
  /** The folder has a file of that name and the import wasn't told to replace it. */
  | { status: "exists"; config: TrackerConfig; hash: string; file: string; existingHash?: string }
  | { status: "imported"; config: TrackerConfig; hash: string; file: string; replaced: boolean }
  | { status: "failed"; error: string };

/** What the engine answers when the folder has a file of that name and the import wasn't told to replace it: the caller asks first. */
export interface ImportExists {
  status: "exists";
  id: string;
  label: string;
  file: string;
  /** The picked file's hash, and the one in the folder (absent when that file doesn't load). */
  hash: string;
  existingHash?: string;
  /** The file in the folder is the one the active tracker was loaded from. */
  active: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Checks `text` and, when it is a valid config, writes it to `<dataDir>/trackers/<id>.json` (through a temporary file in the same folder). */
export function importTrackerConfigText(dataDir: string, text: string, options: { replace?: boolean } = {}): ImportOutcome {
  const parsed = parseTrackerConfig(text);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  const dir = trackersDir(dataDir);
  const file = `${parsed.config.id}.json`;
  const target = path.join(dir, file);
  let present = false;
  try {
    const stat = lstatSync(target);
    if (stat.isDirectory()) return { status: "failed", error: `${file} in the trackers folder is a folder, not a file.` };
    present = true;
  } catch {
    // Not there: a new file.
  }
  if (present && !options.replace) {
    const current = loadTrackerConfig(dataDir, parsed.config.id);
    return { status: "exists", config: parsed.config, hash: parsed.hash, file, ...(current.ok ? { existingHash: current.hash } : {}) };
  }
  const temporary = path.join(dir, `.${parsed.config.id}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    return { status: "failed", error: `ARIA couldn't write ${file} to its trackers folder: ${errorText(error)}` };
  }
  return { status: "imported", config: parsed.config, hash: parsed.hash, file, replaced: present };
}
