/**
 * What the model reads, and what leaves the machine, says the app's name: the five system prompts, the worker brief, the PR body and
 * the default push title all say ARIA, and none holds the old name. The old name is spelled from two pieces so this file never holds it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatPhonePushPayload } from "../src/attention/phone.ts";
import { DEFAULT_BRIEF_TEMPLATE, DEFAULT_CONDUCTOR_PROMPT, PROMPT_SPECS } from "../src/prompts/templates.ts";
import { prBody } from "../src/tasks/pr.ts";
import "./no-network.ts";

const OLD = new RegExp(["jar", "vis"].join(""), "i");
const src = (...p: string[]) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", ...p), "utf8");

describe("the app's name in the prompts and in what leaves the machine", () => {
  it("the conductor's system prompt and the worker brief say ARIA, and only ARIA", () => {
    expect(DEFAULT_CONDUCTOR_PROMPT.startsWith("You are ARIA, a personal engineering assistant")).toBe(true);
    expect(DEFAULT_CONDUCTOR_PROMPT).not.toMatch(OLD);
    expect(DEFAULT_BRIEF_TEMPLATE).not.toMatch(OLD);
    expect(PROMPT_SPECS.conductor.label).toBe("ARIA (system prompt)");
  });

  it("the utility summarizer, the Timekeeper (both prompts) and the email triage classifier say ARIA", () => {
    const scheduler = src("scheduler", "scheduler.ts");
    const timekeeper = src("timekeeper", "session.ts");
    const outlook = src("watchers", "outlook.ts");
    expect(scheduler).toContain("You are ARIA's utility summarizer.");
    expect(timekeeper.match(/You are ARIA's Timekeeper\./g)).toHaveLength(2);
    expect(outlook).toContain("You are ARIA's email triage classifier.");
    for (const text of [scheduler, timekeeper, outlook]) expect(text).not.toMatch(OLD);
  });

  it("the PR body says ARIA opened it", () => {
    const body = prBody("Fix the login", "Done.", { commits: 1, filesChanged: 2, additions: 3, deletions: 4 });
    expect(body.startsWith("Opened by ARIA from a task: 1 commit, 2 files, +3 −4.")).toBe(true);
    expect(body).not.toMatch(OLD);
  });

  it("the default push title is ARIA", () => {
    const payload = formatPhonePushPayload({ kind: "failed", title: "", body: "" } as never, "blocking");
    expect(payload.title).toBe("ARIA");
    expect(`${payload.title} ${payload.body}`).not.toMatch(OLD);
  });
});
