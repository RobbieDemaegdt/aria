/**
 * Task links in the window follow the tracker in use: a task's page is built from
 * the tracker's template only for a task of that tracker: an ARIA task's, a timesheet row's or a registered entry's
 * `trackerId`, or the tracker a card's ID starts with. Any other ID shows as plain text, and a registered entry of another
 * tracker is history, with no Edit, Duplicate or Delete. Before the state arrives there is no tracker and nothing to link.
 * Fictional trackers only: Acme Tracker is in use, Orbit Desk is the one the data is of.
 */
import type { CardItem, AriaApi, Task, TimesheetCardPayload, TimesheetEntry, TrackerInfo } from "@aria/protocol";
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
import { SessionView } from "../src/renderer/src/components/SessionView";
import { TimeView } from "../src/renderer/src/components/TimeView";
import { useAria } from "../src/renderer/src/store";
import { ownsTask } from "../src/renderer/src/tracker";

const api: Partial<AriaApi> = {};
(globalThis as { window?: unknown }).window = { aria: api };

const ACME: TrackerInfo = {
  id: "acme",
  label: "Acme Tracker",
  taskUrlTemplate: "https://acme.example/tasks/{id}",
  taskRefPlaceholder: "Acme task ID",
  capabilities: { timeLogs: true, projects: true },
};

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  slug: "t1",
  title: "Dark mode",
  brief: "Add a dark mode",
  repoId: 1,
  repoName: "org/repo",
  repoPath: "C:\\Demo",
  branch: "main",
  mode: "autopilot",
  startedBy: "you",
  state: "running",
  profileId: "p1",
  profileName: "Fast",
  model: "claude-haiku",
  costCredits: 0.1,
  createdAt: 1000,
  startedAt: 1000,
  updatedAt: 1000,
  trackerTaskId: "1042",
  ...over,
});

const entry = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: "draft-1",
  date: "2026-11-19",
  start: "09:00",
  end: "10:00",
  minutes: 60,
  trackerTaskId: "1042",
  trackerId: "acme",
  trackerTaskTitle: "Design review",
  comment: "Design review",
  sources: [],
  mappedBy: "rule",
  confidence: "certain",
  state: "draft",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const day = (over: Partial<TimesheetCardPayload> = {}): TimesheetCardPayload => ({
  date: "2026-11-19",
  dateLabel: "Thu 19 Nov",
  timeZone: "Europe/Brussels",
  status: "draft",
  revision: 1,
  draftMinutes: 60,
  registeredMinutes: 30,
  dayTotalMinutes: 90,
  expectedMinutes: 480,
  uncertainCount: 0,
  overlapCount: 0,
  duplicateCount: 0,
  gaps: [],
  entries: [entry()],
  registered: [{ id: "9001", start: "11:00", end: "11:30", minutes: 30, trackerTaskId: "1042", trackerId: "acme", comment: "Standup" }],
  ruleOffers: [],
  ...over,
});

const timeView = (payload: TimesheetCardPayload) => ({ selectedDate: "2026-11-19", weekStart: "2026-11-16", days: [], day: payload, activities: [] });

const IN_USE = { loaded: true, tracker: ACME };

describe("which tasks the window links", () => {
  it("links the tracker's own, and nothing of another's or of one that says nothing, once the state names the tracker", () => {
    expect(ownsTask(ACME, "acme")).toBe(true);
    expect(ownsTask(ACME, "orbit")).toBe(false);
    expect(ownsTask(ACME, undefined)).toBe(false);
    // Before the state there is no tracker and no link to build: the words paint as they did.
    expect(ownsTask(undefined, "orbit")).toBe(true);
    expect(ownsTask(undefined, undefined)).toBe(true);
  });
});

describe("an ARIA task's tracker link", () => {
  beforeEach(() => {
    useAria.setState({ status: { state: "ready" }, tasks: [task()], timeline: [], streaming: [], openTaskId: null, ...IN_USE });
  });
  const taskCard: CardItem = { kind: "card", id: "c1", cardType: "task", payload: { taskId: "t1" }, createdAt: 1000 };

  it("is a link for a task of the tracker in use, and plain text for a task of another tracker or one with no stamp", () => {
    useAria.setState({ tasks: [task({ trackerId: "acme" })] });
    const own = renderToStaticMarkup(<Card card={taskCard} />);
    expect(own).toContain('data-testid="task-tracker"');
    expect(own).toContain("Open Acme Tracker task 1042");
    expect(own).not.toContain("task-tracker-plain");

    for (const trackerId of ["orbit", undefined]) {
      useAria.setState({ tasks: [task(trackerId ? { trackerId } : {})] });
      const html = renderToStaticMarkup(<Card card={taskCard} />);
      expect(html).toContain('data-testid="task-tracker-plain"');
      expect(html).toContain("#1042");
      expect(html).not.toContain('data-testid="task-tracker"');
      expect(html).not.toContain("Open Acme Tracker task");
    }
  });

  it("is painted as before until the state arrives", () => {
    useAria.setState({ tasks: [task({ trackerId: "orbit" })], loaded: false, tracker: undefined });
    const html = renderToStaticMarkup(<Card card={taskCard} />);
    expect(html).toContain('data-testid="task-tracker"');
    expect(html).toContain("Task #1042");
  });

  it("is the same in the session: a link for the tracker's own, plain text and the way to change it for another's", () => {
    useAria.setState({ openTaskId: "t1", tasks: [task({ trackerId: "acme" })] });
    const own = renderToStaticMarkup(<SessionView />);
    expect(own).toContain('data-testid="session-tracker-link"');
    expect(own).not.toContain("session-tracker-plain");
    useAria.setState({ tasks: [task({ trackerId: "orbit" })] });
    const other = renderToStaticMarkup(<SessionView />);
    expect(other).toContain('data-testid="session-tracker-plain"');
    expect(other).not.toContain('data-testid="session-tracker-link"');
    expect(other).toContain('data-testid="session-tracker-edit"');
  });
});

describe("a timesheet row's task and a registered entry", () => {
  beforeEach(() => {
    useAria.setState({ ui: { sidebarCollapsed: false, view: "time", selectedTimeDate: "2026-11-19" }, timeView: timeView(day()), ...IN_USE });
  });
  const view = () => renderToStaticMarkup(<TimeView />);
  const draftCard = (payload: TimesheetCardPayload): CardItem => ({ kind: "card", id: "timesheet-2026-11-19", cardType: "timesheet_draft", payload, createdAt: 1000 });

  it("links the task of a row of the tracker in use, in the Time view and on the timesheet card", () => {
    expect(view()).not.toContain("time-row-task-plain");
    const card = renderToStaticMarkup(<Card card={draftCard(day())} />);
    expect(card).toContain('data-testid="timesheet-row-task"');
    expect(card).not.toContain("timesheet-row-task-plain");
  });

  it("shows the task of a row of another tracker as plain text, and the row waits for one of this tracker's", () => {
    const payload = day({ entries: [entry({ trackerId: "orbit", confidence: "uncertain", uncertaintyReason: "Task from another tracker — pick a Acme Tracker task" })] });
    useAria.setState({ timeView: timeView(payload) });
    const html = view();
    expect(html).toContain('data-testid="time-row-task-plain"');
    expect(html).toContain("pick one of this tracker&#x27;s before submitting");
    const card = renderToStaticMarkup(<Card card={draftCard(payload)} />);
    expect(card).toContain('data-testid="timesheet-row-task-plain"');
    expect(card).not.toContain('data-testid="timesheet-row-task"');
  });

  it("keeps a registered entry of the tracker in use as it is: a link, the ID, Edit, Duplicate and Delete", () => {
    const html = view();
    expect(html).toContain('data-testid="time-registered-id"');
    for (const part of ["time-registered-edit", "time-registered-duplicate", "time-registered-delete"]) expect(html, part).toContain(`data-testid="${part}"`);
    expect(html).not.toContain("time-registered-history");
    expect(html).not.toContain("time-registered-task-plain");
  });

  it("shows a registered entry of another tracker as history: plain text, no link, no Edit, Duplicate or Delete", () => {
    const orbit = { id: "9001", start: "11:00", end: "11:30", minutes: 30, trackerTaskId: "1042", trackerId: "orbit", comment: "Standup" };
    useAria.setState({ timeView: timeView(day({ registered: [orbit] })) });
    const html = view();
    expect(html).toContain('data-testid="time-registered-item"');
    expect(html).toContain('data-testid="time-registered-history"');
    expect(html).toContain('data-testid="time-registered-task-plain"');
    expect(html).not.toContain('data-testid="time-registered-id"');
    for (const part of ["time-registered-edit", "time-registered-duplicate", "time-registered-delete"]) expect(html, part).not.toContain(`data-testid="${part}"`);
  });

  it("keeps an unstamped registered entry as the tracker's own (core stamps what it reads), and links it only once it is stamped", () => {
    const { trackerId: _gone, ...unstamped } = { id: "9001", start: "11:00", end: "11:30", minutes: 30, trackerTaskId: "1042", trackerId: "acme", comment: "Standup" };
    useAria.setState({ timeView: timeView(day({ registered: [unstamped] })) });
    const html = view();
    expect(html).toContain('data-testid="time-registered-edit"');
    expect(html).toContain('data-testid="time-registered-task-plain"');
  });
});

describe("a tracker's update card", () => {
  beforeEach(() => {
    useAria.setState({ status: { state: "ready" }, ...IN_USE });
  });
  const update = (id: string): CardItem => ({
    kind: "card",
    id,
    cardType: "tracker_update",
    payload: { taskId: "100789", title: "Usage Report Export", event: "comment_added", url: "https://acme.example/tasks/100789" },
    createdAt: 1000,
  });

  it("has its Open task link when the card's ID starts with the tracker in use's id, and not when it is another tracker's", () => {
    expect(renderToStaticMarkup(<Card card={update("acme-100789-comment")} />)).toContain('data-testid="tracker-update-open"');
    const other = renderToStaticMarkup(<Card card={update("orbit-100789-comment")} />);
    expect(other).not.toContain("tracker-update-open");
    // The card itself still shows, as history.
    expect(other).toContain('data-testid="card-tracker-update"');
    expect(other).toContain("Usage Report Export");
  });
});
