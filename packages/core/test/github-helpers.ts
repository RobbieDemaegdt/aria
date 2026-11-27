/**
 * Shared by the GitHub tests that run a whole engine: a throwaway project folder (Moonrise on github.com, Elsewhere on
 * gitlab.com, Local only without a remote), the local mock GitHub, the scripted runtime and a manual clock.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem, EngineEvent, Watch } from "@aria/protocol";
import { afterEach } from "vitest";
import { ManualClock } from "../src/attention/clock.ts";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import type { AccountSwitcher, TokenResult } from "../src/github/access.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, git, makeRepo, waitMs } from "./helpers.ts";
import { MOCK_TOKEN, MockGitHub } from "./mock-github.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
const mocks: MockGitHub[] = [];

/** Call once per test file. */
export function cleanUpAfterEach(): void {
  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.stop()));
    await Promise.all(mocks.splice(0).map((m) => m.stop()));
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}

/**
 * Waits until `check` holds. It looks every 25 ms: many checks read the engine's whole state (its timeline from the
 * database), and looking more often only takes CPU from the tests running beside these (the task tests' 5 s limits).
 */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
export const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/**
 * `push`: item 3's tests. github.com's repositories are bare repositories under `<base>/remote` (`me/moonrise.git`, a
 * clone of Moonrise), the engine pushes there (`pushRoot`: a git config of its own points github.com at them, file
 * protocol only), and the mock answers branches and compares from them. `repo` is Moonrise's folder: a test can change
 * it before the engine starts (an upstream remote, a commit GitHub doesn't have).
 */
export async function setupGitHub(options: { tokens?: () => TokenResult; switchAccount?: AccountSwitcher; engine?: Partial<EngineOptions>; logs?: string[]; push?: boolean } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-github-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Moonrise", "https://github.com/me/moonrise.git");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  makeRepo(projects, "Elsewhere", "https://gitlab.com/me/elsewhere.git");
  makeRepo(projects, "Local only");
  const mock = new MockGitHub();
  mocks.push(mock);
  await mock.start();
  mock.addRepo("me", "moonrise");
  mock.addWorkflow("me", "moonrise", "deploy", "deploy.yml");
  const pushRoot = options.push ? path.join(base, "remote") : undefined;
  if (pushRoot) {
    mkdirSync(path.join(pushRoot, "me"), { recursive: true });
    git(base, "clone", "-q", "--bare", repo, path.join(pushRoot, "me", "moonrise.git"));
    mock.gitRoot = pushRoot;
  }
  const runtime = new FakeRuntime();
  const clock = new ManualClock(Date.now());
  let asked = 0;
  const dataDir = path.join(base, "data");
  const make = () => {
    const engine = new AriaEngine({
      dataDir,
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      attentionClock: clock,
      watchClock: clock,
      github: {
        kind: "test",
        baseUrl: mock.baseUrl,
        token: async () => {
          asked++;
          return options.tokens?.() ?? { ok: true, token: MOCK_TOKEN, source: "the mock" };
        },
        fetch: (url, init) => fetch(url, init),
        ...(pushRoot ? { pushRoot } : {}),
        ...(options.switchAccount ? { switchAccount: options.switchAccount } : {}),
        // Item 4: the mock's log storage is where its log redirects go.
        logHosts: [mock.blobUrl],
      },
      githubRetryBaseMs: 1,
      githubTimeoutMs: 3_000,
      // Octokit's throttling plugin spaces searches 2 s apart (notifications 3 s) in real time: tests don't wait for it.
      githubThrottle: false,
      watchJitter: 0,
      ...(options.logs ? { log: (line: string) => options.logs!.push(line) } : {}),
      ...options.engine,
    });
    engines.push(engine);
    return engine;
  };
  return { base, dataDir, mock, runtime, clock, make, asked: () => asked, repo, pushRoot };
}

export function record(engine: AriaEngine): EngineEvent[] {
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return events;
}

export const cards = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);
export const watchOf = (engine: AriaEngine, kind: Watch["kind"]) => engine.getState().watches.find((w) => w.kind === kind && w.state === "active");
export const notices = (engine: AriaEngine, cause: string) => engine.getState().timeline.filter((i) => i.kind === "notice" && i.cause === cause);

/** ARIA calls one of its tools (a scripted reply); the tool's result comes back. */
export async function ariaCalls(engine: AriaEngine, runtime: FakeRuntime, name: string, args: unknown): Promise<unknown> {
  let result: unknown;
  runtime.replies.push({ toolCalls: [{ name, args }], text: (_p, results) => ((result = results[0]), "ok") });
  const before = engine.getState().timeline.length;
  await engine.sendMessage(`call ${name}`);
  await until(() => result !== undefined && engine.getState().timeline.length >= before + 2);
  return result;
}

/** What ARIA was sent with the last message (the digest in front of the words). */
export const lastPrompt = (runtime: FakeRuntime) => [...runtime.sessions.values()][0]!.prompts.at(-1) ?? "";

/** Moves the clock in steps until `check` holds (each step lets the polls answer). */
export async function advanceUntil(clock: ManualClock, check: () => boolean, stepMs = 5_000): Promise<void> {
  await until(() => {
    clock.advance(stepMs);
    return check();
  });
}
