import type { CardItem, AriaApi, Task, TaskState, TrackerInfo } from "@aria/protocol";
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

import { Card, ReplyButton, TaskReplyForm } from "../src/renderer/src/components/Cards";
import { SessionView } from "../src/renderer/src/components/SessionView";
import { Sidebar } from "../src/renderer/src/components/Sidebar";
import { TimeView } from "../src/renderer/src/components/TimeView";
import { useAria } from "../src/renderer/src/store";

const api: Partial<AriaApi> = {
  reply: async () => {},
};
(globalThis as { window?: unknown }).window = { aria: api };

const makeTask = (id: string, state: TaskState = "running", over: Partial<Task> = {}): Task => ({
  id,
  slug: id,
  title: `Task ${id}`,
  brief: `Brief for ${id}`,
  repoId: 1,
  repoName: "org/repo",
  repoPath: "/path/to/repo",
  branch: "main",
  mode: "autopilot",
  startedBy: "you",
  state,
  profileId: "p1",
  profileName: "Fast",
  model: "claude-haiku",
  costCredits: 0.12,
  createdAt: 1000,
  startedAt: 1000,
  updatedAt: 1000,
  ...over,
});

const makeTaskCard = (cardId: string, taskId: string): CardItem => ({
  kind: "card",
  id: cardId,
  cardType: "task",
  payload: { taskId },
  createdAt: 1000,
});

const ACME: TrackerInfo = { id: "acme", label: "Acme", taskUrlTemplate: "https://acme.example/tasks/{id}", taskRefPlaceholder: "Acme task ID", capabilities: { timeLogs: true, projects: true } };

describe("Cards & Reply GUI", () => {
  beforeEach(() => {
    useAria.setState({
      tracker: ACME,
      status: { state: "ready" },
      replyTo: null,
      tasks: [],
      timeline: [],
      streaming: [],
      actionError: null,
    });
  });

  describe("ReplyButton", () => {
    it("renders inactive state when replyTo is null", () => {
      const task = makeTask("t1", "running");
      const html = renderToStaticMarkup(<ReplyButton task={task} />);

      expect(html).toContain('data-testid="card-reply"');
      expect(html).toContain("Reply");
      expect(html).not.toContain("Replying below…");
      expect(html).toContain('title="Your next message goes straight to this task, not to ARIA"');
      expect(html).not.toContain("bg-accent");
    });

    it("renders inactive state with question hint when task has pending question", () => {
      const task = makeTask("t1", "waiting_input", {
        question: { id: "q1", shortId: "Q-1", question: "Proceed?", allowFreeform: true, askedAt: 1000 },
      });
      const html = renderToStaticMarkup(<ReplyButton task={task} />);

      expect(html).toContain("Reply");
      expect(html).toContain('title="Answer Q-1 from the chat"');
    });

    it("renders active state when replyTo matches this task", () => {
      const task = makeTask("t1", "running");
      useAria.setState({ replyTo: { taskId: "t1", title: task.title } });

      const html = renderToStaticMarkup(<ReplyButton task={task} />);

      expect(html).toContain("Replying below…");
      expect(html).toContain('title="Stop replying to this task"');
      expect(html).toContain("bg-accent text-white");
    });

    it("toggles replyTo on and off when clicked again", () => {
      const task = makeTask("t1", "running", { title: "Fix Build" });
      expect(useAria.getState().replyTo).toBeNull();

      // 1. Initial click when inactive -> sets replyTo
      const initialElem = ReplyButton({ task });
      expect(initialElem.props.primary).toBe(false);
      initialElem.props.onClick();

      expect(useAria.getState().replyTo).toEqual({
        taskId: "t1",
        title: "Fix Build",
      });

      // 2. Second click when active -> clears replyTo (toggle off)
      const activeElem = ReplyButton({ task });
      expect(activeElem.props.primary).toBe(true);
      activeElem.props.onClick();

      expect(useAria.getState().replyTo).toBeNull();

      // 3. Third click -> toggles on again
      const toggledAgainElem = ReplyButton({ task });
      expect(toggledAgainElem.props.primary).toBe(false);
      toggledAgainElem.props.onClick();

      expect(useAria.getState().replyTo).toEqual({
        taskId: "t1",
        title: "Fix Build",
      });
    });

    it("includes question details when toggling replyTo for a task with a question", () => {
      const task = makeTask("t2", "waiting_input", {
        title: "Migrate DB",
        question: { id: "q-42", shortId: "Q-42", question: "Which DB?", allowFreeform: true, askedAt: 1000 },
      });

      const elem = ReplyButton({ task });
      elem.props.onClick();

      expect(useAria.getState().replyTo).toEqual({
        taskId: "t2",
        title: "Migrate DB",
        question: { id: "q-42", shortId: "Q-42" },
      });

      // Clicking again clears it
      const activeElem = ReplyButton({ task });
      activeElem.props.onClick();
      expect(useAria.getState().replyTo).toBeNull();
    });
  });

  describe("Active Task Card with inline reply", () => {
    it("renders task card without inline reply form when replyTo is inactive", () => {
      const task = makeTask("t1", "running", { title: "Refactor API" });
      useAria.setState({ tasks: [task] });

      const html = renderToStaticMarkup(<Card card={makeTaskCard("c1", "t1")} />);

      // Has reply button
      expect(html).toContain('data-testid="task-reply"');
      expect(html).toContain("Reply");
      expect(html).not.toContain("Replying below…");

      // Shell tone is normal border
      expect(html).toContain("border-line");
      expect(html).not.toContain("border-accent/60");

      // Inline form is NOT rendered
      expect(html).not.toContain('data-testid="task-reply-form"');
      expect(html).not.toContain('data-testid="task-reply-input"');
    });

    it("renders inline direct message form and highlighted tone when replyTo is active for the task", () => {
      const task = makeTask("t1", "running", { title: "Refactor API" });
      useAria.setState({
        tasks: [task],
        replyTo: { taskId: "t1", title: "Refactor API" },
      });

      const html = renderToStaticMarkup(<Card card={makeTaskCard("c1", "t1")} />);

      // ReplyButton shows active state
      expect(html).toContain('data-testid="task-reply"');
      expect(html).toContain("Replying below…");
      expect(html).toContain('title="Stop replying to this task"');

      // Shell tone is highlighted
      expect(html).toContain("border-accent/60");

      // Inline reply form IS rendered
      expect(html).toContain('data-testid="task-reply-form"');
      expect(html).toContain('data-testid="task-reply-input"');
      expect(html).toContain('aria-label="Message Refactor API"');
      expect(html).toContain('placeholder="Message Refactor API…"');
      expect(html).toContain('data-testid="task-reply-send"');
      expect(html).toContain("Send");
    });

    it("renders question-specific placeholder in inline form when task has a pending question", () => {
      const task = makeTask("t1", "waiting_input", {
        title: "Setup Auth",
        question: { id: "q1", shortId: "Q-1", question: "OAuth or SAML?", allowFreeform: true, askedAt: 1000 },
      });
      useAria.setState({
        tasks: [task],
        replyTo: { taskId: "t1", title: "Setup Auth", question: { id: "q1", shortId: "Q-1" } },
      });

      const html = renderToStaticMarkup(<Card card={makeTaskCard("c1", "t1")} />);

      expect(html).toContain('data-testid="task-reply-form"');
      expect(html).toContain('placeholder="Answer Q-1 for Setup Auth…"');
    });

    it("does not render ReplyButton or inline form for non-replyable task states", () => {
      const nonReplyableStates: TaskState[] = ["waiting_permission", "waiting_plan", "done", "failed", "cancelled"];

      for (const state of nonReplyableStates) {
        const task = makeTask(`t-${state}`, state, { title: `Task in ${state}` });
        useAria.setState({
          tasks: [task],
          replyTo: { taskId: task.id, title: task.title },
        });

        const html = renderToStaticMarkup(<Card card={makeTaskCard(`c-${state}`, task.id)} />);

        // Reply button must not appear
        expect(html).not.toContain('data-testid="task-reply"');
        // Inline reply form must not appear even if replyTo matched
        expect(html).not.toContain('data-testid="task-reply-form"');
      }
    });

    it("supports reply for all eligible active/queued task states", () => {
      const eligibleStates: TaskState[] = ["running", "starting", "queued", "waiting_input"];

      for (const state of eligibleStates) {
        const task = makeTask(`t-${state}`, state, { title: `Task in ${state}` });
        useAria.setState({
          tasks: [task],
          replyTo: { taskId: task.id, title: task.title },
        });

        const html = renderToStaticMarkup(<Card card={makeTaskCard(`c-${state}`, task.id)} />);

        expect(html).toContain('data-testid="task-reply"');
        expect(html).toContain("Replying below…");
        expect(html).toContain('data-testid="task-reply-form"');
      }
    });
  });

  describe("TaskReplyForm standalone component", () => {
    it("renders form elements with proper accessibility attributes", () => {
      const task = makeTask("t1", "running", { title: "My Task" });
      const html = renderToStaticMarkup(<TaskReplyForm task={task} />);

      expect(html).toContain('data-testid="task-reply-form"');
      expect(html).toContain('data-testid="task-reply-input"');
      expect(html).toContain('aria-label="Message My Task"');
      expect(html).toContain('placeholder="Message My Task…"');
      expect(html).toContain('data-testid="task-reply-send"');
      expect(html).toContain("disabled"); // send button is disabled when empty
    });
  });

  describe("ProposalCard", () => {
    const proposal = (allowedPaths?: string[]): CardItem => ({
      kind: "card",
      id: "proposal-1",
      cardType: "profile_proposal",
      payload: { repoId: 1, repoName: "org/repo", title: "Compare schemas", brief: "Compare them.", profileId: "p1", profileName: "Fast", model: "claude-haiku", ...(allowedPaths ? { allowedPaths } : {}) },
      createdAt: 1000,
    });

    it("shows what the task may read outside its repository before you press Start", () => {
      const html = renderToStaticMarkup(<Card card={proposal(["C:\\Data\\schema.graphql", "C:\\Data\\other.graphql"])} />);
      expect(html).toContain('data-testid="proposal-paths"');
      expect(html).toContain("C:\\Data\\schema.graphql, C:\\Data\\other.graphql");
    });

    it("says nothing about reading when there's nothing extra to read", () => {
      expect(renderToStaticMarkup(<Card card={proposal()} />)).not.toContain('data-testid="proposal-paths"');
    });

    it("renders the agent selector before Start and the chosen agent badge after starting", () => {
      const pendingHtml = renderToStaticMarkup(<Card card={proposal()} />);
      expect(pendingHtml).toContain('data-testid="proposal-agent"');

      const startedCard: CardItem = {
        kind: "card",
        id: "proposal-2",
        cardType: "profile_proposal",
        payload: {
          repoId: 1,
          repoName: "org/repo",
          title: "Compare schemas",
          brief: "Compare them.",
          profileId: "p1",
          profileName: "Fast",
          model: "claude-haiku",
          agent: "explore",
          decision: "started",
          taskId: "t-started",
        },
        createdAt: 1000,
      };
      const startedHtml = renderToStaticMarkup(<Card card={startedCard} />);
      expect(startedHtml).toContain('data-testid="proposal-agent-badge"');
      expect(startedHtml).toContain("explore");
    });
  });

  describe("ActionRequestCard", () => {
    it("renders write action card with decoded *Json preview and enabled Send button", () => {
      const card: CardItem = {
        kind: "card",
        id: "action-1",
        cardType: "action_request",
        payload: {
          shortId: "A-1",
          server: "Acme",
          tool: "create_tasks",
          wireName: "Acme-create_tasks",
          cls: "write",
          title: "Create Acme task: Fix login",
          note: "Follows the Ledger conventions.",
          argsJson: JSON.stringify({ tasksJson: JSON.stringify([{ Title: "Fix login", Project: { ID: "28939" } }]) }, null, 2),
          status: "pending",
          revision: 1,
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={card} />);
      expect(html).toContain('data-testid="card-action-request"');
      expect(html).toContain("A-1");
      expect(html).toContain("Create Acme task: Fix login");
      expect(html).toContain('data-testid="action-json-preview"');
      expect(html).toContain("tasksJson (decoded preview)");
      expect(html).not.toContain('data-testid="action-confirm-tick"');
      expect(html).toContain('data-testid="action-send"');
    });

    it("renders the tracker task badge on TaskCard when trackerTaskId is set, under the tracker's name", () => {
      const task = makeTask("t1", "running", { title: "Dark mode", trackerTaskId: "100123", trackerId: "acme" });
      useAria.setState({ tasks: [task] });
      const html = renderToStaticMarkup(<Card card={makeTaskCard("c1", "t1")} />);
      expect(html).toContain('data-testid="task-tracker"');
      expect(html).toContain("Acme #100123");
      expect(html).toContain("Open Acme task 100123");
    });

    it("paints neutral words on the tracker task badge before the state names the tracker (Q10)", () => {
      const task = makeTask("t1", "running", { title: "Dark mode", trackerTaskId: "100123" });
      useAria.setState({ tasks: [task], tracker: undefined });
      const html = renderToStaticMarkup(<Card card={makeTaskCard("c1", "t1")} />);
      expect(html).toContain("Task #100123");
      expect(html).not.toContain("Acme");
    });

    it("renders destructive action card with confirmation checkbox, disabled Confirm and run button until ticked, and escapes bidi characters visibly", () => {
      const card: CardItem = {
        kind: "card",
        id: "action-2",
        cardType: "action_request",
        payload: {
          shortId: "A-2",
          server: "Acme",
          tool: "remove_task_from_bucket",
          wireName: "Acme-remove_task_from_bucket",
          cls: "destructive",
          title: "Remove task 100456 from bucket 440",
          argsJson: `{\n  "taskId": "100456\\u202e",\n  "note": "a\u202eb"\n}`,
          requiresConfirmTick: true,
          status: "pending",
          revision: 1,
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={card} />);
      expect(html).toContain('data-testid="action-confirm-tick"');
      expect(html).toContain("Confirm and run");
      expect(html).toMatch(/data-testid="action-send"[^>]*disabled/);
      expect(html).not.toContain("\u202e");
      expect(html).toContain("\\u202e");
    });

    it("renders TimesheetDraftCard with summary, gaps, uncertain row, and learning rule offer", () => {
      const card: CardItem = {
        kind: "card",
        id: "timesheet-2026-10-23",
        cardType: "timesheet_draft",
        payload: {
          date: "2026-10-23",
          dateLabel: "Fri 23 Oct",
          timeZone: "Europe/Brussels",
          status: "draft",
          revision: 1,
          draftMinutes: 420,
          registeredMinutes: 0,
          dayTotalMinutes: 420,
          expectedMinutes: 480,
          uncertainCount: 1,
          overlapCount: 0,
          duplicateCount: 0,
          gaps: [{ start: "14:00", end: "15:00", minutes: 60 }],
          entries: [
            {
              id: "ts-1",
              date: "2026-10-23",
              start: "09:00",
              end: "09:30",
              minutes: 30,
              trackerTaskId: "410001",
              trackerTaskTitle: "Squad meetings",
              trackerProjectId: "27583",
              trackerCustomerId: "708",
              comment: "Daily Standup",
              sources: [{ source: "calendar", title: "Daily Standup" }],
              mappedBy: "suggestion",
              confidence: "uncertain",
              uncertaintyReason: "Suggested by Timekeeper",
              state: "draft",
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
          registered: [],
          ruleOffers: [
            {
              id: "offer-1",
              entryId: "ts-1",
              kind: "meeting_title",
              pattern: "Daily Standup",
              matchMode: "contains",
              trackerTaskId: "410001",
              prompt: 'Always map "Daily Standup" meetings to Acme task #410001?',
            },
          ],
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={card} />);
      expect(html).toContain('data-testid="card-timesheet"');
      expect(html).toContain("Timesheet · Fri 23 Oct");
      expect(html).toContain("draft 7h of 8h · 1 gap · 1 uncertain");
      expect(html).toContain('data-testid="timesheet-fill-gap"');
      expect(html).toContain("14:00–15:00 (1h)");
      expect(html).toContain('data-testid="timesheet-row-confirm"');
      expect(html).toContain('data-testid="timesheet-row-duplicate-btn"');
      expect(html).toContain('data-testid="timesheet-rule-offer"');
      expect(html).toContain('Always map &quot;Daily Standup&quot; meetings to Acme task #410001?');
      expect(html).toContain('data-testid="timesheet-submit"');
      expect(html).toContain('data-testid="timesheet-open-time-view"');
    });

    it("renders TimeRegisteredCard with the tracker's entry IDs, full rawResponse on partial failure (D16), and Retry failed button", () => {
      const card: CardItem = {
        kind: "card",
        id: "time-registered-2026-10-23",
        cardType: "time_registered",
        payload: {
          date: "2026-10-23",
          dateLabel: "Fri 23 Oct",
          status: "partial",
          revision: 1,
          totalMinutes: 480,
          registeredMinutes: 240,
          entries: [
            {
              entryId: "e1",
              start: "09:00",
              end: "13:00",
              minutes: 240,
              trackerTaskId: "100123",
              trackerProjectId: "27583",
              trackerCustomerId: "708",
              comment: "Dark mode",
              status: "registered",
              trackerEntryId: "9000000",
            },
            {
              entryId: "e2",
              start: "13:00",
              end: "17:00",
              minutes: 240,
              trackerTaskId: "100456",
              trackerProjectId: "27583",
              trackerCustomerId: "708",
              comment: "Design sync",
              status: "failed",
              error: "Task closed",
            },
          ],
          rawResponse: '{"created":1,"failed":1,"error":"Task closed"}',
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={card} />);
      expect(html).toContain('data-testid="card-time-registered"');
      expect(html).toContain("Acme #9000000");
      expect(html).toContain('data-testid="time-registered-raw-response"');
      expect(html).toContain('data-testid="time-registered-retry"');
      expect(html).toContain('data-testid="time-registered-duplicate-btn"');
      expect(html).toContain('data-testid="time-registered-open-time-view"');
    });

    it("renders TrackerUpdateCard with Open task and Ask ARIA buttons (Phase 7B)", () => {
      const card: CardItem = {
        kind: "card",
        id: "acme-100789-comment",
        cardType: "tracker_update",
        payload: {
          taskId: "100789",
          title: "Usage Report Export",
          event: "comment_added",
          status: "In Progress",
          priority: "High",
          taskType: "New Feature",
          projectName: "Northwind Connector",
          comment: "Metric polling has stopped on the staging server.",
          commentBy: "Bob",
          url: "https://acme.example/tasks/100789",
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={card} />);
      expect(html).toContain('data-testid="card-tracker-update"');
      expect(html).toContain('data-testid="tracker-update-title"');
      expect(html).toContain("New comment on Acme task #100789");
      expect(html).toContain("Northwind Connector");
      expect(html).toContain('data-testid="tracker-update-subject"');
      expect(html).toContain("Usage Report Export");
      expect(html).toContain('data-testid="tracker-update-comment"');
      expect(html).toContain("Metric polling has stopped on the staging server.");
      expect(html).toContain('data-testid="tracker-update-open"');
      expect(html).toContain('data-testid="tracker-update-ask"');
    });

    it("renders WorkflowDispatchCard in pending and done states", () => {
      const pendingCard: CardItem = {
        kind: "card",
        id: "wd-1",
        cardType: "workflow_dispatch",
        payload: {
          shortId: "WD-1",
          repoId: 1,
          repoName: "acme-connector",
          owner: "acme",
          repo: "acme-connector",
          workflowId: 1001,
          workflowName: "Issue plans with comment approval",
          workflowPath: ".github/workflows/issue-plans.yml",
          ref: "1.0.0",
          inputs: {},
          login: "sam",
          status: "pending",
          revision: 1,
          url: "https://github.com/acme/acme-connector/actions/workflows/issue-plans.yml",
        },
        createdAt: 1000,
      };
      const pendingHtml = renderToStaticMarkup(<Card card={pendingCard} />);
      expect(pendingHtml).toContain('data-testid="card-workflow-dispatch"');
      expect(pendingHtml).toContain("WD-1");
      expect(pendingHtml).toContain("Issue plans with comment approval");
      expect(pendingHtml).toContain("Inputs: default settings (no custom inputs)");
      expect(pendingHtml).toContain('data-testid="workflow-dispatch-run"');
      expect(pendingHtml).toContain("Run workflow");

      const doneCard: CardItem = {
        ...pendingCard,
        id: "wd-2",
        payload: {
          ...pendingCard.payload,
          status: "done",
          watchId: 7,
          dispatchedAt: 2000,
        },
      };
      const doneHtml = renderToStaticMarkup(<Card card={doneCard} />);
      expect(doneHtml).toContain('data-testid="workflow-dispatch-result"');
      expect(doneHtml).toContain("ARIA watches for the run (W-7)");
    });

    it("renders Cloud and Remote badges and Mission Control buttons on TaskCard and DoneCard (Phase 8A)", () => {
      const cloudTask = makeTask("t-cloud", "running", {
        title: "Cloud Refactor",
        where: "cloud",
        missionControlUrl: "https://github.com/copilot/tasks/t-cloud",
      });
      const remoteTask = makeTask("t-remote", "running", {
        title: "Remote Local",
        where: "local",
        remote: true,
        missionControlUrl: "https://github.com/copilot/tasks/t-remote",
      });
      useAria.setState({ tasks: [cloudTask, remoteTask] });

      const cloudHtml = renderToStaticMarkup(<Card card={makeTaskCard("c-cloud", "t-cloud")} />);
      expect(cloudHtml).toContain('data-testid="task-cloud-badge"');
      expect(cloudHtml).toContain('data-testid="task-mission-control"');

      const remoteHtml = renderToStaticMarkup(<Card card={makeTaskCard("c-remote", "t-remote")} />);
      expect(remoteHtml).toContain('data-testid="task-remote-badge"');
      expect(remoteHtml).toContain('data-testid="task-mission-control"');

      const doneCloudTask = makeTask("t-cloud-done", "done", {
        title: "Cloud Done",
        where: "cloud",
        missionControlUrl: "https://github.com/copilot/tasks/t-cloud-done",
      });
      useAria.setState({ tasks: [doneCloudTask] });
      const doneCard: CardItem = {
        kind: "card",
        id: "done-cloud",
        cardType: "task_done",
        payload: {
          taskId: "t-cloud-done",
          summary: "Completed in cloud container.",
          commits: 0,
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          uncommitted: 0,
        },
        createdAt: 1000,
      };
      const doneHtml = renderToStaticMarkup(<Card card={doneCard} />);
      expect(doneHtml).toContain('data-testid="done-cloud-badge"');
      expect(doneHtml).toContain('data-testid="done-mission-control"');
      expect(doneHtml).toContain("Finished on Mission Control.");
      expect(doneHtml).not.toContain('data-testid="done-diff"');
    });

    it("warns about damaged text on the Done and PR cards, with a repair button while the task still has the damage and its worktree, until it's pushed (R1)", () => {
      const damage = { lines: 3, files: 2, paths: ["docs/a.md", "src/b.ts"], base: "0123456789abcdef0123456789abcdef01234567" };
      const done = makeTask("t-enc", "done", { commits: 1, filesChanged: 2, additions: 3, deletions: 3, encodingDamage: damage });
      useAria.setState({ tasks: [done] });
      const doneCard: CardItem = {
        kind: "card",
        id: "done-enc",
        cardType: "task_done",
        payload: { taskId: "t-enc", commits: 1, filesChanged: 2, additions: 3, deletions: 3, uncommitted: 0, encodingDamage: damage },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={doneCard} />);
      expect(html).toContain('data-testid="done-encoding"');
      expect(html).toContain("3 lines in 2 files look like damaged text.");
      expect(html).toContain('title="docs/a.md\nsrc/b.ts"');
      expect(html).toContain('data-testid="done-encoding-repair"');
      // None without damage, and no repair once the worktree is gone.
      expect(renderToStaticMarkup(<Card card={{ ...doneCard, payload: { ...doneCard.payload, encodingDamage: undefined } }} />)).not.toContain("done-encoding");
      useAria.setState({ tasks: [{ ...done, cleanedUp: true }] });
      const cleaned = renderToStaticMarkup(<Card card={doneCard} />);
      expect(cleaned).toContain('data-testid="done-encoding"');
      expect(cleaned).not.toContain('data-testid="done-encoding-repair"');
      // Asked already, or finished again without damage: the card still says what it found, with no button.
      useAria.setState({ tasks: [{ ...done, encodingDamage: undefined }] });
      const asked = renderToStaticMarkup(<Card card={doneCard} />);
      expect(asked).toContain("3 lines in 2 files look like damaged text.");
      expect(asked).not.toContain('data-testid="done-encoding-repair"');

      useAria.setState({ tasks: [done] });
      const prCard = (status: "pending" | "done"): CardItem => ({
        kind: "card",
        id: "pr-enc",
        cardType: "pr_confirm",
        payload: {
          taskId: "t-enc",
          taskTitle: done.title,
          repoName: "Moonrise",
          proposedBy: "you",
          status,
          revision: 1,
          pushTo: { owner: "acme", repo: "moonrise" },
          choices: [{ owner: "acme", repo: "moonrise" }],
          openOn: { owner: "acme", repo: "moonrise" },
          remoteBranch: "aria/enc",
          tip: "1234567890abcdef1234567890abcdef12345678",
          base: "main",
          draft: true,
          title: "Enc",
          body: "Body",
          login: "sam",
          commits: 1,
          filesChanged: 2,
          additions: 3,
          deletions: 3,
          uncommitted: 0,
          encodingDamage: { ...damage, lines: 1, files: 1, paths: ["docs/a.md"] },
          subjects: ["Enc"],
          paths: ["docs/a.md", "src/b.ts"],
          workflows: [],
          flagged: [],
          ...(status === "done" ? { result: { number: 7, url: "https://github.com/acme/moonrise/pull/7", draft: true } } : {}),
        },
        createdAt: 2000,
      });
      const pending = renderToStaticMarkup(<Card card={prCard("pending")} />);
      expect(pending).toContain('data-testid="pr-confirm-encoding"');
      expect(pending).toContain("1 line in 1 file looks like damaged text.");
      expect(pending).toContain('data-testid="pr-confirm-encoding-repair"');
      expect(renderToStaticMarkup(<Card card={prCard("done")} />)).not.toContain('data-testid="pr-confirm-encoding-repair"');
    });

    it("keeps projects alphabetically ordered in the Sidebar regardless of active or waiting tasks", () => {
      const zulu = { id: 1, name: "Zulu", path: "C:\\repos\\zulu", addedVia: "scan" as const, pinned: true, hidden: false };
      const alpha = { id: 2, name: "Alpha", path: "C:\\repos\\alpha", addedVia: "scan" as const, pinned: false, hidden: false };
      const bravo = { id: 3, name: "Bravo", path: "C:\\repos\\bravo", addedVia: "scan" as const, pinned: false, hidden: false };
      const waitingTask = makeTask("t-zulu", "waiting_input", {
        repoId: 1,
        repoName: "Zulu",
        question: { id: "q1", shortId: "Q-1", question: "Continue?", allowFreeform: true, askedAt: 1000 },
      });
      useAria.setState({
        projects: [zulu, bravo, alpha],
        tasks: [waitingTask],
      });
      const html = renderToStaticMarkup(<Sidebar />);
      const names = [...html.matchAll(/data-testid="project" data-project="([^"]+)"/g)].map((m) => m[1]);
      expect(names).toEqual(["Alpha", "Bravo", "Zulu"]);
    });

    it("renders Open PR button, PR link, inline PR confirmation, and Plan tab inside SessionView", () => {
      const project = {
        id: 1,
        name: "Moonrise",
        path: "C:\\repos\\moonrise",
        host: "github.com",
        owner: "acme",
        repo: "moonrise",
        defaultBranch: "main",
        addedVia: "scan" as const,
        pinned: false,
        hidden: false,
      };
      const doneTask = makeTask("t-done", "done", {
        repoId: 1,
        repoName: "Moonrise",
        branch: "aria/fix-auth",
        commits: 2,
        filesChanged: 3,
        additions: 20,
        deletions: 5,
        finishedAt: 2000,
        planText: "# Auth Plan\n\n1. Update middleware\n2. Run tests",
      });
      const prCard: CardItem = {
        kind: "card",
        id: "pr-confirm-1",
        cardType: "pr_confirm",
        payload: {
          taskId: "t-done",
          taskTitle: doneTask.title,
          repoName: "Moonrise",
          proposedBy: "you",
          status: "pending",
          revision: 1,
          pushTo: { owner: "acme", repo: "moonrise" },
          choices: [{ owner: "acme", repo: "moonrise" }],
          openOn: { owner: "acme", repo: "moonrise" },
          remoteBranch: "aria/fix-auth",
          tip: "1234567890abcdef1234567890abcdef12345678",
          base: "main",
          draft: true,
          title: "Fix auth",
          body: "Body",
          login: "sam",
          commits: 2,
          filesChanged: 3,
          additions: 20,
          deletions: 5,
          uncommitted: 0,
          subjects: ["Fix auth"],
          paths: ["src/auth.ts"],
          workflows: [],
          flagged: [],
        },
        createdAt: 2500,
      };
      useAria.setState({
        projects: [project],
        github: { status: "ok", login: "sam", inbox: false },
        tasks: [doneTask],
        timeline: [prCard],
        openTaskId: "t-done",
        sessionTab: "plan",
      });

      const html = renderToStaticMarkup(<SessionView />);
      expect(html).toContain('data-testid="session-open-pr"');
      expect(html).toContain('data-testid="session-pr-confirm"');
      expect(html).toContain('data-testid="session-tab-plan"');
      expect(html).toContain('data-testid="session-plan-markdown"');
      expect(html).toContain("<h1>Auth Plan</h1>");
    });

    it("keeps plan review actions visible, collapses agent summary on the Plan tab, and hides the Queue composer while waiting for plan review", () => {
      const planTask = makeTask("t-plan", "waiting_plan", {
        mode: "plan",
        planText: "# Full Implementation Plan\n\n1. Step one\n2. Step two",
        plan: {
          id: "plan-1",
          shortId: "L-2",
          summary: "### Updated Plan Summary\n\n- **Point A**: Detailed notes",
          plan: "# Full Implementation Plan\n\n1. Step one\n2. Step two",
          askedAt: 2000,
        },
      });
      useAria.setState({
        tasks: [planTask],
        openTaskId: "t-plan",
        sessionTab: "plan",
      });

      const planTabHtml = renderToStaticMarkup(<SessionView />);
      expect(planTabHtml).toContain('data-testid="session-plan"');
      expect(planTabHtml).toContain("Review plan to continue");
      expect(planTabHtml).toContain('data-testid="plan-autopilot"');
      expect(planTabHtml).toContain('data-testid="plan-interactive"');
      expect(planTabHtml).toContain('data-testid="plan-revise"');
      expect(planTabHtml).toContain('data-testid="plan-cancel"');
      // Agent summary is rendered as Markdown inside a collapsed <details> on the Plan tab
      expect(planTabHtml).toContain('data-testid="session-plan-summary"');
      expect(planTabHtml).toContain("<h3>Updated Plan Summary</h3>");
      // The competing Queue composer is hidden while a plan awaits review
      expect(planTabHtml).not.toContain('data-testid="session-composer"');

      // On the Transcript tab, Open plan button and Markdown summary are shown while composer remains hidden
      useAria.setState({ sessionTab: "transcript" });
      const transcriptTabHtml = renderToStaticMarkup(<SessionView />);
      expect(transcriptTabHtml).toContain('data-testid="session-plan-open"');
      expect(transcriptTabHtml).toContain('data-testid="session-plan-summary"');
      expect(transcriptTabHtml).not.toContain('data-testid="session-composer"');

      // If a revised pending plan has only a summary (no plan body), PlanTab shows the new summary rather than stale planText
      const summaryOnlyPlanTask = makeTask("t-plan-summary", "waiting_plan", {
        mode: "plan",
        planText: "# Old Stale Plan",
        plan: {
          id: "plan-2",
          shortId: "L-3",
          summary: "# Fresh Revised Summary Plan",
          askedAt: 3000,
        },
      });
      useAria.setState({
        tasks: [summaryOnlyPlanTask],
        openTaskId: "t-plan-summary",
        sessionTab: "plan",
      });
      const summaryOnlyHtml = renderToStaticMarkup(<SessionView />);
      expect(summaryOnlyHtml).toContain("<h1>Fresh Revised Summary Plan</h1>");
      expect(summaryOnlyHtml).not.toContain("Old Stale Plan");
    });

    it("renders Dismiss button on CiCard and softens border once a fix is recorded", async () => {
      const dismissed: string[] = [];
      api.dismissCard = async ({ cardId }) => {
        dismissed.push(cardId);
      };
      const ciCard: CardItem = {
        kind: "card",
        id: "ci-main-red",
        cardType: "ci",
        payload: {
          watchId: 2,
          owner: "acme",
          repo: ".github-private",
          repoName: ".github-private",
          source: "branch",
          title: "main",
          outcome: "failure",
          conclusion: "failure",
          summary: "1 workflow failing",
          branch: "main",
          url: "https://github.com/acme/.github-private/actions",
        },
        createdAt: 1000,
      };
      const redHtml = renderToStaticMarkup(<Card card={ciCard} />);
      expect(redHtml).toContain('data-testid="card-ci"');
      expect(redHtml).toContain("border-bad/50");
      expect(redHtml).toContain('data-testid="ci-dismiss"');
      expect(redHtml).toContain('data-testid="card-dismiss"');

      const fixedCard: CardItem = {
        ...ciCard,
        payload: {
          ...ciCard.payload,
          fix: {
            taskId: "t-fix",
            taskTitle: "Fix CI on main (W-2)",
            how: "start",
            at: 2000,
          },
        },
      };
      const fixedHtml = renderToStaticMarkup(<Card card={fixedCard} />);
      expect(fixedHtml).toContain("border-line");
      expect(fixedHtml).not.toContain("border-bad/50");

      expect(await useAria.getState().dismissCard("ci-main-red")).toBeNull();
      expect(dismissed).toEqual(["ci-main-red"]);
    });

    it("renders TimeView with selectedDate in time-date-picker", () => {
      useAria.setState({
        ui: { sidebarCollapsed: false, view: "time", selectedTimeDate: "2026-10-29" },
        timeView: {
          selectedDate: "2026-10-29",
          weekStart: "2026-10-26",
          days: [
            {
              date: "2026-10-29",
              dateLabel: "Thu 29 Oct",
              isToday: true,
              isWeekend: false,
              draftMinutes: 0,
              registeredMinutes: 0,
              dayTotalMinutes: 0,
              expectedMinutes: 480,
              draftCount: 0,
              registeredCount: 0,
              uncertainCount: 0,
              overlapCount: 0,
              duplicateCount: 0,
              failedCount: 0,
              gapCount: 0,
            },
          ],
          day: {
            date: "2026-10-29",
            dateLabel: "Thu 29 Oct",
            timeZone: "Europe/Brussels",
            status: "draft",
            revision: 1,
            draftMinutes: 0,
            registeredMinutes: 0,
            dayTotalMinutes: 0,
            expectedMinutes: 480,
            uncertainCount: 0,
            overlapCount: 0,
            duplicateCount: 0,
            gaps: [],
            entries: [],
            registered: [],
            ruleOffers: [],
          },
          activities: [],
        },
      });
      const html = renderToStaticMarkup(<TimeView />);
      expect(html).toContain('data-testid="time-date-picker"');
      expect(html).toContain('value="2026-10-29"');
    });

    it("renders the overlap banner and in-row overlap badges with conflict details", () => {
      useAria.setState({
        timeView: {
          selectedDate: "2026-10-29",
          weekStart: "2026-10-26",
          days: [],
          day: {
            date: "2026-10-29",
            dateLabel: "Thu 29 Oct",
            timeZone: "Europe/Brussels",
            status: "draft",
            revision: 1,
            draftMinutes: 120,
            registeredMinutes: 60,
            dayTotalMinutes: 150,
            expectedMinutes: 480,
            uncertainCount: 0,
            overlapCount: 1,
            duplicateCount: 0,
            gaps: [],
            entries: [
              {
                id: "draft-row-1",
                date: "2026-10-29",
                start: "10:00",
                end: "11:30",
                minutes: 90,
                trackerTaskId: "100123",
                comment: "API Development",
                sources: [],
                mappedBy: "you",
                confidence: "certain",
                overlap: true,
                overlapDetails: [
                  {
                    targetId: "reg-row-1",
                    targetType: "tracker",
                    targetStart: "11:00",
                    targetEnd: "12:00",
                    targetLabel: "Logged earlier",
                    overlapStart: "11:00",
                    overlapEnd: "11:30",
                    overlapMinutes: 30,
                  },
                ],
                state: "draft",
                createdAt: 1000,
                updatedAt: 1000,
              },
            ],
            registered: [
              {
                id: "reg-row-1",
                start: "11:00",
                end: "12:00",
                minutes: 60,
                trackerTaskId: "100123",
                comment: "Logged earlier",
                overlap: true,
                overlapDetails: [
                  {
                    targetId: "draft-row-1",
                    targetType: "draft",
                    targetStart: "10:00",
                    targetEnd: "11:30",
                    targetLabel: "API Development",
                    overlapStart: "11:00",
                    overlapEnd: "11:30",
                    overlapMinutes: 30,
                  },
                ],
              },
            ],
            ruleOffers: [],
          },
          activities: [],
        },
      });

      const html = renderToStaticMarkup(<TimeView />);
      expect(html).toContain('data-testid="time-overlaps-banner"');
      expect(html).toContain("1 overlapping time slot detected");
      expect(html).toContain('data-testid="time-overlap-fix"');
      expect(html).toContain('data-testid="time-draft-overlap-badge"');
      expect(html).toContain('data-testid="time-draft-overlap-details"');
      expect(html).toContain("Overlaps");
      expect(html).toContain("11:00–11:30");
      expect(html).toContain('data-testid="time-registered-overlap-badge"');
      expect(html).toContain('data-testid="time-registered-overlap-details"');
    });

    it("renders the prepare draft button and placeholder for days with no draft rows", () => {
      useAria.setState({
        timeView: {
          selectedDate: "2026-10-29",
          weekStart: "2026-10-26",
          days: [],
          day: {
            date: "2026-10-29",
            dateLabel: "Thu 29 Oct",
            timeZone: "Europe/Brussels",
            status: "draft",
            revision: 1,
            draftMinutes: 0,
            registeredMinutes: 0,
            dayTotalMinutes: 0,
            expectedMinutes: 480,
            uncertainCount: 0,
            overlapCount: 0,
            duplicateCount: 0,
            gaps: [],
            entries: [],
            registered: [],
            ruleOffers: [],
          },
          activities: [],
        },
      });

      const html = renderToStaticMarkup(<TimeView />);
      expect(html).toContain('data-testid="time-prepare"');
      expect(html).toContain("Prepare draft");
      expect(html).toContain("No draft rows for this day.");
    });

    it("renders TimeView loading state when timeView is null and transitions cleanly to loaded state", () => {
      useAria.setState({
        ui: { sidebarCollapsed: false, view: "time", selectedTimeDate: "2026-11-02" },
        timeView: null,
      });
      const loadingHtml = renderToStaticMarkup(<TimeView />);
      expect(loadingHtml).toContain('data-testid="time-view-loading"');
      expect(loadingHtml).toContain("Loading Time view…");

      useAria.setState({
        timeView: {
          selectedDate: "2026-11-02",
          weekStart: "2026-11-02",
          days: [],
          day: {
            date: "2026-11-02",
            dateLabel: "Mon 2 Nov",
            timeZone: "Europe/Brussels",
            status: "draft",
            revision: 1,
            draftMinutes: 0,
            registeredMinutes: 0,
            dayTotalMinutes: 0,
            expectedMinutes: 480,
            uncertainCount: 0,
            overlapCount: 0,
            duplicateCount: 0,
            gaps: [],
            entries: [],
            registered: [],
            ruleOffers: [],
          },
          activities: [],
        },
      });
      const loadedHtml = renderToStaticMarkup(<TimeView />);
      expect(loadedHtml).toContain('data-testid="time-view"');
    });

    it("processes Markdown in DoneCard summary, QuestionCard question, ProposalCard brief, and MorningBriefCardView AI summary", () => {
      const doneTask = makeTask("t-md", "done", { title: "Audit Security" });
      const questionTask = makeTask("t-q", "waiting_input", {
        title: "DB Setup",
        question: { id: "q1", shortId: "Q-1", question: "Use **PostgreSQL** or `SQLite`?", allowFreeform: true, askedAt: 1000 },
      });
      useAria.setState({ tasks: [doneTask, questionTask] });

      const doneHtml = renderToStaticMarkup(
        <Card
          card={{
            kind: "card",
            id: "c-done-md",
            cardType: "task_done",
            payload: {
              taskId: "t-md",
              summary: "### Summary\n\n- Fixed `auth.ts`\n- Added **2** unit tests",
              commits: 1,
              filesChanged: 2,
              additions: 15,
              deletions: 3,
              uncommitted: 0,
            },
            createdAt: 1000,
          }}
        />,
      );
      expect(doneHtml).toContain('data-testid="done-summary"');
      expect(doneHtml).toContain("<h3>Summary</h3>");
      expect(doneHtml).toContain("<code>auth.ts</code>");
      expect(doneHtml).toContain("<strong>2</strong>");

      const questionHtml = renderToStaticMarkup(
        <Card
          card={{
            kind: "card",
            id: "c-q-md",
            cardType: "task_question",
            payload: {
              taskId: "t-q",
              questionId: "q1",
              shortId: "Q-1",
              question: "Use **PostgreSQL** or `SQLite`?",
            },
            createdAt: 1000,
          }}
        />,
      );
      expect(questionHtml).toContain("<strong>PostgreSQL</strong>");
      expect(questionHtml).toContain("<code>SQLite</code>");

      const proposalHtml = renderToStaticMarkup(
        <Card
          card={{
            kind: "card",
            id: "c-prop-md",
            cardType: "profile_proposal",
            payload: {
              repoId: 1,
              repoName: "org/repo",
              title: "Refactor parser",
              brief: "## Goal\n\nUpdate `parser.ts` to handle **GFM** tables.",
              profileId: "p1",
              profileName: "Fast",
              model: "claude-haiku",
            },
            createdAt: 1000,
          }}
        />,
      );
      expect(proposalHtml).toContain("<h2>Goal</h2>");
      expect(proposalHtml).toContain("<code>parser.ts</code>");
      expect(proposalHtml).toContain("<strong>GFM</strong>");

      const briefHtml = renderToStaticMarkup(
        <Card
          card={{
            kind: "card",
            id: "c-brief-md",
            cardType: "morning_brief",
            payload: {
              variant: "morning_brief",
              date: "2026-11-03",
              dateLabel: "Tue 3 Nov",
              headline: "1 task done",
              aiSummary: "Focus on **PR #12** and `main` branch.",
              unregisteredDays: [],
              tasks: [],
              github: [],
              reminders: [],
              generatedAt: 1000,
            },
            createdAt: 1000,
          }}
        />,
      );
      expect(briefHtml).toContain('data-testid="morning-brief-ai-summary"');
      expect(briefHtml).toContain("<strong>PR #12</strong>");
      expect(briefHtml).toContain("<code>main</code>");
    });

    it("renders requested GitHubAccountCard with Switch to @user and Dismiss buttons, and transitions to Switched on completion", async () => {
      const switched: string[] = [];
      api.switchGitHubAccount = async (cardId) => {
        switched.push(cardId);
      };
      const pendingCard: CardItem = {
        kind: "card",
        id: "gh-acc-1",
        cardType: "github_account",
        payload: {
          from: "octocat",
          to: "octocat-work",
          watchIds: [],
          requested: true,
          status: "pending",
          note: "Switch to your **Contoso** account to access the enterprise repository.",
        },
        createdAt: 1000,
      };
      const html = renderToStaticMarkup(<Card card={pendingCard} />);
      expect(html).toContain('data-testid="card-github-account"');
      expect(html).toContain("GitHub: Switch account to @octocat-work");
      expect(html).toContain("gh auth switch --user octocat-work");
      expect(html).toContain("<strong>Contoso</strong>");
      expect(html).toContain('data-testid="github-account-switch"');
      expect(html).toContain("Switch to @octocat-work");
      expect(html).toContain('data-testid="github-account-dismiss"');

      expect(await useAria.getState().switchGitHubAccount("gh-acc-1")).toBeNull();
      expect(switched).toEqual(["gh-acc-1"]);

      const doneCard: CardItem = {
        ...pendingCard,
        payload: {
          ...pendingCard.payload,
          status: "done",
        },
      };
      const doneHtml = renderToStaticMarkup(<Card card={doneCard} />);
      expect(doneHtml).toContain("GitHub: Switched to @octocat-work");
      expect(doneHtml).toContain("ARIA now reads GitHub as @octocat-work (was @octocat).");
      expect(doneHtml).not.toContain('data-testid="github-account-switch"');
    });

    it("renders session rows with menu buttons in the Sidebar and Discard button in SessionView", () => {
      const now = Date.now();
      const project = {
        id: 1,
        name: "AriaProject",
        path: "C:\\repos\\aria",
        addedVia: "scan" as const,
        pinned: false,
        hidden: false,
      };
      const projectTask = makeTask("t-proj", "done", {
        repoId: 1,
        repoName: "AriaProject",
        title: "Feature task",
        updatedAt: now,
        finishedAt: now,
      });
      const chatTask = makeTask("t-chat", "done", {
        repoId: 0,
        kind: "chat",
        title: "General discussion",
        updatedAt: now,
        finishedAt: now,
      });
      useAria.setState({
        projects: [project],
        tasks: [projectTask, chatTask],
        openTaskId: "t-proj",
      });

      const sidebarHtml = renderToStaticMarkup(<Sidebar />);
      expect(sidebarHtml).toContain('data-testid="session"');
      expect(sidebarHtml).toContain('data-testid="session-menu-button"');
      expect(sidebarHtml).toContain('data-testid="chat-session"');
      expect(sidebarHtml).toContain('data-testid="chat-session-menu-button"');

      const sessionViewHtml = renderToStaticMarkup(<SessionView />);
      expect(sessionViewHtml).toContain('data-testid="session-discard"');
      expect(sessionViewHtml).toContain("Discard");
    });
  });
});
