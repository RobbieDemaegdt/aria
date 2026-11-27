/**
 * Which commits are yours, for the Timekeeper's local git scan (the rename's R1 (a)). A commit counts as yours when:
 * its branch starts with `aria/`; its author email is the one the app commits under itself (`aria@local`); its author is
 * your git `user.name` or `user.email` or your GitHub login (exact matches); or its author name or email is in the setting
 * `ownAuthors` (exact match, case ignored). A name that merely contains another name is not yours: a Maria Lopez or an
 * Ariadne Stone is nobody's, and a colleague called ARIA Smith is not the app.
 */
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SetTimekeeperSettingsInput } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityCollector, FakeRuntime, AriaEngine, Store } from "../src/index.ts";
import { patchedTimekeeperSettings, timekeeperSettingsFrom } from "../src/conductor/model-settings.ts";
import "./no-network.ts";
import { acmeTracker } from "./helpers/acme.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-authors-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const git = (cwd: string, ...args: string[]) =>
  childProcess.execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
const commit = (cwd: string, who: string | undefined, subject: string) =>
  git(cwd, ...(who ? ["-c", `user.name=${who.split("|")[0]}`, "-c", `user.email=${who.split("|")[1]}`] : []), "commit", "--allow-empty", "-q", "-m", subject);

/** A repo whose own git identity is Sam Rivera, with commits by many people. Returns where it is. */
function makeRepo(base: string): string {
  const repoDir = path.join(base, "GitHub", "Demo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "config", "user.name", "Sam Rivera");
  git(repoDir, "config", "user.email", "sam@example.com");
  commit(repoDir, undefined, "mine: your own git identity");
  commit(repoDir, "Maria Lopez|maria.lopez@example.com", "not mine: Maria Lopez");
  commit(repoDir, "Ariadne Stone|ariadne@example.com", "not mine: Ariadne Stone");
  commit(repoDir, "ARIA Smith|js@example.com", "not mine: a colleague who shares the app's name");
  commit(repoDir, "ARIA|aria@local", "mine: the app's own commit email");
  commit(repoDir, "ARIA|imposter@example.com", "not mine: the app's name alone");
  commit(repoDir, "Sam R.|sam.r@work.example", "listed: a work identity by name");
  commit(repoDir, "Some Bot|bot@ci.example", "listed: a bot by email");
  commit(repoDir, "Sam R.-Lopez|other@work.example", "not mine: contains a listed name");
  git(repoDir, "checkout", "-q", "-b", "aria/fix-it");
  commit(repoDir, "Worker|worker@example.com", "mine: on an aria/ branch");
  git(repoDir, "checkout", "-q", "main");
  return repoDir;
}

const titlesOf = (collector: ActivityCollector) => collector.listActivities({ source: "git" }).map((a) => a.title).sort();
const MINE = ["mine: on an aria/ branch", "mine: the app's own commit email", "mine: your own git identity"];

describe("which commits are yours (the local git scan)", () => {
  it("counts exact matches only: your git identity, the app's own commit email, an aria/ branch; not Maria, Ariadne or a colleague called ARIA", async () => {
    const base = makeTempDir();
    const repoDir = makeRepo(base);
    const store = new Store(path.join(base, "aria.db"));
    try {
      const project = store.upsertRepo({ name: "Demo", path: repoDir, host: "github.com", owner: "octocat", repo: "Demo", defaultBranch: "main", addedVia: "scan" });
      const collector = new ActivityCollector({ tracker: () => acmeTracker, db: () => store, projects: () => [project], tasks: () => [] });
      await collector.scanLocalGitActivities({ force: true });
      expect(titlesOf(collector)).toEqual(MINE);
    } finally {
      store.close();
    }
  });

  it("adds the names and emails in the setting, matched exactly with case ignored", async () => {
    const base = makeTempDir();
    const repoDir = makeRepo(base);
    const store = new Store(path.join(base, "aria.db"));
    try {
      const project = store.upsertRepo({ name: "Demo", path: repoDir, host: "github.com", owner: "octocat", repo: "Demo", defaultBranch: "main", addedVia: "scan" });
      let list: string[] = ["  sam r.  ", "BOT@CI.EXAMPLE", "maria"];
      const collector = new ActivityCollector({ tracker: () => acmeTracker, db: () => store, projects: () => [project], tasks: () => [], ownAuthors: () => list });
      await collector.scanLocalGitActivities({ force: true });
      // "sam r." is not "Sam R.-Lopez", and "maria" is not "Maria Lopez".
      expect(titlesOf(collector)).toEqual([...MINE, "listed: a bot by email", "listed: a work identity by name"].sort());
      // The list is read at each scan, so a change applies to the next one.
      list = [];
      const again = new ActivityCollector({ tracker: () => acmeTracker, db: () => store, projects: () => [project], tasks: () => [], ownAuthors: () => list });
      expect(await again.scanLocalGitActivities({ force: true })).toBe(MINE.length);
    } finally {
      store.close();
    }
  });
});

describe("the setting ownAuthors", () => {
  const models = [] as const;
  const base = timekeeperSettingsFrom(undefined, models, undefined);

  it("is empty by default, and absent from the default settings", () => {
    expect(base.ownAuthors).toBeUndefined();
    expect("ownAuthors" in base).toBe(false);
  });

  it("trims, drops blanks, and drops repeats that differ only in case, keeping the first spelling", () => {
    const next = patchedTimekeeperSettings(base, { ownAuthors: ["  Sam R. ", "", "sam r.", "Bot@CI.example", "   "] }, models);
    expect(next.ownAuthors).toEqual(["Sam R.", "Bot@CI.example"]);
    expect(timekeeperSettingsFrom(next, models, undefined).ownAuthors).toEqual(["Sam R.", "Bot@CI.example"]);
  });

  it("is kept when another setting changes, and cleared by an empty list", () => {
    const set = patchedTimekeeperSettings(base, { ownAuthors: ["sam@work.example"] }, models);
    expect(patchedTimekeeperSettings(set, { roundingMinutes: 30 }, models).ownAuthors).toEqual(["sam@work.example"]);
    const cleared = patchedTimekeeperSettings(set, { ownAuthors: [] }, models);
    expect("ownAuthors" in cleared).toBe(false);
  });

  it("reads a damaged stored value as no list", () => {
    expect(timekeeperSettingsFrom({ ownAuthors: "sam" } as never, models, undefined).ownAuthors).toBeUndefined();
    expect(timekeeperSettingsFrom({ ownAuthors: ["ok", 3, null, " "] } as never, models, undefined).ownAuthors).toEqual(["ok"]);
  });

  it("is checked at the door: strings of 1 to 200 characters, at most 50", () => {
    expect(SetTimekeeperSettingsInput.parse({ ownAuthors: ["  Sam  ", "sam@work.example"] }).ownAuthors).toEqual(["Sam", "sam@work.example"]);
    expect(() => SetTimekeeperSettingsInput.parse({ ownAuthors: [""] })).toThrow();
    expect(() => SetTimekeeperSettingsInput.parse({ ownAuthors: ["x".repeat(201)] })).toThrow();
    expect(() => SetTimekeeperSettingsInput.parse({ ownAuthors: Array.from({ length: 51 }, (_, i) => `a${i}`) })).toThrow();
    expect(SetTimekeeperSettingsInput.parse({ ownAuthors: [] }).ownAuthors).toEqual([]);
  });
});

describe("the engine", () => {
  it("stores the setting with the Timekeeper's others and the next scan uses it", async () => {
    const base = makeTempDir();
    makeRepo(base);
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime: new FakeRuntime(),
      projectRoots: [path.join(base, "GitHub")],
      worktreeRoot: path.join(base, "wt"),
      tracker: acmeTracker,
    });
    await engine.start();
    try {
      expect(engine.timekeeperSettings().ownAuthors).toBeUndefined();
      await engine.scanGitActivities({ force: true });
      const titles = async () => (await engine.listActivities({ source: "git", scanGit: false })).map((a) => a.title).sort();
      expect(await titles()).toEqual(MINE);

      const saved = engine.setTimekeeperSettings({ ownAuthors: ["Sam R.", "bot@ci.example"] });
      expect(saved.ownAuthors).toEqual(["Sam R.", "bot@ci.example"]);
      expect(engine.timekeeperSettings().ownAuthors).toEqual(["Sam R.", "bot@ci.example"]);
      expect(engine.getState().timekeeper?.ownAuthors).toEqual(["Sam R.", "bot@ci.example"]);
      await engine.scanGitActivities({ force: true });
      expect(await titles()).toEqual([...MINE, "listed: a bot by email", "listed: a work identity by name"].sort());

      expect(engine.setTimekeeperSettings({ ownAuthors: [] }).ownAuthors).toBeUndefined();
    } finally {
      await engine.stop();
    }
  });
});
