/**
 * Phase 5B unit tests:
 * - SQLite `activities`, `time_rules`, and `tracker_tasks_cache` persistence, overlap window queries, and `manual_link`
 *   protection across re-scans;
 * - Mapping rules (`validateTimeRuleInput`, `matchTimeRules`, `resolveActivityTask`) and specificity ordering;
 * - Plain-code activity collectors (`ActivityCollector` & `AriaEngine`) for ARIA task stretches, GitHub PR/CI
 *   events, and locked-down local `git log` commits across registered repositories.
 */
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActivityCollector,
  buildDeterministicDraft,
  FakeRuntime,
  AriaEngine,
  matchTimeRules,
  resolveActivityDuration,
  resolveActivityTask,
  Store,
  validateTimeRuleInput,
} from "../src/index.ts";
import "./no-network.ts";
import { acmeTracker } from "./helpers/acme.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-5b-test-"));
  tempDirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  childProcess
    .execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    })
    .trim();

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Mapping rules and specificity resolution (rules.ts)", () => {
  it("validates rule inputs and rejects empty patterns or invalid tracker task IDs", () => {
    expect(() =>
      validateTimeRuleInput(acmeTracker, {
        kind: "meeting_title",
        pattern: "   ",
        trackerTaskId: "ACME-123",
      }),
    ).toThrow(/non-empty pattern/);

    expect(() =>
      validateTimeRuleInput(acmeTracker, {
        kind: "meeting_title",
        pattern: "Standup",
        trackerTaskId: "not-an-id",
      }),
    ).toThrow(new RegExp(`valid ${acmeTracker.label} task ID`));

    const valid = validateTimeRuleInput(acmeTracker, {
      kind: "meeting_title",
      pattern: "Standup",
      trackerTaskId: acmeTracker.taskUrl("ACME-123"),
      trackerTaskTitle: "Squad meetings",
    });
    expect(valid).toEqual({
      match: { kind: "meeting_title", pattern: "Standup", matchMode: "contains" },
      trackerTaskId: "ACME-123",
      trackerTaskTitle: "Squad meetings",
      createdFrom: "you",
      enabled: true,
    });
  });

  it("prioritizes explicit links over rules, and orders rules by specificity (branch > repo, exact > prefix > contains, length)", () => {
    const store = new Store(":memory:");
    try {
      const repoRule = store.saveTimeRule(acmeTracker.id, {
        id: "r-repo",
        ...validateTimeRuleInput(acmeTracker, { kind: "repo", repoId: 1, pattern: "Moonrise", trackerTaskId: "ACME-201" }),
      });
      const branchContains = store.saveTimeRule(acmeTracker.id, {
        id: "r-branch-contains",
        ...validateTimeRuleInput(acmeTracker, { kind: "branch", pattern: "design", matchMode: "contains", trackerTaskId: "ACME-202" }),
      });
      const branchPrefix = store.saveTimeRule(acmeTracker.id, {
        id: "r-branch-prefix",
        ...validateTimeRuleInput(acmeTracker, { kind: "branch", pattern: "aria/design-", matchMode: "prefix", trackerTaskId: "ACME-203" }),
      });
      const meetingOrg = store.saveTimeRule(acmeTracker.id, {
        id: "r-org",
        ...validateTimeRuleInput(acmeTracker, { kind: "meeting_organizer", pattern: "alice@example.com", trackerTaskId: "ACME-301" }),
      });
      const meetingTitle = store.saveTimeRule(acmeTracker.id, {
        id: "r-title",
        ...validateTimeRuleInput(acmeTracker, { kind: "meeting_title", pattern: "Standup", trackerTaskId: "ACME-302" }),
      });
      const teamsRule = store.saveTimeRule(acmeTracker.id, {
        id: "r-teams",
        ...validateTimeRuleInput(acmeTracker, { kind: "teams_channel", pattern: "#design-chat", trackerTaskId: "ACME-401" }),
      });

      const rules = [repoRule, branchContains, branchPrefix, meetingOrg, meetingTitle, teamsRule];

      // 1. Explicit link on the activity wins over any rule
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "git",
            kind: "commit",
            repoId: 1,
            title: "Fix design header",
            linkedTrackerTaskId: "ACME-999",
            metadata: { branch: "aria/design-header" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-999", mappedBy: "link" });

      // 2. Explicit link in branch name wins over branch/repo rules
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "git",
            kind: "commit",
            repoId: 1,
            title: "Small cleanup",
            metadata: { branch: "aria/ACME-123-design-header" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-123", mappedBy: "link" });

      // 3. Branch prefix rule beats branch contains rule and repo rule
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "git",
            kind: "commit",
            repoId: 1,
            title: "Small cleanup",
            metadata: { branch: "aria/design-header" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-203", mappedBy: "rule", ruleId: "r-branch-prefix" });

      // 4. Repo rule matches when branch doesn't match branch rules
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "aria",
            kind: "task",
            repoId: 1,
            title: "Refactor scoring",
            metadata: { branch: "aria/refactor-scoring" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-201", mappedBy: "rule", ruleId: "r-repo" });

      // 5. Meeting title beats meeting organizer; organizer matches display-name + email string
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "calendar",
            kind: "meeting",
            title: "Daily Standup",
            metadata: { organizer: "Alice Smith <alice@example.com>" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-302", mappedBy: "rule", ruleId: "r-title" });

      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "calendar",
            kind: "meeting",
            title: "Architecture sync",
            metadata: { organizer: "Alice Smith <alice@example.com>" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-301", mappedBy: "rule", ruleId: "r-org" });

      // 6. Teams channel rule
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "teams",
            kind: "chat",
            title: "Message in #design-chat",
            metadata: { topic: "#design-chat" },
          },
          rules,
        ),
      ).toEqual({ trackerTaskId: "ACME-401", mappedBy: "rule", ruleId: "r-teams" });
      expect(matchTimeRules({ source: "teams", kind: "chat", title: "Other", metadata: {} }, rules)).toEqual([]);

      // 7. Sent email rules (mail_subject > mail_recipient)
      const mailSubjRule = store.saveTimeRule(acmeTracker.id, {
        id: "r-mail-subj",
        ...validateTimeRuleInput(acmeTracker, { kind: "mail_subject", pattern: "Release notes", trackerTaskId: "ACME-501" }),
      });
      const mailRecipRule = store.saveTimeRule(acmeTracker.id, {
        id: "r-mail-recip",
        ...validateTimeRuleInput(acmeTracker, { kind: "mail_recipient", pattern: "customer@example.com", trackerTaskId: "ACME-502" }),
      });
      const allRules = [...rules, mailSubjRule, mailRecipRule];
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "mail",
            kind: "mail",
            title: "Release notes for v2.4",
            metadata: { subject: "Release notes for v2.4", recipient: "customer@example.com" },
          },
          allRules,
        ),
      ).toEqual({ trackerTaskId: "ACME-501", mappedBy: "rule", ruleId: "r-mail-subj" });
      expect(
        resolveActivityTask(
          acmeTracker,
          {
            source: "mail",
            kind: "mail",
            title: "Status update",
            metadata: { subject: "Status update", recipient: "Bob <customer@example.com>" },
          },
          allRules,
        ),
      ).toEqual({ trackerTaskId: "ACME-502", mappedBy: "rule", ruleId: "r-mail-recip" });
    } finally {
      store.close();
    }
  });
});

describe("Store activities, manual_link protection, and tracker_tasks_cache", () => {
  it("preserves manual tracker link overrides and clearances across automatic collector upserts, and caches tracker tasks", () => {
    const store = new Store(":memory:");
    try {
      // Automatic collector records commit with extracted ID ACME-123
      const first = store.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: 1_000,
        endedAt: 1_000,
        repoId: 1,
        externalId: "commit:abc",
        title: "Fix bug (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { sha: "abc" },
      });
      expect(first.linkedTrackerTaskId).toBe("ACME-123");
      expect(first.manualLink).toBeUndefined();

      // User manually overrides the link to ACME-456
      const overridden = store.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: 1_000,
        endedAt: 1_000,
        repoId: 1,
        externalId: "commit:abc",
        title: "Fix bug (task ACME-123)",
        linkedTrackerTaskId: "ACME-456",
        manualLink: true,
        metadata: { sha: "abc" },
      });
      expect(overridden.linkedTrackerTaskId).toBe("ACME-456");
      expect(overridden.manualLink).toBe(true);

      // Next automatic git scan still sees "task ACME-123" in the commit message, but manual_link keeps ACME-456
      const rescanned = store.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: 1_000,
        endedAt: 1_000,
        repoId: 1,
        externalId: "commit:abc",
        title: "Fix bug (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { sha: "abc" },
      });
      expect(rescanned.linkedTrackerTaskId).toBe("ACME-456");
      expect(rescanned.manualLink).toBe(true);

      // User manually clears the link (linkedTrackerTaskId: undefined, manualLink: true)
      const cleared = store.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: 1_000,
        endedAt: 1_000,
        repoId: 1,
        externalId: "commit:abc",
        title: "Fix bug (task ACME-123)",
        linkedTrackerTaskId: undefined,
        manualLink: true,
        metadata: { sha: "abc" },
      });
      expect(cleared.linkedTrackerTaskId).toBeUndefined();
      expect(cleared.manualLink).toBe(true);

      // Re-scan still does not re-populate ACME-123 after manual clearance
      const rescannedAfterClear = store.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: 1_000,
        endedAt: 1_000,
        repoId: 1,
        externalId: "commit:abc",
        title: "Fix bug (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { sha: "abc" },
      });
      expect(rescannedAfterClear.linkedTrackerTaskId).toBeUndefined();

      // Overlap query: activity from 1_000 to 5_000 overlaps [3_000, 6_000]
      store.upsertActivity({
        source: "aria",
        kind: "task",
        startedAt: 1_000,
        endedAt: 5_000,
        repoId: 1,
        externalId: "task:t1:run:1",
        title: "Long task",
      });
      expect(store.listActivities({ since: 3_000, until: 6_000 }).map((a) => a.externalId)).toEqual(["task:t1:run:1"]);

      // tracker_tasks_cache CRUD
      const cached = store.upsertTrackerTaskCache(acmeTracker.id, {
        taskId: "ACME-123",
        title: "Dark mode toggle",
        projectId: "LED",
        customerId: "ACC7",
        status: "In Progress",
        lastSeen: { Priority: "High" },
        fetchedAt: 2_000,
      });
      expect(cached).toMatchObject({ taskId: "ACME-123", projectId: "LED", customerId: "ACC7" });
      expect(store.listTrackerTaskCache(acmeTracker.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("Local git and ARIA task activity collectors (collectors.ts & AriaEngine)", () => {
  it("scans local git commits authored by the user, filters out teammate commits, detects unpushed commits, and extracts tracker task links", async () => {
    const base = makeTempDir();
    const bareRemote = path.join(base, "remote.git");
    const repoDir = path.join(base, "GitHub", "Moonrise");
    mkdirSync(bareRemote, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    git(bareRemote, "init", "--bare", "-q", "-b", "main");
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "config", "user.name", "Sam Rivera");
    git(repoDir, "config", "user.email", "sam@example.com");
    git(repoDir, "remote", "add", "origin", bareRemote);

    // 1. Pushed commit by Sam on main with a tracker task URL in body
    writeFileSync(path.join(repoDir, "README.md"), "# Moonrise\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", `Initial setup\n\nTask: ${acmeTracker.taskUrl("ACME-111")}`);
    git(repoDir, "push", "-q", "-u", "origin", "main");

    // 2. Commit by a teammate on main (must NOT be attributed to Sam)
    writeFileSync(path.join(repoDir, "teammate.txt"), "colleague work\n");
    git(repoDir, "add", "-A");
    git(repoDir, "-c", "user.name=Other Dev", "-c", "user.email=other@example.com", "commit", "-q", "-m", "Teammate commit (task ACME-222)");

    // 3. Unpushed commit by Sam on feature/ACME-123-dark-mode (intermediate commit + tip commit)
    git(repoDir, "checkout", "-q", "-b", "feature/ACME-123-dark-mode");
    writeFileSync(path.join(repoDir, "step1.ts"), "export const step = 1;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "Add theme tokens");
    writeFileSync(path.join(repoDir, "step2.ts"), "export const step = 2;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "Wire toggle button");

    const store = new Store(path.join(base, "aria.db"));
    try {
      const project = store.upsertRepo({
        name: "Moonrise",
        path: repoDir,
        host: "github.com",
        owner: "octocat",
        repo: "Moonrise",
        defaultBranch: "main",
        addedVia: "scan",
      });
      const collector = new ActivityCollector({
        tracker: () => acmeTracker,
        db: () => store,
        projects: () => [project],
        tasks: () => [],
      });

      const count = await collector.scanLocalGitActivities({ force: true });
      // Only Sam's 3 commits (1 on main, 2 on feature/ACME-123-dark-mode), NOT the teammate's commit!
      expect(count).toBe(3);

      const activities = collector.listActivities({ source: "git" });
      expect(activities).toHaveLength(3);
      expect(activities.map((a) => a.title)).not.toContain("Teammate commit (task ACME-222)");

      const initial = activities.find((a) => a.title === "Initial setup")!;
      expect(initial.linkedTrackerTaskId).toBe("ACME-111");
      expect(initial.metadata.unpushed).toBe(false);

      // Both the intermediate commit ("Add theme tokens") and tip commit ("Wire toggle button") get the branch link ACME-123 via `git log --source`!
      const step1 = activities.find((a) => a.title === "Add theme tokens")!;
      const step2 = activities.find((a) => a.title === "Wire toggle button")!;
      expect(step1.metadata.branch).toBe("feature/ACME-123-dark-mode");
      expect(step1.linkedTrackerTaskId).toBe("ACME-123");
      expect(step1.metadata.unpushed).toBe(true);
      expect(step2.metadata.branch).toBe("feature/ACME-123-dark-mode");
      expect(step2.linkedTrackerTaskId).toBe("ACME-123");
      expect(step2.metadata.unpushed).toBe(true);

      // Concurrent scans for different repoId filters both execute rather than coalescing into one repo's scan
      const repoDir2 = path.join(base, "GitHub", "SecondRepo");
      mkdirSync(repoDir2, { recursive: true });
      git(repoDir2, "init", "-q", "-b", "main");
      git(repoDir2, "config", "user.name", "Sam Rivera");
      git(repoDir2, "config", "user.email", "sam@example.com");
      writeFileSync(path.join(repoDir2, "app.ts"), "export const app = 1;\n");
      git(repoDir2, "add", "-A");
      git(repoDir2, "commit", "-q", "-m", "Second repo commit (task ACME-298)");
      const project2 = store.upsertRepo({
        name: "SecondRepo",
        path: repoDir2,
        host: "github.com",
        owner: "octocat",
        repo: "SecondRepo",
        defaultBranch: "main",
        addedVia: "scan",
      });
      const twoRepoCollector = new ActivityCollector({
        tracker: () => acmeTracker,
        db: () => store,
        projects: () => [project, project2],
        tasks: () => [],
      });
      const [c1, c2] = await Promise.all([
        twoRepoCollector.scanLocalGitActivities({ repoId: project.id, force: true }),
        twoRepoCollector.scanLocalGitActivities({ repoId: project2.id, force: true }),
      ]);
      expect(c1).toBe(3);
      expect(c2).toBe(1);
      expect(twoRepoCollector.listActivities({ repoId: project2.id, source: "git" })[0]?.linkedTrackerTaskId).toBe("ACME-298");
    } finally {
      store.close();
    }
  });

  it("records per-stretch ARIA task activities, links tracker task IDs on start or later, and resolves rules via Conductor tools", async () => {
    const base = makeTempDir();
    const repoDir = path.join(base, "GitHub", "DesignApp");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-q", "-b", "main");
    writeFileSync(path.join(repoDir, "index.ts"), "export const x = 1;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "-c", "user.name=Sam", "-c", "user.email=sam@example.com", "commit", "-q", "-m", "Init");

    const runtime = new FakeRuntime();
    runtime.workerScripts.push(
      { steps: [{ complete: "First stretch done." }] },
      { steps: [{ complete: "Second stretch done." }] },
    );

    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [path.join(base, "GitHub")],
      worktreeRoot: path.join(base, "wt"),
      tracker: acmeTracker,
      taskSettleMs: 10,
    });
    await engine.start();
    try {
      const project = engine.getState().projects[0]!;
      // Save a repo mapping rule for DesignApp -> ACME-777
      const rule = engine.saveTimeRule({
        kind: "repo",
        repoId: project.id,
        pattern: "DesignApp",
        trackerTaskId: "ACME-777",
        trackerTaskTitle: "Design general development",
      });
      expect(engine.getState().timeRules).toHaveLength(1);

      // Start a task with an explicit tracker task URL in its brief -> explicit link ACME-123 beats the repo rule ACME-777
      const task = await engine.startTask({
        repoId: project.id,
        title: "Add dark mode",
        brief: `Implement dark mode for ${acmeTracker.taskUrl("ACME-123")}`,
      });
      expect(task.trackerTaskId).toBe("ACME-123");
      // The link says whose it is, so the window links it only while that tracker is in use.
      expect(task.trackerId).toBe(acmeTracker.id);

      // Wait for stretch 1 to finish
      for (let i = 0; i < 60 && engine.getState().tasks[0]?.state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(engine.getState().tasks[0]?.state).toBe("done");

      // Continue the task -> creates stretch 2
      await engine.messageTask(task.id, "Also update the footer", false);
      for (let i = 0; i < 60 && engine.getState().tasks[0]?.state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const stretches = (await engine.listActivities({ source: "aria", scanGit: false })).filter((a) => a.metadata.taskId === task.id);
      expect(stretches.map((s) => s.externalId)).toEqual([`task:${task.id}:run:1`, `task:${task.id}:run:2`]);
      expect(stretches.every((s) => s.resolvedTask?.trackerTaskId === "ACME-123" && s.resolvedTask.mappedBy === "link")).toBe(true);
      expect(stretches.every((s) => s.linkedTrackerId === acmeTracker.id)).toBe(true);

      // Unlink the task's tracker ID -> manual clearance falls back to the repo rule (ACME-777)
      const unlinked = engine.setTaskTracker(task.id, null);
      expect(unlinked.trackerTaskId).toBeUndefined();
      expect(unlinked.trackerId).toBeUndefined();
      const afterUnlink = (await engine.listActivities({ source: "aria", scanGit: false })).filter((a) => a.metadata.taskId === task.id);
      expect(afterUnlink.every((s) => s.linkedTrackerTaskId === undefined && s.resolvedTask?.trackerTaskId === "ACME-777" && s.resolvedTask.mappedBy === "rule")).toBe(true);

      // Re-link to ACME-456 via Conductor's link_task_tracker tool
      runtime.replies.push({
        toolCalls: [
          { name: "link_task_tracker", args: { task: "Add dark mode", trackerTaskId: "ACME-456" } },
          { name: "list_activities", args: { source: "aria", scanGit: false } },
        ],
        text: (_p, results) => `Linked: ${JSON.stringify(results[0])}`,
      });
      await engine.sendMessage("link Add dark mode to ACME-456");
      await new Promise((r) => setTimeout(r, 40));
      expect(engine.getState().tasks[0]?.trackerTaskId).toBe("ACME-456");
      expect(engine.getState().tasks[0]?.trackerId).toBe(acmeTracker.id);

      engine.deleteTimeRule(rule.id);
      expect(engine.getState().timeRules).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  });

  it("supports configurable defaultMinutes on email title/substring rules, non-git folders, project roots, and generic chats", async () => {
    const base = makeTempDir();
    const extraRoot = path.join(base, "ExtraRepos");
    mkdirSync(extraRoot, { recursive: true });
    const repoInExtra = path.join(extraRoot, "ExtraRepo");
    mkdirSync(repoInExtra, { recursive: true });
    git(repoInExtra, "init", "-q", "-b", "main");
    writeFileSync(path.join(repoInExtra, "a.ts"), "export const a = 1;\n");
    git(repoInExtra, "add", "-A");
    git(repoInExtra, "-c", "user.name=Sam", "-c", "user.email=sam@example.com", "commit", "-q", "-m", "Init");

    const plainFolder = path.join(base, "PlainNotesFolder");
    mkdirSync(plainFolder, { recursive: true });
    writeFileSync(path.join(plainFolder, "notes.txt"), "hello\n");

    const runtime = new FakeRuntime();
    runtime.models.unshift({
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      category: "versatile",
      priceCategory: "medium",
      inputPrice: 100,
      outputPrice: 500,
      efforts: ["low", "medium", "high"],
      enabled: true,
    });
    runtime.workerScripts.push(
      { steps: [{ complete: "Folder work done." }] },
      { steps: [{ complete: "Answered generic chat question." }] },
    );

    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [path.join(base, "EmptyRoot")],
      worktreeRoot: path.join(base, "wt"),
      tracker: acmeTracker,
      taskSettleMs: 10,
    });
    await engine.start();
    try {
      // 1. Default Conductor model matches Default profile (versatile) instead of Haiku/lightweight
      expect(engine.getState().conductor.model).toBe("claude-sonnet-4.6");

      // 2. Configurable project roots (addProjectRoot scans new root and persists)
      const roots = await engine.addProjectRoot(extraRoot);
      expect(roots[0]).toBe(path.resolve(extraRoot));
      expect(engine.getState().projects.map((p) => p.name)).toContain("ExtraRepo");

      // 3. Non-git folder support
      const folderProj = await engine.addProjectFolder(plainFolder);
      expect(folderProj.kind).toBe("folder");
      const folderTask = await engine.startTask({
        repoId: folderProj.id,
        title: "Summarize notes",
        brief: "Summarize notes.txt",
      });
      expect(folderTask.kind).toBe("folder");
      for (let i = 0; i < 60 && engine.getState().tasks.find((t) => t.id === folderTask.id)?.state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(engine.getState().tasks.find((t) => t.id === folderTask.id)?.state).toBe("done");

      // 4. Standalone generic chat session (repoId: 0)
      const chatTask = await engine.startTask({
        repoId: 0,
        title: "C# async question",
        brief: "Explain ValueTask vs Task in C#",
      });
      expect(chatTask.kind).toBe("chat");
      expect(chatTask.repoName).toBe("Chats");
      expect(chatTask.mode).toBe("interactive");
      for (let i = 0; i < 60 && engine.getState().tasks.find((t) => t.id === chatTask.id)?.state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(engine.getState().tasks.find((t) => t.id === chatTask.id)?.state).toBe("done");

      // 5. Email duration rule by part of email title (with or without trackerTaskId)
      const mailRule = engine.saveTimeRule({
        kind: "mail_subject",
        pattern: "Release notes",
        matchMode: "contains",
        trackerTaskId: "ACME-123",
        defaultMinutes: 60,
      });
      expect(mailRule.defaultMinutes).toBe(60);

      const durationOnlyRule = engine.saveTimeRule({
        kind: "mail_subject",
        pattern: "[Weekly Digest]",
        matchMode: "contains",
        defaultMinutes: 45,
      });
      expect(durationOnlyRule.defaultMinutes).toBe(45);
      expect(durationOnlyRule.trackerTaskId).toBe("");

      const allRules = engine.listTimeRules();
      expect(
        resolveActivityDuration(
          {
            source: "mail",
            kind: "mail",
            title: "Release notes for connector 1.2.0",
            metadata: { subject: "Release notes for connector 1.2.0" },
          },
          allRules,
        ),
      ).toBe(60);

      const draftRows = buildDeterministicDraft({
        tracker: acmeTracker,
        date: "2026-11-04",
        timeZone: "UTC",
        preservedEntries: [],
        registered: [],
        activities: [
          {
            id: "act-mail-1",
            source: "mail",
            kind: "mail",
            startedAt: Date.parse("2026-11-04T10:00:00Z"),
            endedAt: Date.parse("2026-11-04T10:15:00Z"),
            externalId: "mail:1",
            title: "Release notes for connector 1.2.0",
            metadata: { subject: "Release notes for connector 1.2.0" },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        rules: allRules,
        taskCache: new Map(),
        roundingMinutes: 15,
        workStart: "09:00",
        workEnd: "17:00",
      });
      expect(draftRows).toHaveLength(1);
      expect(draftRows[0]?.start).toBe("10:00");
      expect(draftRows[0]?.end).toBe("11:00");
      expect(draftRows[0]?.trackerTaskId).toBe("ACME-123");
    } finally {
      await engine.stop();
    }
  });
});
