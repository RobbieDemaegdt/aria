import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRepo, parseRemote, scanRoots } from "../src/memory/repos.ts";
import { Store } from "../src/store/store.ts";
import { git, makeRepo } from "./helpers.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "aria-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseRemote", () => {
  it.each([
    ["https://github.com/octo/repo.git", { host: "github.com", owner: "octo", repo: "repo" }],
    ["https://github.com/octo/repo", { host: "github.com", owner: "octo", repo: "repo" }],
    ["octo/repo", { host: "github.com", owner: "octo", repo: "repo" }],
    ["acme/plugin-marketplace", { host: "github.com", owner: "acme", repo: "plugin-marketplace" }],
    ["git@github.com:octo/my.repo.git", { host: "github.com", owner: "octo", repo: "my.repo" }],
    ["ssh://git@github.com:22/octo/repo.git", { host: "github.com", owner: "octo", repo: "repo" }],
    ["https://user@github.example.com/team/x/", { host: "github.example.com", owner: "team", repo: "x" }],
  ])("%s", (url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });

  it("returns nothing for non-repo strings", () => {
    expect(parseRemote("not a url")).toEqual({});
  });
});

describe("scanRoots", () => {
  it("finds top-level git repos, including names with spaces, and skips excluded and non-repo folders", async () => {
    const scanRoot = path.join(root, "scan");
    makeRepo(scanRoot, "Repo A", "https://github.com/me/repo-a.git");
    makeRepo(scanRoot, "Garden Castle Defense", "git@github.com:me/tower.git");
    const self = makeRepo(scanRoot, "ARIA");
    mkdirSync(path.join(scanRoot, "not-a-repo"));
    mkdirSync(path.join(scanRoot, ".hidden"));

    const found = await scanRoots([scanRoot, path.join(root, "missing")], { exclude: [self.toUpperCase()] });
    expect(found.map((r) => r.name)).toEqual(["Garden Castle Defense", "Repo A"]);
    expect(found[0]).toMatchObject({ owner: "me", repo: "tower", defaultBranch: "main" });
  });

  it("reads a fork's upstream remote only when it's on github.com (locally: nothing is fetched)", async () => {
    const scanRoot = path.join(root, "forks");
    const fork = makeRepo(scanRoot, "Fork", "https://github.com/me/widget.git");
    git(fork, "remote", "add", "upstream", "git@github.com:acme/widget.git");
    const elsewhere = makeRepo(scanRoot, "Mirror", "https://github.com/me/mirror.git");
    git(elsewhere, "remote", "add", "upstream", "https://gitlab.com/acme/mirror.git");
    const found = await scanRoots([scanRoot]);
    expect(found.find((r) => r.name === "Fork")).toMatchObject({ owner: "me", repo: "widget", upstream: "acme/widget" });
    expect(found.find((r) => r.name === "Mirror")).not.toHaveProperty("upstream");
    // Through an [include] the config doesn't name it itself: git is asked all the same.
    const included = makeRepo(scanRoot, "Included", "https://github.com/me/included.git");
    writeFileSync(path.join(included, "remotes.inc"), '[remote "upstream"]\n\turl = https://github.com/acme/included.git\n');
    git(included, "config", "include.path", "../remotes.inc");
    expect((await scanRoots([scanRoot])).find((r) => r.name === "Included")).toMatchObject({ upstream: "acme/included" });
  });
});

describe("Store", () => {
  it("migrates idempotently and keeps settings, timeline order and repo choices", () => {
    const file = path.join(root, "db", "aria.db");
    const first = new Store(file);
    first.setSetting("conductor.settings", { model: "m", reasoningEffort: "low" });
    first.upsertTimeline({ kind: "chat", id: "b", role: "assistant", content: "second", createdAt: 2 });
    first.upsertTimeline({ kind: "chat", id: "a", role: "user", content: "first", createdAt: 1 });
    first.upsertTimeline({ kind: "chat", id: "b", role: "assistant", content: "second (final)", createdAt: 2 });
    first.upsertRepo({ name: "x", path: "C:\\x", addedVia: "local" });
    first.upsertRepo({ name: "x renamed", path: "c:\\X", owner: "o", repo: "r", addedVia: "scan" });
    first.close();

    const second = new Store(file);
    expect(second.getSetting("conductor.settings")).toEqual({ model: "m", reasoningEffort: "low" });
    expect(second.listTimeline().map((i) => (i.kind === "chat" ? i.content : ""))).toEqual(["first", "second (final)"]);
    expect(second.deleteTimelineItem("b")).toBe(true);
    expect(second.deleteTimelineItem("b")).toBe(false);
    expect(second.listTimeline().map((i) => i.id)).toEqual(["a"]);
    const repos = second.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "x renamed", owner: "o", addedVia: "local" });
    second.close();
  });

  it("keeps the remote's host, also for a row from before hosts were kept (the next rescan fills it in)", () => {
    const store = new Store(":memory:");
    store.upsertRepo({ name: "x", path: "C:\\x", owner: "o", repo: "r", addedVia: "scan" });
    expect(store.listRepos()[0]).not.toHaveProperty("host");
    store.upsertRepo({ name: "x", path: "C:\\x", host: "github.com", owner: "o", repo: "r", addedVia: "scan" });
    expect(store.listRepos()[0]).toMatchObject({ host: "github.com" });
    store.close();
  });

  it("keeps a fork's upstream (migration 6), and drops it when the remote is gone", () => {
    const store = new Store(":memory:");
    store.upsertRepo({ name: "x", path: "C:\\x", host: "github.com", owner: "me", repo: "r", upstream: "acme/r", addedVia: "scan" });
    expect(store.listRepos()[0]).toMatchObject({ upstream: "acme/r" });
    store.upsertRepo({ name: "x", path: "C:\\x", host: "github.com", owner: "me", repo: "r", addedVia: "scan" });
    expect(store.listRepos()[0]).not.toHaveProperty("upstream");
    store.close();
  });

  it("treats folders that differ only in letter case, accented letters included, as one project", () => {
    const store = new Store(":memory:");
    store.upsertRepo({ name: "Café", path: "C:\\Projects\\Café", addedVia: "local" });
    store.upsertRepo({ name: "CAFÉ", path: "c:\\projects\\CAFÉ\\", addedVia: "scan" });
    expect(store.listRepos()).toEqual([expect.objectContaining({ name: "CAFÉ", path: "C:\\Projects\\Café", addedVia: "local" })]);
    expect(store.getRepoByPath("C:\\PROJECTS\\café")?.name).toBe("CAFÉ");
    store.close();
  });

  it("hides a removed project across scans and restores it when explicitly re-added", () => {
    const store = new Store(":memory:");
    const added = store.upsertRepo({ name: "Notes", path: "C:\\Users\\sam\\Notes", kind: "folder", addedVia: "local" });
    expect(added.hidden).toBe(false);

    const hidden = store.setRepoHidden(added.id, true);
    expect(hidden?.hidden).toBe(true);

    // A background scan keeps the project hidden.
    const scanned = store.upsertRepo({ name: "Notes", path: "C:\\Users\\sam\\Notes", kind: "folder", addedVia: "scan" });
    expect(scanned.hidden).toBe(true);

    // Explicitly re-adding the folder un-hides it.
    const readded = store.upsertRepo({ name: "Notes", path: "C:\\Users\\sam\\Notes", kind: "folder", addedVia: "local" });
    expect(readded.hidden).toBe(false);
    store.close();
  });
});

describe("createRepo", () => {
  it("creates a local git repository when localOnly is true", async () => {
    const createRoot = path.join(root, "created-local");
    mkdirSync(createRoot, { recursive: true });
    const info = await createRepo({
      name: "my-local-app",
      root: createRoot,
      localOnly: true,
      description: "A test project",
      addReadme: true,
    });
    expect(info.name).toBe("my-local-app");
    expect(info.path).toBe(path.join(createRoot, "my-local-app"));
    expect(info.defaultBranch).toBe("main");
  });

  it("refuses to create if the destination folder already exists", async () => {
    const createRoot = path.join(root, "created-exists");
    mkdirSync(path.join(createRoot, "existing-repo"), { recursive: true });
    await expect(
      createRepo({
        name: "existing-repo",
        root: createRoot,
        localOnly: true,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("creates a GitHub repository using gh repo create when mock exec is used", async () => {
    const createRoot = path.join(root, "created-gh");
    mkdirSync(createRoot, { recursive: true });
    const recordedCalls: { file: string; args: string[]; cwd?: string }[] = [];
    const info = await createRepo({
      name: "acme/plugin-marketplace",
      root: createRoot,
      visibility: "private",
      description: "Plugin marketplace catalog",
      addReadme: true,
      ghPath: "gh.exe",
      exec: async (file, args, opts) => {
        recordedCalls.push({ file, args, cwd: opts.cwd });
        // Simulate gh creating and cloning the repo
        makeRepo(createRoot, "plugin-marketplace", "https://github.com/acme/plugin-marketplace.git");
        return { exitCode: 0, stdout: "" };
      },
    });

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]!.file).toBe("gh.exe");
    expect(recordedCalls[0]!.args).toEqual([
      "repo",
      "create",
      "acme/plugin-marketplace",
      "--private",
      "--clone",
      "--description",
      "Plugin marketplace catalog",
      "--add-readme",
    ]);
    expect(recordedCalls[0]!.cwd).toBe(createRoot);
    expect(info.name).toBe("plugin-marketplace");
    expect(info.owner).toBe("acme");
    expect(info.repo).toBe("plugin-marketplace");
  });

  it("throws a clear error if gh repo create fails", async () => {
    const createRoot = path.join(root, "created-fail");
    mkdirSync(createRoot, { recursive: true });
    await expect(
      createRepo({
        name: "acme/failing-repo",
        root: createRoot,
        ghPath: "gh.exe",
        exec: async () => {
          throw new Error("GraphQL: Resource not accessible by personal access token");
        },
      }),
    ).rejects.toThrow(/Failed to create repository on GitHub.*Resource not accessible/);
  });
});
