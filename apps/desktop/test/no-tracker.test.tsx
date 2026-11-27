/**
 * No task tracker, in the window. The parts that need a tracker are left out
 * once the state has loaded and has none, or has one without time logs (for the Time view); before the state arrives
 * everything is painted as it was (neutral words, every part), and with a tracker nothing changes. Fictional trackers only.
 */
import type { Activity, CardItem, AriaApi, Task, TimesheetCardPayload, TimesheetEntry, TrackerInfo } from "@aria/protocol";
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
import { Chat } from "../src/renderer/src/components/Chat";
import { MyWork } from "../src/renderer/src/components/MyWork";
import { NewSessionDialog } from "../src/renderer/src/components/NewSessionDialog";
import { OnboardingModal, OnboardingTour, tourStops } from "../src/renderer/src/components/Onboarding";
import { SessionView } from "../src/renderer/src/components/SessionView";
import { TimeView } from "../src/renderer/src/components/TimeView";
import { useHasTracker, useAria, useTracksTime } from "../src/renderer/src/store";

const api: Partial<AriaApi> = {};
(globalThis as { window?: unknown }).window = { aria: api };

const ACME: TrackerInfo = {
  id: "acme",
  label: "Acme Tracker",
  taskUrlTemplate: "https://acme.example/tasks/{id}",
  taskRefPlaceholder: "Acme task ID",
  capabilities: { timeLogs: true, projects: true },
};
/** A tracker that reads tasks and can't register time. */
const NOTES: TrackerInfo = { ...ACME, id: "notes", label: "Notes Desk", capabilities: { timeLogs: false, projects: false } };

/** The window's state for each case: before the state arrives, loaded with no tracker, loaded with one. */
const BEFORE = { loaded: false, tracker: undefined };
const NONE = { loaded: true, tracker: undefined };
const WITH = { loaded: true, tracker: ACME };
const WITHOUT_TIME = { loaded: true, tracker: NOTES };

const task: Task = {
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
  trackerId: "acme",
};

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
  confidence: "uncertain",
  uncertaintyReason: "Suggested by Timekeeper",
  duplicateTrackerId: "9001",
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
  uncertainCount: 1,
  overlapCount: 0,
  duplicateCount: 1,
  gaps: [],
  entries: [entry()],
  registered: [{ id: "9001", start: "11:00", end: "11:30", minutes: 30, trackerTaskId: "1042", trackerId: "acme", comment: "Standup" }],
  ruleOffers: [{ id: "offer-1", entryId: "draft-1", kind: "meeting_title", pattern: "Design review", matchMode: "contains", trackerTaskId: "1042", prompt: "Always map it to task #1042?" }],
  ...over,
});

const activity = (over: Partial<Activity>): Activity => ({
  id: "a1",
  source: "calendar",
  kind: "meeting",
  startedAt: Date.UTC(2026, 10, 19, 9, 0),
  endedAt: Date.UTC(2026, 10, 19, 10, 0),
  externalId: "ev-1",
  title: "Design review",
  metadata: {},
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const timeView = (activities: Activity[]) => ({
  selectedDate: "2026-11-19",
  weekStart: "2026-11-16",
  days: [],
  day: day(),
  activities,
});

const ACTIVITIES: Activity[] = [
  activity({ id: "a1", linkedTrackerTaskId: "1042" }),
  activity({ id: "a2", source: "mail", kind: "mail", externalId: "mail-1", title: "Re: design notes", resolvedTask: { trackerTaskId: "1042", mappedBy: "rule" } }),
  activity({ id: "a3", source: "tracker", kind: "task_updated", externalId: "task-1042", title: "Design review task updated", linkedTrackerTaskId: "1042" }),
  activity({ id: "a4", source: "git", kind: "commit", externalId: "c1", title: "Fix the dark mode", resolvedTask: { trackerTaskId: "1042", mappedBy: "link" } }),
];

/** "<has a tracker>/<tracks time>" as the hooks say it. */
function Probe() {
  return <i>{`${useHasTracker()}/${useTracksTime()}`}</i>;
}

describe("what the window knows about the task tracker", () => {
  beforeEach(() => useAria.setState(BEFORE));

  it("has a tracker, and time logs, until the state says otherwise", () => {
    const probed = () => renderToStaticMarkup(<Probe />);
    expect(probed()).toBe("<i>true/true</i>");
    useAria.setState(NONE);
    expect(probed()).toBe("<i>false/false</i>");
    useAria.setState(WITH);
    expect(probed()).toBe("<i>true/true</i>");
    useAria.setState(WITHOUT_TIME);
    expect(probed()).toBe("<i>true/false</i>");
  });
});

describe("with no task tracker: the places that name a task", () => {
  beforeEach(() => {
    useAria.setState({
      status: { state: "ready" },
      tasks: [task],
      timeline: [],
      streaming: [],
      openTaskId: null,
      newSession: null,
      projects: [{ id: 1, name: "Demo", path: "C:\\Demo", addedVia: "scan", pinned: false, hidden: false }],
      profiles: [{ id: "p1", name: "Fast", model: "claude-haiku", mode: "autopilot", isDefault: true }],
      integrations: { servers: [], tools: [], runtimeUp: true, refreshing: false },
      onboarding: { lastSeenVersion: "0.1.0", setupCompleted: false, tourCompleted: false, updatedAt: 1000 },
      onboardingModalOpen: false,
      tourActive: false,
      tourStep: 0,
      transcripts: {},
      actionError: null,
      ...BEFORE,
    });
  });

  const taskCard: CardItem = { kind: "card", id: "c1", cardType: "task", payload: { taskId: "t1" }, createdAt: 1000 };

  it("leaves the tracker link off a task card, and paints it as before with a tracker or before the state", () => {
    useAria.setState(WITH);
    expect(renderToStaticMarkup(<Card card={taskCard} />)).toContain('data-testid="task-tracker"');
    useAria.setState(BEFORE);
    expect(renderToStaticMarkup(<Card card={taskCard} />)).toContain('data-testid="task-tracker"');
    useAria.setState(NONE);
    expect(renderToStaticMarkup(<Card card={taskCard} />)).not.toContain('data-testid="task-tracker"');
  });

  it("leaves the tracker link off a session", () => {
    useAria.setState({ openTaskId: "t1", ...WITH });
    expect(renderToStaticMarkup(<SessionView />)).toContain('data-testid="session-tracker"');
    useAria.setState(NONE);
    expect(renderToStaticMarkup(<SessionView />)).not.toContain("session-tracker");
  });

  it("leaves the tracker field off the new session dialog", () => {
    useAria.setState({ newSession: { projectId: 1 }, ...WITH });
    expect(renderToStaticMarkup(<NewSessionDialog />)).toContain('data-testid="new-session-tracker"');
    useAria.setState(NONE);
    const html = renderToStaticMarkup(<NewSessionDialog />);
    expect(html).toContain('data-testid="new-session-brief"');
    expect(html).not.toContain("new-session-tracker");
  });

  it("leaves the tracker part off My work, and keeps the others", () => {
    useAria.setState(WITH);
    expect(renderToStaticMarkup(<MyWork />)).toContain('data-testid="my-work-tracker"');
    useAria.setState(NONE);
    const html = renderToStaticMarkup(<MyWork />);
    expect(html).not.toContain("my-work-tracker");
    expect(html).toContain('data-testid="my-work-outlook"');
  });

  it("leaves the tracker question off the chat's starter questions", () => {
    useAria.setState(WITH);
    expect(renderToStaticMarkup(<Chat />)).toContain("Which of my Acme Tracker tasks are in progress?");
    useAria.setState(BEFORE);
    expect(renderToStaticMarkup(<Chat />)).toContain("Which of my Tracker tasks are in progress?");
    useAria.setState(NONE);
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain("What projects do I have?");
    expect(html).not.toContain("in progress?");
  });
});

describe("with no task tracker: the Time view", () => {
  beforeEach(() => {
    useAria.setState({
      ui: { sidebarCollapsed: false, view: "time", selectedTimeDate: "2026-11-19" },
      timeView: timeView(ACTIVITIES),
      ...WITH,
    });
  });

  const html = () => renderToStaticMarkup(<TimeView />);
  /** What belongs to a tracker: Submit, the registered entries, the task chips and badges, the tracker's updates, the mapping rules. */
  const TRACKER_PARTS = [
    "time-submit",
    "time-registered-section",
    "time-draft-duplicate-badge",
    "time-draft-confirm",
    "time-rule-offer",
    "time-digest-tracker",
    "time-rules-section",
    "time-mail-set-rule",
  ];

  it("shows every tracker part with a tracker", () => {
    const shown = html();
    for (const part of TRACKER_PARTS) expect(shown, part).toContain(`data-testid="${part}"`);
    expect(shown).toContain("Time &amp; Acme Tracker Registration");
    expect(shown).toContain("Submit to Acme Tracker");
    expect(shown).toContain("#1042");
  });

  it("leaves them off with no tracker, and keeps the draft rows, with times and comments, and the day's activities", () => {
    useAria.setState(NONE);
    const shown = html();
    for (const part of TRACKER_PARTS) expect(shown, part).not.toContain(`data-testid="${part}"`);
    expect(shown).not.toMatch(/Tracker/);
    expect(shown).not.toContain("#1042");
    expect(shown).not.toContain("unlinked");
    expect(shown).toContain('data-testid="time-draft-row"');
    expect(shown).toContain("Design review");
    expect(shown).toContain('data-testid="time-prepare"');
    expect(shown).toContain('data-testid="time-add-entry"');
    expect(shown).toContain('data-testid="time-digest-meetings"');
    expect(shown).toContain('data-testid="time-digest-emails"');
    expect(shown).toContain("Fix the dark mode");
    // The title says "Time", and the activities' note doesn't name a tracker.
    expect(shown).toContain('<h1 class="text-sm font-semibold">Time</h1>');
    expect(shown).toContain("Meetings you had, tasks you worked on (~±15m rough time) and emails you sent on 2026-11-19.");
  });

  it("leaves the same parts off for a tracker without time logs", () => {
    useAria.setState(WITHOUT_TIME);
    const shown = html();
    for (const part of TRACKER_PARTS) expect(shown, part).not.toContain(`data-testid="${part}"`);
    expect(shown).toContain('data-testid="time-draft-row"');
  });

  it("paints every part before the state arrives", () => {
    useAria.setState(BEFORE);
    const shown = html();
    for (const part of TRACKER_PARTS) expect(shown, part).toContain(`data-testid="${part}"`);
  });
});

describe("with no task tracker: the timesheet cards", () => {
  beforeEach(() => useAria.setState({ status: { state: "ready" }, timeline: [], streaming: [], tasks: [], ...WITH }));

  const draftCard: CardItem = { kind: "card", id: "timesheet-2026-11-19", cardType: "timesheet_draft", payload: day(), createdAt: 1000 };
  const registeredCard: CardItem = {
    kind: "card",
    id: "time-registered-2026-11-19",
    cardType: "time_registered",
    payload: {
      date: "2026-11-19",
      dateLabel: "Thu 19 Nov",
      status: "partial",
      revision: 1,
      totalMinutes: 90,
      registeredMinutes: 30,
      entries: [{ entryId: "e1", start: "09:00", end: "10:00", minutes: 60, trackerTaskId: "1042", trackerProjectId: "7", trackerCustomerId: "8", comment: "Design review", status: "failed", error: "Task closed" }],
    },
    createdAt: 1000,
  };

  it("leaves Submit, the task chips, the registered entries and the rule offers off the draft card, and keeps the rows", () => {
    const withTracker = renderToStaticMarkup(<Card card={draftCard} />);
    for (const part of ["timesheet-submit", "timesheet-registered", "timesheet-rule-offer", "timesheet-row-task", "timesheet-row-confirm"]) {
      expect(withTracker, part).toContain(`data-testid="${part}"`);
    }
    useAria.setState(NONE);
    const shown = renderToStaticMarkup(<Card card={draftCard} />);
    for (const part of ["timesheet-submit", "timesheet-registered", "timesheet-rule-offer", "timesheet-row-task", "timesheet-row-confirm", "timesheet-row-uncertain", "timesheet-row-mapped-by"]) {
      expect(shown, part).not.toContain(`data-testid="${part}"`);
    }
    expect(shown).toContain('data-testid="timesheet-row"');
    expect(shown).toContain('data-testid="timesheet-row-comment"');
    expect(shown).toContain('data-testid="timesheet-add-row"');
  });

  it("leaves Retry failed off a registered card", () => {
    expect(renderToStaticMarkup(<Card card={registeredCard} />)).toContain('data-testid="time-registered-retry"');
    useAria.setState(NONE);
    expect(renderToStaticMarkup(<Card card={registeredCard} />)).not.toContain('data-testid="time-registered-retry"');
  });
});

describe("with no task tracker: the words", () => {
  beforeEach(() => {
    useAria.setState({
      status: { state: "ready" },
      conductor: { model: "claude-haiku", reasoningEffort: "low" },
      timeline: [],
      streaming: [],
      tasks: [],
      projects: [],
      github: { status: "ok", login: "sam", inbox: true },
      integrations: { servers: [], tools: [], runtimeUp: true, refreshing: false },
      onboarding: { lastSeenVersion: "0.1.0", setupCompleted: false, tourCompleted: false, updatedAt: 1000 },
      doctor: null,
      onboardingModalOpen: true,
      tourActive: true,
      tourStep: 3,
      ...WITH,
    });
  });

  it("names the tracker in the welcome, the checklist and the tour with one, as before", () => {
    const chat = renderToStaticMarkup(<Chat />);
    expect(chat).toContain("unlock GitHub watches, Microsoft 365 Work IQ, and Acme Tracker timesheets.");
    expect(chat).toContain("4. Acme Tracker &amp; Work IQ MCP");
    const modal = renderToStaticMarkup(<OnboardingModal />);
    expect(modal).toContain("Recommended — Unlocks GitHub Watchers, Microsoft 365 &amp; Acme Tracker Time");
    expect(modal).toContain("4. MCP Integrations (Acme Tracker &amp; Microsoft 365 Work IQ)");
    expect(modal).toContain("Time &amp; Mapping Rules");
    expect(modal).toContain("repo → Acme Tracker task rules.");
    const tour = renderToStaticMarkup(<OnboardingTour />);
    expect(tour).toContain("4. My Work &amp; Automated Acme Tracker Timesheets");
    expect(tour).toContain("Acme Tracker tasks. Time collects");
  });

  it("names none with no tracker, and says a task tracker is optional", () => {
    useAria.setState(NONE);
    const chat = renderToStaticMarkup(<Chat />);
    expect(chat).toContain("unlock GitHub watches and Microsoft 365 Work IQ.");
    expect(chat).toContain("4. Work IQ MCP");
    expect(chat).not.toMatch(/Tracker/);
    const modal = renderToStaticMarkup(<OnboardingModal />);
    expect(modal).toContain("Recommended — Unlocks GitHub Watchers and Microsoft 365");
    expect(modal).toContain("4. MCP Integrations (Microsoft 365 Work IQ)");
    expect(modal).toContain("pick a task tracker in Customize › Integrations (optional).");
    expect(modal).toContain("Set expected daily hours and the 16:30 draft schedule.");
    expect(modal).not.toMatch(/Tracker/);
    const tour = renderToStaticMarkup(<OnboardingTour />);
    expect(tour).toContain("4. My Work &amp; Time Drafts");
    expect(tour).toContain("pick a task tracker in Customize › Integrations (optional).");
    expect(tour).not.toMatch(/Tracker/);
  });

  it("keeps the tour's other stops, and paints the tracker's stop as before while the state loads", () => {
    const withTracker = tourStops("Acme Tracker");
    const without = tourStops("Tracker", false);
    expect(without.map((s) => s.id)).toEqual(withTracker.map((s) => s.id));
    expect(without.filter((s, i) => s.title !== withTracker[i]!.title).map((s) => s.id)).toEqual(["mywork-time"]);
    expect(withTracker[3]!.title).toBe("4. My Work & Automated Acme Tracker Timesheets");
    useAria.setState(BEFORE);
    expect(renderToStaticMarkup(<OnboardingTour />)).toContain("4. My Work &amp; Automated Tracker Timesheets");
  });
});
