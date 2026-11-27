import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { matchProfile, mentions, Profiles } from "../src/tasks/profiles.ts";
import { Store } from "../src/store/store.ts";

function setup() {
  const db = new Store(":memory:");
  const runtime = new FakeRuntime();
  const profiles = new Profiles({ db: () => db, models: () => runtime.models });
  return { db, runtime, profiles };
}

describe("Profiles", () => {
  it("seeds Default, Quick, Deep and CI fix from the catalog once, with budgets that fit each model", () => {
    const { profiles } = setup();
    expect(profiles.seedIfEmpty()).toBe(true);
    expect(profiles.seedIfEmpty()).toBe(false);
    const list = profiles.list();
    expect(list.map((p) => [p.name, p.model, p.reasoningEffort, p.mode, p.isDefault])).toEqual([
      ["Default", "fake-light", "medium", "autopilot", true],
      ["Quick", "fake-light", "low", "autopilot", false],
      ["Deep", "fake-strong", "high", "autopilot", false],
      ["CI fix", "fake-light", "medium", "autopilot", false],
    ]);
    expect(list.find((p) => p.name === "Quick")!.budgetCredits).toBe(20);
    expect(list.find((p) => p.name === "Deep")!.budgetCredits).toBe(800);
    // D47: a new install's Fix it uses the CI fix profile.
    expect(profiles.ciFix()?.name).toBe("CI fix");
  });

  it("Fix it uses (D47): your pick, or Default when there's none (an existing install) or it was deleted", () => {
    const { profiles, db } = setup();
    profiles.seedIfEmpty();
    // As an install from before item 4: no setting.
    db.setSetting("profiles.ciFixId", null);
    expect(profiles.ciFixId()).toBeUndefined();
    expect(profiles.ciFix()?.name).toBe("Default");
    const deep = profiles.byName("Deep")!;
    profiles.setCiFix(deep.id);
    expect(profiles.ciFix()?.name).toBe("Deep");
    expect(() => profiles.setCiFix("gone")).toThrow(/doesn't exist/);
    profiles.setCiFix(null);
    expect(profiles.ciFix()?.name).toBe("Default");
  });

  it("checks models and efforts against the catalog, and keeps names unique in any letter case", () => {
    const { profiles } = setup();
    profiles.seedIfEmpty();
    expect(() => profiles.save({ name: "Off", model: "fake-off", mode: "autopilot" })).toThrow(/isn't an available model/);
    expect(() => profiles.save({ name: "Bad effort", model: "fake-light", reasoningEffort: "xhigh", mode: "autopilot" })).toThrow(/supports these effort levels/);
    expect(() => profiles.save({ name: "quick", model: "fake-light", reasoningEffort: "low", mode: "interactive" })).toThrow(/already a profile called quick/);
    expect(() => profiles.save({ name: "ci FIX", model: "fake-light", reasoningEffort: "low", mode: "interactive" })).toThrow(/already a profile called ci FIX/);
    const ci = profiles.save({ name: "Nightly", model: "fake-strong", reasoningEffort: "medium", mode: "autopilot", instructions: " Run the failing job's command first. ", budgetCredits: 50 });
    expect(ci).toMatchObject({ name: "Nightly", instructions: "Run the failing job's command first.", budgetCredits: 50, isDefault: false });
    const renamed = profiles.save({ id: ci.id, name: "CI", model: "fake-strong", reasoningEffort: "low", mode: "interactive", budgetCredits: null });
    expect(renamed).toMatchObject({ id: ci.id, name: "CI", mode: "interactive" });
    expect(renamed.budgetCredits).toBeUndefined();
  });

  it("moves the default when the default profile is deleted, and keeps at least one", () => {
    const { profiles } = setup();
    profiles.seedIfEmpty();
    const [first, second, third, fourth] = profiles.list();
    profiles.setDefault(third!.id);
    expect(profiles.default()!.name).toBe("Deep");
    profiles.delete(third!.id);
    expect(profiles.default()!.id).toBe(first!.id);
    profiles.delete(second!.id);
    // The CI fix profile deleted: Fix it falls back to the default (D47).
    profiles.delete(fourth!.id);
    expect(profiles.ciFix()!.id).toBe(first!.id);
    expect(() => profiles.delete(first!.id)).toThrow(/at least one/);
  });

  it("enforces the profile policy for tasks ARIA starts", () => {
    const { profiles } = setup();
    profiles.seedIfEmpty();
    // "me": only what you named in your message
    expect(profiles.forTask({ requested: "Deep", startedBy: "aria", lastUserMessage: "add dark mode to Moonrise" })).toMatchObject({
      profile: { name: "Default" },
      note: expect.stringMatching(/didn't name a profile/),
    });
    expect(profiles.forTask({ requested: "Deep", startedBy: "aria", lastUserMessage: "use deep for this one" })).toMatchObject({ profile: { name: "Deep" }, note: "You asked for Deep." });
    expect(profiles.forTask({ requested: "Deep", startedBy: "aria", lastUserMessage: "go deeper" }).profile.name).toBe("Default");
    expect(profiles.forTask({ startedBy: "aria" }).profile.name).toBe("Default");
    // tasks you start yourself use your pick
    expect(profiles.forTask({ requested: "Quick", startedBy: "you" }).profile.name).toBe("Quick");
    // "aria": any of your profiles, with a reason
    profiles.setPolicy("aria");
    expect(profiles.forTask({ requested: "deep", startedBy: "aria", reason: "A refactor across many files." })).toMatchObject({ profile: { name: "Deep" }, note: "A refactor across many files." });
    expect(() => profiles.forTask({ requested: "Turbo", startedBy: "aria" })).toThrow(/no profile called Turbo.*Default, Quick, Deep/);
  });
});

describe("mentions", () => {
  it.each([
    ["Use Deep for this", "Deep", true],
    ["use DEEP.", "Deep", true],
    ["go deeper", "Deep", false],
    ["with the CI fix profile", "CI fix", true],
    ["Quickly add it", "Quick", false],
  ])("%s / %s → %s", (text, name, expected) => {
    expect(mentions(text, name)).toBe(expected);
  });
});

describe("smart profile matching", () => {
  it.each([
    // Typos and normalized names
    ["use deeep for this refactor", "Deep"],
    ["deeep: refactor the auth module", "Deep"],
    ["run with depp profile", "Deep"],
    ["use depe for this", "Deep"],
    ["do a quik fix on the readme", "Quick"],
    ["use quikc profile", "Quick"],
    ["with qiuck", "Quick"],
    ["run with cifix", "CI fix"],
    ["use ci-fix on this branch", "CI fix"],
    ["profile: ci_fix", "CI fix"],
    // Semantic intent & aliases
    ["use fast profile to rename the variable", "Quick"],
    ["do this fast", "Quick"],
    ["with a lightweight model", "Quick"],
    ["use low effort for this", "Quick"],
    ["with deep reasoning, audit the parser", "Deep"],
    ["use high reasoning on this task", "Deep"],
    ["do a thorough investigation of the memory leak", "Deep"],
    ["use the bugfix profile", "CI fix"],
    ["fix the failing ci on main", "CI fix"],
    // Prefix and suffix syntax
    ["profile: deep — refactor the store", "Deep"],
    ["[Quick] update the changelog", "Quick"],
    ["investigate the race condition (deep)", "Deep"],
    ["rename the helper — use quick", "Quick"],
    ["fix the lint error /quick", "Quick"],
    // Model mentions (catalog & well-known model families)
    ["use fake-strong for this", "Deep"],
    ["run with Fake Strong", "Deep"],
    ["use sonnet for this task", "Deep"],
    ["with claude opus", "Deep"],
    ["use claude for this", "Deep"],
    ["use haiku for this small tweak", "Quick"],
  ])("matches %s → %s", (prompt, expectedName) => {
    const { profiles } = setup();
    profiles.seedIfEmpty();
    expect(profiles.match(prompt)?.name).toBe(expectedName);
    expect(profiles.forTask({ startedBy: "aria", lastUserMessage: prompt })).toMatchObject({
      profile: { name: expectedName },
      note: `You asked for ${expectedName}.`,
    });
    expect(profiles.forTask({ requested: expectedName, startedBy: "aria", lastUserMessage: prompt })).toMatchObject({
      profile: { name: expectedName },
      note: `You asked for ${expectedName}.`,
    });
  });

  it("matches custom profiles by model family in the catalog and by typo", () => {
    const { profiles, runtime } = setup();
    runtime.models.push({
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      category: "versatile",
      priceCategory: "medium",
      inputPrice: 100,
      outputPrice: 500,
      efforts: ["low", "medium", "high"],
      enabled: true,
    });
    profiles.seedIfEmpty();
    profiles.save({ name: "Nightly", model: "claude-sonnet-4.6", reasoningEffort: "high", mode: "autopilot" });

    expect(profiles.forTask({ startedBy: "aria", lastUserMessage: "run this with sonnet" })).toMatchObject({
      profile: { name: "Nightly" },
      note: "You asked for Nightly.",
    });
    expect(profiles.forTask({ startedBy: "aria", lastUserMessage: "use claude-sonnet-4.6" })).toMatchObject({
      profile: { name: "Nightly" },
      note: "You asked for Nightly.",
    });
    expect(profiles.forTask({ startedBy: "aria", lastUserMessage: "use nighlty for this" })).toMatchObject({
      profile: { name: "Nightly" },
      note: "You asked for Nightly.",
    });
  });

  it.each([
    "go deeper",
    "Quickly add it",
    "add dark mode to Moonrise",
    "fix the contrast in light mode",
    "keep the existing layout and don't break it",
    "does this quirk happen on Windows?",
    "use Quick or Deep for this",
    "fast and thorough check",
  ])("falls back to Default for non-matching or ambiguous prompt: %s", (prompt) => {
    const { profiles, runtime } = setup();
    profiles.seedIfEmpty();
    expect(matchProfile(prompt, profiles.list(), runtime.models)).toBeUndefined();
    expect(profiles.forTask({ startedBy: "aria", lastUserMessage: prompt }).profile.name).toBe("Default");
    expect(profiles.forTask({ requested: "Deep", startedBy: "aria", lastUserMessage: prompt }).profile.name).toBe("Default");
  });
});
