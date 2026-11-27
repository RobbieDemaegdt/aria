import type { AriaApi } from "@aria/protocol";
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

import { AutomationsView } from "../src/renderer/src/components/AutomationsView";
import { Chat, ChatTail, findSupersededSessionItems } from "../src/renderer/src/components/Chat";
import { Markdown } from "../src/renderer/src/components/Markdown";
import { useAria } from "../src/renderer/src/store";

const api: Partial<AriaApi> = {
  reply: async () => {},
};
(globalThis as { window?: unknown }).window = { aria: api };

describe("Chat reply GUI", () => {
  beforeEach(() => {
    useAria.setState({
      status: { state: "ready" },
      replyTo: null,
      timeline: [],
      streaming: [],
      tasks: [],
      actionError: null,
    });
  });

  it("renders default composer when replyTo is null", () => {
    const html = renderToStaticMarkup(<Chat />);
    expect(html).not.toContain('data-testid="reply-badge"');
    expect(html).toContain('data-testid="send"');
    expect(html).toContain('title="Send"');
    expect(html).not.toContain("Send to ");
    expect(html).toContain("Ask ARIA anything, @task to message a task, or / for commands…");
    expect(html).toContain("Enter to send · Shift+Enter for a new line");
  });

  it("shows explicit recipient in reply banner and displays 'Send to <title>' when replyTo is active", () => {
    useAria.setState({
      replyTo: {
        taskId: "task-42",
        title: "Database Migration",
      },
    });

    const html = renderToStaticMarkup(<Chat />);

    // 1. Reply banner / badge
    expect(html).toContain('data-testid="reply-badge"');
    expect(html).toContain("Replying to");
    expect(html).toContain("Database Migration");
    expect(html).toContain("(direct message · bypasses ARIA)");
    expect(html).toContain('data-testid="reply-clear"');
    expect(html).toContain('title="Stop replying (Esc)"');

    // 2. Send button
    expect(html).toContain('data-testid="send"');
    expect(html).toContain('title="Send to Database Migration"');
    expect(html).toContain("Send to Database Migration");

    // 3. Composer styling and placeholder
    expect(html).toContain("border-accent/60 ring-1 ring-accent/30");
    expect(html).toContain('placeholder="Message Database Migration…"');
    expect(html).toContain("Enter to send it to the task · Shift+Enter for a new line · Esc to stop replying");
  });

  it("includes question shortId when replyTo answers a question", () => {
    useAria.setState({
      replyTo: {
        taskId: "task-99",
        title: "Deploy Service",
        question: { id: "q-1", shortId: "Q-1" },
      },
    });

    const html = renderToStaticMarkup(<Chat />);

    // Reply badge includes question shortId
    expect(html).toContain('data-testid="reply-badge"');
    expect(html).toContain("Replying to");
    expect(html).toContain("Deploy Service");
    expect(html).toContain(" · Q-1");

    // Placeholder indicates answering the question
    expect(html).toContain('placeholder="Answer Q-1 for Deploy Service…"');

    // Send button still displays Send to title
    expect(html).toContain('title="Send to Deploy Service"');
    expect(html).toContain("Send to Deploy Service");
  });

  it("hides reply banner and restores default send button when replyTo is cleared", () => {
    useAria.setState({
      replyTo: { taskId: "task-1", title: "Task 1" },
    });
    let html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="reply-badge"');
    expect(html).toContain("Send to Task 1");

    useAria.getState().setReplyTo(null);
    html = renderToStaticMarkup(<Chat />);
    expect(html).not.toContain('data-testid="reply-badge"');
    expect(html).not.toContain("Send to Task 1");
    expect(html).toContain('title="Send"');
  });

  it("allows direct message input even when ARIA is starting or error", () => {
    // When replyTo is null and status is starting, composer is disabled
    useAria.setState({ status: { state: "starting", detail: "Starting" }, replyTo: null });
    let html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('placeholder="ARIA is starting…"');
    expect(html).toContain("disabled");

    // When replyTo is active, composer is enabled even while ARIA is starting
    useAria.setState({ replyTo: { taskId: "t1", title: "Active Worker" } });
    html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('placeholder="Message Active Worker…"');
    expect(html).toContain("Send to Active Worker");
    // Textarea does not have disabled attribute
    expect(html).not.toContain('<textarea data-testid="composer" rows="1" disabled=""');
  });

  it("displays action errors above the reply badge when present", () => {
    useAria.setState({
      replyTo: { taskId: "t1", title: "Task 1" },
      actionError: "Failed to send direct message: session busy",
    });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="action-error"');
    expect(html).toContain("Failed to send direct message: session busy");
    expect(html).toContain('data-testid="reply-badge"');
  });

  it("renders via Telegram badge on user messages relayed from Telegram (Phase 8B)", () => {
    useAria.setState({
      timeline: [
        {
          kind: "chat",
          id: "tg-msg-1",
          role: "user",
          content: "Check status from phone",
          createdAt: 1000,
          via: "telegram",
        },
      ],
    });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="chat-via-telegram"');
    expect(html).toContain("via Telegram");
  });

  it("wraps long unspaced URLs inside user chat bubbles and notices with wrap-anywhere", () => {
    useAria.setState({
      timeline: [
        {
          kind: "chat",
          id: "url-msg-1",
          role: "user",
          content:
            "In acme-connector, Can you add this workflow: https://github.com/acme/.github-workflows/blob/main/.github/workflows/copilot-issue-plans.yml to the repo",
          createdAt: 1000,
        },
        {
          kind: "notice",
          id: "notice-1",
          level: "info",
          message: "https://github.com/acme/.github-workflows/blob/main/.github/workflows/copilot-issue-plans.yml",
          createdAt: 1001,
        },
      ],
    });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toMatch(/<div class="[^"]*whitespace-pre-wrap wrap-anywhere[^"]*" data-testid="msg-user">/);
    expect(html).toMatch(/data-testid="notice"[\s\S]*?<span class="min-w-0 wrap-anywhere">/);
  });

  it("shows live execution status while an automation is running and links to chat/inspect/time after completion", () => {
    useAria.setState({
      activity: "Calling list_repositories",
      streaming: [{ id: "s1", text: "Checking repositories now…" }],
      routines: [
        {
          id: "r-prompt",
          name: "Weekday PR check",
          kind: "prompt",
          cron: "0 10 * * 1-5",
          prompt: "Check open PRs",
          enabled: true,
          createdBy: "you",
          lastRunAt: 1500,
          lastRunDate: "2026-10-28",
          lastStatus: "running",
          createdAt: 1000,
          updatedAt: 1500,
        },
        {
          id: "builtin:daily-timesheet",
          name: "Daily timesheet draft",
          kind: "daily_timesheet",
          cron: "30 16 * * 1-5",
          enabled: true,
          createdBy: "builtin",
          lastRunAt: 1400,
          lastRunDate: "2026-10-28",
          lastStatus: "ok",
          lastResult: "Prepared draft for Wed 28 Oct: 7h30m of 8h",
          createdAt: 1000,
          updatedAt: 1400,
        },
      ],
    });

    const html = renderToStaticMarkup(<AutomationsView />);
    expect(html).toContain('data-testid="routine-running-banner"');
    expect(html).toContain("Running in ARIA chat · Calling list_repositories…");
    expect(html).toContain('data-testid="routine-watch-in-chat"');
    expect(html).toContain('data-testid="routine-running-stream"');
    expect(html).toContain("Checking repositories now…");

    expect(html).toContain('data-testid="routine-execution-links"');
    expect(html).toContain('data-testid="routine-view-in-chat"');
    expect(html).toContain('data-testid="routine-open-time"');
  });

  it("renders interactive status-model button in the chat header when a model is active", () => {
    useAria.setState({
      status: { state: "ready", model: "claude-sonnet-4.6", reasoningEffort: "medium" },
    });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="status-model"');
    expect(html).toContain("claude-sonnet-4.6 · medium");
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("renders datetimes on chat messages, notices, and cards, plus day dividers across calendar days", () => {
    const yesterday = Date.now() - 86_400_000;
    const today = Date.now();
    useAria.setState({
      tasks: [
        {
          id: "t1",
          slug: "t1",
          title: "Refactor Auth",
          brief: "Refactor Auth",
          repoId: 1,
          repoName: "ARIA",
          repoPath: "/repo",
          profileName: "Default",
          model: "claude-sonnet-4.6",
          mode: "autopilot",
          state: "done",
          costCredits: 0.5,
          startedBy: "you",
          createdAt: yesterday,
          updatedAt: today,
        },
      ],
      timeline: [
        {
          kind: "chat",
          id: "u-yesterday",
          role: "user",
          content: "Start Refactor Auth",
          createdAt: yesterday,
        },
        {
          kind: "notice",
          id: "n-1",
          level: "warning",
          message: "Switched model",
          cause: "model_mismatch",
          taskId: "t1",
          count: 3,
          createdAt: today - 10_000,
          updatedAt: today - 5_000,
        },
        {
          kind: "card",
          id: "c-done-1",
          cardType: "task_done",
          payload: {
            taskId: "t1",
            summary: "Completed refactoring.",
            commits: 1,
            filesChanged: 2,
            additions: 20,
            deletions: 5,
            uncommitted: 0,
          },
          createdAt: today,
        },
        {
          kind: "chat",
          id: "a-today",
          role: "assistant",
          content: "Refactor Auth is complete.",
          createdAt: today,
        },
      ],
    });

    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="timeline-day-divider"');
    expect(html).toContain('data-testid="msg-time"');
    expect(html).toContain('data-testid="notice-time"');
    expect(html).toContain('data-testid="notice-count"');
    expect(html).toContain("×3");
    expect(html).toContain('data-testid="notice-session"');
    expect(html).toContain('data-testid="notice-dismiss"');
    expect(html).toContain('data-testid="card-time"');
  });

  it("identifies superseded session items and shows the Compact header button when session clutter exists", () => {
    const now = Date.now();
    const tasks = [
      {
        id: "t1",
        slug: "t1",
        title: "Session 1",
        brief: "Brief",
        repoId: 1,
        repoName: "Repo",
        repoPath: "/repo",
        profileName: "Default",
        model: "m",
        mode: "autopilot" as const,
        state: "done" as const,
        costCredits: 1,
        startedBy: "you" as const,
        createdAt: now - 5000,
        updatedAt: now,
      },
    ];
    const timeline = [
      {
        kind: "card" as const,
        id: "task-t1",
        cardType: "task" as const,
        payload: { taskId: "t1" },
        createdAt: now - 5000,
      },
      {
        kind: "card" as const,
        id: "q-1",
        cardType: "task_question" as const,
        payload: {
          taskId: "t1",
          questionId: "qid-1",
          shortId: "Q-1",
          question: "Continue?",
          answer: "Yes",
          answeredBy: "you" as const,
        },
        createdAt: now - 4000,
      },
      {
        kind: "notice" as const,
        id: "n-1",
        level: "info" as const,
        message: "Info for t1",
        taskId: "t1",
        createdAt: now - 3000,
      },
      {
        kind: "card" as const,
        id: "done-1",
        cardType: "task_done" as const,
        payload: {
          taskId: "t1",
          summary: "All done",
          commits: 1,
          filesChanged: 1,
          additions: 1,
          deletions: 0,
          uncommitted: 0,
        },
        createdAt: now - 1000,
      },
    ];

    const superseded = findSupersededSessionItems(timeline, tasks, []);
    // Answered question and notice are superseded by the final done card; the primary task card and latest done card stay primary.
    expect([...superseded].sort()).toEqual(["n-1", "q-1"]);

    useAria.setState({ tasks, timeline, watches: [] });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="chat-compact-sessions"');
  });
});

describe("Chat tail: what's still coming in", () => {
  beforeEach(() => {
    useAria.setState({ status: { state: "ready" }, replyTo: null, timeline: [], streaming: [], activity: null, tasks: [], watches: [], actionError: null });
  });

  it("shows the reply being written and what ARIA is doing, below the messages", () => {
    useAria.setState({
      status: { state: "busy" },
      activity: "Calling list_repositories",
      streaming: [{ id: "s1", text: "Checking **repositories** now" }],
      timeline: [{ kind: "chat", id: "m1", role: "assistant", content: "An earlier answer", createdAt: Date.now() - 60_000 }],
    });
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="msg-streaming"');
    expect(html).toContain("<strong>repositories</strong>");
    expect(html).toMatch(/data-testid="activity"[\s\S]*Calling list_repositories…/);
    expect(html.indexOf('data-testid="msg-assistant"')).toBeLessThan(html.indexOf('data-testid="msg-streaming"'));
  });

  it("says Thinking while ARIA is busy with nothing to show yet, and only then", () => {
    useAria.setState({ status: { state: "busy" } });
    expect(renderToStaticMarkup(<ChatTail />)).toMatch(/data-testid="activity"[\s\S]*Thinking…/);

    // Text is coming in and no tool runs: the text itself shows it's working.
    useAria.setState({ streaming: [{ id: "s1", text: "Here it is" }] });
    expect(renderToStaticMarkup(<ChatTail />)).not.toContain('data-testid="activity"');

    useAria.setState({ status: { state: "ready" }, streaming: [] });
    expect(renderToStaticMarkup(<ChatTail />)).toBe("");
  });

  it("shows how far starting up is", () => {
    useAria.setState({ status: { state: "starting", detail: "Signing in" } });
    const html = renderToStaticMarkup(<ChatTail />);
    expect(html).toMatch(/data-testid="starting"[\s\S]*Signing in…/);
    expect(renderToStaticMarkup(<Chat />)).not.toContain('data-testid="empty"');
  });

  it("keeps Markdown memoized: the same text isn't parsed again when what's around it is drawn again", () => {
    // react-markdown parses on every render, and the chat draws hundreds of these on each update without this.
    expect((Markdown as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
