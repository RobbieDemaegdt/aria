import type { AriaApi, RuleOffer, Task, TranscriptEntry, YourWords } from "@aria/protocol";
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

import { Entry, followedStart, stepExtras, ToolEntry, Transcript, TRANSCRIPT_PAGE, transcriptStart, TranscriptStep } from "../src/renderer/src/components/SessionView";
import { useAria, type LoadedTranscript } from "../src/renderer/src/store";

(globalThis as { window?: unknown }).window = { aria: {} as Partial<AriaApi> };

const task = { id: "t1", title: "Long task", repoName: "Demo", state: "running" } as Task;

/** A brief, then `count - 1` tool steps. */
function steps(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i): TranscriptEntry =>
    i === 0 ? { kind: "user", id: "e0", at: 1, text: "The brief" } : { kind: "tool", id: `e${i}`, at: 1 + i, name: "view", args: JSON.stringify({ path: `src/m${i}.ts` }), success: true },
  );
}

/** All of a session's steps loaded. */
const all = (entries: TranscriptEntry[]): LoadedTranscript => ({ entries, omitted: 0, plan: false });
/** Its steps from `omitted` on loaded (P4), with the brief. */
const from = (entries: TranscriptEntry[], omitted: number): LoadedTranscript => ({ entries: entries.slice(omitted), omitted, first: entries[0]!, plan: false });

const shownIds = (html: string) => [...html.matchAll(/data-entry-id="([^"]+)"/g)].map((m) => m[1]);

describe("the transcript's window (P2)", () => {
  it("starts at the last page, then stays put as steps come in", () => {
    expect(transcriptStart(150, undefined, -1)).toBe(0);
    expect(transcriptStart(2000, undefined, -1)).toBe(2000 - TRANSCRIPT_PAGE);
    // Kept: a new step adds to what's shown.
    expect(transcriptStart(2001, 1800, -1)).toBe(1800);
    // A start past the end (the steps were read again, fewer) is the last page again.
    expect(transcriptStart(100, 1800, -1)).toBe(0);
  });

  it("brings in whole pages up to a focused step further back", () => {
    expect(transcriptStart(2000, 1800, 1900)).toBe(1800);
    expect(transcriptStart(2000, 1800, 1799)).toBe(1600);
    expect(transcriptStart(2000, 1800, 1600)).toBe(1600);
    expect(transcriptStart(2000, 1800, 1599)).toBe(1400);
    expect(transcriptStart(2000, 1800, 0)).toBe(0);
  });

  it("keeps a session you follow at its end to two pages, and leaves it be when you've scrolled up", () => {
    expect(followedStart(2000, 1600, true)).toBe(1600);
    expect(followedStart(2001, 1600, true)).toBe(1801);
    expect(followedStart(2001, 1600, false)).toBe(1600);
    // Watched from its start: the window was pinned at 0.
    expect(followedStart(401, 0, true)).toBe(201);
  });

  beforeEach(() => {
    useAria.setState({ transcripts: {}, offers: {}, yours: {}, transcriptFocus: null });
  });

  it("shows the brief and the last 200 steps of a long session, with a way to show more", () => {
    useAria.setState({ transcripts: { t1: all(steps(450)) } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    const ids = shownIds(html);
    expect(ids).toHaveLength(TRANSCRIPT_PAGE + 1);
    expect(ids.slice(0, 2)).toEqual(["e0", "e250"]);
    expect(ids.at(-1)).toBe("e449");
    expect(html).toContain(">Brief<");
    expect(html).toContain('data-count="249"');
    expect(html).toContain("249 earlier steps aren&#x27;t shown.");
    expect(html).toMatch(/data-testid="transcript-show-earlier"[^>]*>Show 200 more</);
    // The brief comes before the note, the rest after it.
    expect(html.indexOf('data-entry-id="e0"')).toBeLessThan(html.indexOf("transcript-earlier"));
    expect(html.indexOf("transcript-earlier")).toBeLessThan(html.indexOf('data-entry-id="e250"'));
  });

  it("shows only the brief above the note when the brief is all that's left out", () => {
    useAria.setState({ transcripts: { t1: all(steps(TRANSCRIPT_PAGE + 1)) } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    expect(shownIds(html)).toHaveLength(TRANSCRIPT_PAGE + 1);
    expect(html).not.toContain("transcript-earlier");
    useAria.setState({ transcripts: { t1: all(steps(TRANSCRIPT_PAGE + 2)) } });
    expect(renderToStaticMarkup(<Transcript task={task} />)).toContain("1 earlier step isn&#x27;t shown.");
  });

  it("shows everything, brief first, when a session is short", () => {
    useAria.setState({ transcripts: { t1: all(steps(120)) } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    expect(shownIds(html)).toHaveLength(120);
    expect(html).toContain("Brief");
    expect(html).not.toContain("transcript-earlier");
  });

  it("shows a step a jump focuses on further back, with the pages after it", () => {
    useAria.setState({ transcripts: { t1: all(steps(450)) }, transcriptFocus: { taskId: "t1", entryId: "e100", at: 1 } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    const ids = shownIds(html);
    expect(ids.slice(0, 2)).toEqual(["e0", "e50"]);
    expect(ids).toContain("e100");
    expect(ids).toHaveLength(401);
    expect(html).toContain("Show 49 more");
    // A focus on another task's step changes nothing here.
    useAria.setState({ transcriptFocus: { taskId: "t2", entryId: "e100", at: 2 } });
    expect(shownIds(renderToStaticMarkup(<Transcript task={task} />))[1]).toBe("e250");
  });

  it("brings in no pages for a jump to the brief: it's shown above them anyway", () => {
    for (const loaded of [all(steps(450)), from(steps(450), 250)]) {
      useAria.setState({ transcripts: { t1: loaded }, transcriptFocus: { taskId: "t1", entryId: "e0", at: 1 } });
      const ids = shownIds(renderToStaticMarkup(<Transcript task={task} />));
      expect(ids).toHaveLength(TRANSCRIPT_PAGE + 1);
      expect(ids.slice(0, 2)).toEqual(["e0", "e250"]);
    }
  });

  it("shows the newest page as it's loaded (P4) as it showed the whole session: the brief, then the last 200", () => {
    const session = steps(450);
    useAria.setState({ transcripts: { t1: all(session) } });
    const whole = renderToStaticMarkup(<Transcript task={task} />);
    useAria.setState({ transcripts: { t1: from(session, 250) } });
    expect(renderToStaticMarkup(<Transcript task={task} />)).toBe(whole);
  });

  it("says it's loading while the steps it would show aren't loaded yet", () => {
    // A jump to a step that is loaded, with the steps before it (on the page it starts) still to come.
    useAria.setState({ transcripts: { t1: from(steps(450), 300) }, transcriptFocus: { taskId: "t1", entryId: "e310", at: 1 } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    const ids = shownIds(html);
    expect(ids.slice(0, 2)).toEqual(["e0", "e300"]);
    expect(ids).toHaveLength(151);
    expect(html).toContain("299 earlier steps aren&#x27;t shown.");
    expect(html).toMatch(/data-testid="transcript-show-earlier"[^>]*aria-disabled="true"[^>]*>Loading…</);
  });
});

describe("what goes below each step", () => {
  const refusedTool: TranscriptEntry = { kind: "tool", id: "tool-1", at: 1, name: "powershell", success: false, error: "Refused" };
  const again: TranscriptEntry = { kind: "tool", id: "tool-2", at: 2, name: "powershell", success: false, error: "Refused" };
  const message: TranscriptEntry = { kind: "user", id: "user-1", at: 3, text: "Use cookies" };
  const offer = { id: "o1", decided: "never", toolCallId: "tool-1", command: "curl", overrides: [{ match: "curl" }] } as unknown as RuleOffer;
  const words = { id: "w1", kind: "message", text: "Use cookies" } as unknown as YourWords;

  it("gives each offer to the step it's for, and your words to your message, as the store's own objects", () => {
    const extras = stepExtras([refusedTool, again, message], [offer], [words]);
    expect(extras.get("tool-1")?.offer).toBe(offer);
    expect(extras.has("tool-2")).toBe(false);
    expect(extras.get("user-1")?.words).toBe(words);
    expect(stepExtras([refusedTool], undefined, undefined).size).toBe(0);
  });

  it("is worked out over every step, so a step outside the window keeps its offer from going to a later one", () => {
    // An offer found by its command goes with the first refused row for it: here, one that isn't shown.
    const denied = (id: string): TranscriptEntry => ({ kind: "permission", id, at: 1, detail: "Run curl https://example.com", approved: false });
    const byCommand = { id: "o2", decided: "never", command: "curl https://example.com" } as unknown as RuleOffer;
    const entries = [denied("perm-1"), ...steps(TRANSCRIPT_PAGE + 5).slice(1), denied("perm-2")];
    useAria.setState({ transcripts: { t1: all(entries) }, offers: { t1: [byCommand] } });
    const html = renderToStaticMarkup(<Transcript task={task} />);
    expect(shownIds(html)).not.toContain("perm-1");
    expect(shownIds(html)).toContain("perm-2");
    expect(html).not.toContain('data-testid="step-offer"');
    // Shown, the first one has it.
    useAria.setState({ transcripts: { t1: all([denied("perm-1"), denied("perm-2")]) } });
    expect(renderToStaticMarkup(<Transcript task={task} />).match(/data-testid="step-offer"/g)).toHaveLength(1);
  });

  it("leaves an offer from before the loaded steps for their page, rather than a later step that fits it as well", () => {
    const denied = (id: string, at: number): TranscriptEntry => ({ kind: "permission", id, at, detail: "Run curl https://example.com", approved: false });
    const byCommand = (id: string, at: number) => ({ id, at, decided: "never", command: "curl https://example.com" }) as unknown as RuleOffer;
    // perm-1 (at 10) isn't loaded; perm-2 (at 500) is, and so is its own offer.
    const loaded = [denied("perm-2", 500)];
    expect(stepExtras(loaded, [byCommand("o-early", 11)], undefined, 500).size).toBe(0);
    expect(stepExtras(loaded, [byCommand("o-early", 11), byCommand("o-own", 501)], undefined, 500).get("perm-2")?.offer?.id).toBe("o-own");
    // Everything loaded: no start to go by.
    expect(stepExtras(loaded, [byCommand("o-early", 11)], undefined).get("perm-2")?.offer?.id).toBe("o-early");
  });

  it("keeps the steps memoized: a new step doesn't draw the others again", () => {
    // The redraws themselves are counted in e2e/perf-session.spec.ts.
    for (const component of [TranscriptStep, Entry, ToolEntry]) expect((component as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
