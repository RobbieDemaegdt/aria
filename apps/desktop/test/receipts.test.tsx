import type { CardItem, AriaApi, Task, TaskState, TimelineItem } from "@aria/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    create: (createState: any) => {
      const store = actual.createStore(createState);
      const useBoundStore = (selector: (s: any) => any = (s: any) => s) => selector(store.getState());
      Object.assign(useBoundStore, store);
      return useBoundStore;
    },
  };
});

import { Card } from "../src/renderer/src/components/Cards";
import { oneLine } from "../src/renderer/src/components/CardParts";
import { Chat } from "../src/renderer/src/components/Chat";
import { useAria } from "../src/renderer/src/store";

(globalThis as { window?: unknown }).window = { aria: {} as Partial<AriaApi> };

const NOW = Date.now();
const makeTask = (id: string, state: TaskState, over: Partial<Task> = {}): Task => ({
  id,
  slug: id,
  title: `Task ${id}`,
  brief: "b",
  repoId: 1,
  repoName: "org/repo",
  repoPath: "/repo",
  mode: "autopilot",
  startedBy: "you",
  state,
  profileName: "Fast",
  model: "claude-haiku",
  costCredits: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const question = (answer?: string, extra: Record<string, unknown> = {}): CardItem => ({
  kind: "card",
  id: "q-card",
  cardType: "task_question",
  payload: { taskId: "t1", questionId: "q1", shortId: "Q-1", question: "Which **header**\ncolour?", ...(answer ? { answer, answeredBy: "you" } : {}), ...extra },
  createdAt: NOW,
});
const permission = (extra: Record<string, unknown> = {}): CardItem =>
  ({
    kind: "card",
    id: "p-card",
    cardType: "task_permission",
    payload: { taskId: "t1", permissionId: "p1", shortId: "P-1", kind: "shell", what: "npm install left-pad", reason: "Adds a package", scope: "npm install", sandboxed: true, ...extra },
    createdAt: NOW,
  }) as CardItem;
const plan = (decision?: string, over: { summary?: string; plan?: string } = {}): CardItem =>
  ({ kind: "card", id: "l-card", cardType: "task_plan", payload: { taskId: "t1", planId: "l1", shortId: "L-1", summary: "Add a dark mode", ...(decision ? { decision } : {}), ...over }, createdAt: NOW }) as CardItem;
const waitingPlan = (): Task["plan"] => ({ id: "l1", shortId: "L-1", summary: "Add a dark mode", askedAt: NOW });

describe("one-line receipts for handled cards (option 1)", () => {
  beforeEach(() => {
    useAria.setState({ status: { state: "ready" }, tasks: [], timeline: [], streaming: [], watches: [], replyTo: null, actionError: null });
  });

  it("keeps a question that waits as the whole card, and folds an answered one into a line with the answer", () => {
    useAria.setState({ tasks: [makeTask("t1", "waiting_input", { question: { id: "q1", shortId: "Q-1", question: "Which?", allowFreeform: true, askedAt: NOW } as Task["question"] })] });
    const waiting = renderToStaticMarkup(<Card card={question()} />);
    expect(waiting).not.toContain('data-receipt="true"');
    expect(waiting).toContain('data-testid="question-reply"');

    useAria.setState({ tasks: [makeTask("t1", "running")] });
    const answered = renderToStaticMarkup(<Card card={question("Header", { freeform: true })} />);
    expect(answered).toContain('data-testid="card-question"');
    expect(answered).toContain('data-receipt="true"');
    expect(answered).toContain('data-card-id="q-card"');
    expect(answered).toMatch(/data-testid="question-answer"[^>]*>→ Header</);
    expect(answered).toContain("Which header colour?");
    expect(answered).not.toContain('data-testid="question-reply"');
    // Your own words can still become a note, right from the line.
    expect(answered).toContain('data-testid="save-memory"');
  });

  it("says when a question stopped waiting without an answer", () => {
    useAria.setState({ tasks: [makeTask("t1", "done")] });
    const html = renderToStaticMarkup(<Card card={question()} />);
    expect(html).toContain('data-receipt="true"');
    expect(html).toContain("no longer waiting");
  });

  it("folds a decided permission into its decision and command, and keeps Always allow and Undo on the line", () => {
    useAria.setState({ tasks: [makeTask("t1", "running", { grants: [{ id: "g1" }] } as Partial<Task>)] });
    const html = renderToStaticMarkup(<Card card={permission({ decision: "task", offerId: "o1" })} />);
    expect(html).toContain('data-receipt="true"');
    expect(html).toMatch(/data-testid="permission-decision"[^>]*>Approved for the rest of the task</);
    expect(html).toContain("npm install left-pad");
    expect(html).toContain('data-testid="always-allow"');
    expect(html).toContain('data-testid="permission-undo"');
    // The details are behind the line until you open it.
    expect(html).not.toContain('data-testid="permission-reason"');
  });

  it("keeps a permission that waits whole, with its buttons", () => {
    useAria.setState({ tasks: [makeTask("t1", "waiting_permission", { permissions: [{ id: "p1", shortId: "P-1" }] } as Partial<Task>)] });
    const html = renderToStaticMarkup(<Card card={permission()} />);
    expect(html).not.toContain('data-receipt="true"');
    expect(html).toContain('data-testid="permission-once"');
  });

  it("folds a reviewed plan into its decision and summary", () => {
    useAria.setState({ tasks: [makeTask("t1", "running")] });
    const html = renderToStaticMarkup(<Card card={plan("autopilot")} />);
    expect(html).toContain('data-receipt="true"');
    expect(html).toContain('data-testid="plan-decision"');
    expect(html).toContain("Approved");
    expect(html).toContain("Add a dark mode");
  });

  it("keeps a waiting plan small: a preview, Open plan and the review, with the plan itself in the Plan tab", () => {
    useAria.setState({ tasks: [makeTask("t1", "waiting_input", { plan: waitingPlan() })] });
    const html = renderToStaticMarkup(<Card card={plan(undefined, { plan: "## Steps\n\n1. Add the PLANBODY toggle" })} />);
    expect(html).not.toContain('data-receipt="true"');
    expect(html).toMatch(/data-testid="plan-summary"[^>]*>Add a dark mode</);
    expect(html).toContain('data-testid="plan-open-session"');
    expect(html).toContain('data-testid="plan-autopilot"');
    expect(html).not.toContain("PLANBODY");
    expect(html).not.toContain("<details");
  });

  it("takes a waiting plan's preview from the plan text when the agent gave no summary", () => {
    useAria.setState({ tasks: [makeTask("t1", "waiting_input", { plan: waitingPlan() })] });
    const html = renderToStaticMarkup(<Card card={plan(undefined, { summary: "(no summary)", plan: "# Plan\n\nMove the token refresh" })} />);
    expect(html).toMatch(/data-testid="plan-summary"[^>]*>Plan Move the token refresh</);
    expect(html).not.toContain("(no summary)");
  });

  it("shows a long Markdown summary of a waiting plan as plain text", () => {
    useAria.setState({ tasks: [makeTask("t1", "waiting_input", { plan: waitingPlan() })] });
    const html = renderToStaticMarkup(<Card card={plan(undefined, { summary: `### Dark mode\n\n- **Toggle** in settings\n${"- more words\n".repeat(60)}` })} />);
    expect(html).not.toContain("<h3");
    expect(html).not.toContain("<strong");
    expect(html).toMatch(/data-testid="plan-summary"[^>]*>Dark mode Toggle in settings more words/);
    expect(html).toContain("…");
  });

  it("flattens Markdown and long text to one line", () => {
    expect(oneLine("# Title\n\n- one\n- **two** `x`")).toBe("Title one two x");
    expect(oneLine("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("the chat around them (options 2a and 3-lite)", () => {
  const timeline: TimelineItem[] = [
    { kind: "card", id: "task-t1", cardType: "task", payload: { taskId: "t1" }, createdAt: NOW },
    { kind: "card", id: "q-card", cardType: "task_question", payload: { taskId: "t1", questionId: "q1", shortId: "Q-1", question: "Which?" }, createdAt: NOW },
    { kind: "card", id: "task-t2", cardType: "task", payload: { taskId: "t2" }, createdAt: NOW },
    { kind: "chat", id: "msg", role: "assistant", content: "Both are going.", createdAt: NOW },
  ];

  beforeEach(() => {
    useAria.setState({
      status: { state: "ready" },
      streaming: [],
      watches: [],
      replyTo: null,
      actionError: null,
      timeline,
      tasks: [makeTask("t1", "waiting_input", { question: { id: "q1", shortId: "Q-1", question: "Which?", askedAt: NOW } as Task["question"] }), makeTask("t2", "running")],
    });
  });

  it("draws each session's back-to-back items as one run with its own colour", () => {
    const html = renderToStaticMarkup(<Chat />);
    const runs = [...html.matchAll(/data-testid="session-run" data-session="([^"]+)" data-color="(\d+)"/g)].map((m) => [m[1], m[2]]);
    expect(runs).toEqual([
      ["task:t1", "0"],
      ["task:t2", "1"],
    ]);
    expect(html).toContain('aria-label="Updates from Task t1"');
  });

  it("makes the need-you count a button that goes to what waits", () => {
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toMatch(/<button[^>]*data-testid="needs-you"[^>]*>1 needs you</);
  });
});
