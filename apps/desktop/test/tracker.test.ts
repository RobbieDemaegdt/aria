import type { TrackerInfo } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import {
  askAboutTaskPattern,
  askAboutTaskPrefill,
  askAboutTaskPrefix,
  deleteCall,
  prefilledText,
  trackerLabel,
  trackerRef,
  trackerServerHint,
  trackerTaskLink,
  trackerTaskRefPlaceholder,
  viaCreateTool,
} from "../src/renderer/src/tracker";

// A fictional tracker whose label has regex characters, so the prefill pattern must escape it.
const ACME: TrackerInfo = {
  id: "acme",
  label: "Acme (beta)",
  taskUrlTemplate: "https://acme.example/tasks/{id}?view={id}",
  taskRefPlaceholder: "Acme task ID",
  capabilities: { timeLogs: false, projects: false },
};

describe("the task tracker in the window", () => {
  it("names and links tasks with the tracker's label and URL template", () => {
    expect(trackerLabel(ACME)).toBe("Acme (beta)");
    expect(trackerRef(ACME, "42")).toBe("Acme (beta) #42");
    expect(trackerTaskLink(ACME, " 4 2 ")).toBe("https://acme.example/tasks/4%202?view=4%202");
    expect(trackerTaskRefPlaceholder(ACME)).toBe("Acme task ID");
  });

  it("paints neutral words and no link before the state arrives (Q10)", () => {
    expect(trackerLabel(undefined)).toBe("Tracker");
    expect(trackerRef(undefined, "42")).toBe("Task #42");
    expect(trackerTaskLink(undefined, "42")).toBeUndefined();
    expect(trackerTaskRefPlaceholder(undefined)).toBe("Task ID");
    expect(askAboutTaskPrefill(undefined, "42", "Fix it")).toBe('About task #42 ("Fix it"): ');
  });

  it("builds the ask-about-a-task prefill, and a pattern from the escaped label that finds an earlier one", () => {
    const prefill = askAboutTaskPrefill(ACME, "42", "Fix it");
    expect(prefill).toBe('About Acme (beta) task #42 ("Fix it"): ');
    expect(prefill.startsWith(askAboutTaskPrefix(ACME))).toBe(true);
    const typed = 'About Acme (beta) task #7 ("Old (one)"): and also this';
    expect(prefilledText(ACME, typed, prefill)).toBe('About Acme (beta) task #42 ("Fix it"): and also this');
    // Another tracker's prefill, or plain text, isn't matched: the prefill goes in front.
    expect(askAboutTaskPattern(ACME).test('About Other task #7 ("x"): ')).toBe(false);
    expect(askAboutTaskPattern(ACME).test("About Acme beta task #7 (x): ")).toBe(false);
    expect(prefilledText(ACME, "and also this", prefill)).toBe(`${prefill}and also this`);
    expect(prefilledText(ACME, `${prefill}and also this`, prefill)).toBe(`${prefill}and also this`);
  });

  it("finds an earlier prefill of a task whose ID isn't a number, and gives for numeric IDs what the pattern always gave", () => {
    // What the pattern was before it came from a config: the task's ID was digits only.
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = (tracker: TrackerInfo | undefined) => new RegExp(`^${escape(askAboutTaskPrefix(tracker))}\\d+\\s*\\([\\s\\S]*?\\):\\s*`);
    const titles = ["Fix it", "Costs $& and (parts)", 'He said "no": (really)', "Multi\nline", "", "a):b"];
    const tails = ["", "and also this", "\nsecond line", " (more): x"];
    let found = 0;
    for (const tracker of [ACME, undefined]) {
      for (const id of ["42", "100123", "0042", "1234567890123"]) {
        for (const title of titles) {
          const prefill = askAboutTaskPrefill(tracker, id, title);
          for (const tail of tails) {
            for (const text of [prefill + tail, `${prefill.slice(0, -1)}${tail}`, `x${prefill}${tail}`, `${askAboutTaskPrefix(tracker)}${id}${tail}`, `${askAboutTaskPrefix(tracker)}${id} ("${title}")${tail}`]) {
              expect(askAboutTaskPattern(tracker).test(text), JSON.stringify(text)).toBe(before(tracker).test(text));
              expect(text.replace(askAboutTaskPattern(tracker), () => "X"), JSON.stringify(text)).toBe(text.replace(before(tracker), () => "X"));
              if (before(tracker).test(text)) found++;
            }
          }
        }
      }
    }
    expect(found).toBeGreaterThan(100);

    // An ID with letters or hyphens is found too, and replaced by the new prefill.
    const prefill = askAboutTaskPrefill(ACME, "ACME-42", "Fix it");
    expect(prefill).toBe('About Acme (beta) task #ACME-42 ("Fix it"): ');
    expect(askAboutTaskPattern(ACME).test(prefill)).toBe(true);
    expect(prefilledText(ACME, 'About Acme (beta) task #ACME-7 ("Old one"): and also this', prefill)).toBe(`${prefill}and also this`);
    expect(prefilledText(ACME, 'About Acme (beta) task #7 ("Old one"): and also this', prefill)).toBe(`${prefill}and also this`);
    // ...but not a prefill with no ID, or text that merely mentions one.
    expect(askAboutTaskPattern(ACME).test('About Acme (beta) task # ("x"): ')).toBe(false);
    expect(askAboutTaskPattern(ACME).test('Please look at About Acme (beta) task #ACME-7 ("x"): ')).toBe(false);
  });

  it("puts IDs and titles with `$` patterns in as they are", () => {
    // `$&` is the matched text, `$'` what follows it, `` $` `` what precedes it, `$$` a single `$`, in a replacement string.
    const odd = "1$&2$'3$`4$$5";
    const withTools: TrackerInfo = { ...ACME, timeLogTools: { create: "add_worklogs", delete: "remove_worklogs", deleteArgs: 'ids: ["{id}"], confirmed: true' } };
    expect(deleteCall(withTools, odd)).toEqual({ tool: "remove_worklogs", args: `ids: ["${odd}"], confirmed: true` });
    const encoded = encodeURIComponent(odd);
    expect(trackerTaskLink(ACME, odd)).toBe(`https://acme.example/tasks/${encoded}?view=${encoded}`);
    const prefill = askAboutTaskPrefill(ACME, "42", `Costs ${odd}`);
    expect(prefilledText(ACME, 'About Acme (beta) task #7 ("Old"): and also this', prefill)).toBe(`About Acme (beta) task #42 ("Costs ${odd}"): and also this`);
  });

  it("names the tracker's server and time-log tools as core gives them, and says less when it gives none", () => {
    const withTools: TrackerInfo = {
      ...ACME,
      serverHint: "Acme Cloud",
      timeLogTools: { create: "add_worklogs", delete: "remove_worklogs", deleteArgs: 'ids: ["{id}"], confirmed: true' },
    };
    expect(trackerServerHint(withTools)).toBe("Acme Cloud");
    expect(viaCreateTool(withTools)).toBe(" via add_worklogs");
    expect(deleteCall(withTools, "7000001")).toEqual({ tool: "remove_worklogs", args: 'ids: ["7000001"], confirmed: true' });

    expect(trackerServerHint(ACME)).toBe("Acme (beta)");
    expect(viaCreateTool(ACME)).toBe("");
    expect(deleteCall(ACME, "7000001")).toBeUndefined();
    expect(trackerServerHint(undefined)).toBe("Tracker");
    expect(viaCreateTool(undefined)).toBe("");
    expect(deleteCall(undefined, "7000001")).toBeUndefined();
  });
});
