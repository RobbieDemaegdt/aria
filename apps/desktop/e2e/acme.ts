/**
 * The fictional Acme Tracker for the specs that need a task tracker: its config
 * (packages/core/test/fixtures/trackers/acme.json, whose tools the scripted runtime's server "Acme" has) is put in the data
 * folder's `trackers/`, and `ARIA_FAKE_TRACKER=acme` makes it the tracker (with the scripted runtime only, in place of a
 * tracker setting). The tracker's label is "Acme Tracker"; its task pages are https://acme.example/browse/<key>.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ACME_FIXTURE = path.resolve(import.meta.dirname, "..", "..", "..", "packages", "core", "test", "fixtures", "trackers", "acme.json");

export const ACME_LABEL = "Acme Tracker";
export const ACME_BROWSE = "https://acme.example/browse";

/** Writes Acme's config into the data folder's `trackers/` and returns the environment that makes it the tracker. */
export function useAcmeTracker(dataDir: string): Record<string, string> {
  const folder = path.join(dataDir, "trackers");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "acme.json"), readFileSync(ACME_FIXTURE, "utf8"));
  return { ARIA_FAKE_TRACKER: "acme" };
}
