/**
 * The task tracker in Customize › Integrations, rendered from its state: the
 * panel (the tracker in use, the configs in the trackers folder, an import's result) and the "Use as task tracker"
 * choice (the config, its tools on the server, what ARIA would call), and the pure choices behind the buttons.
 * Fictional trackers only: Acme Tracker and Orbit Desk.
 */
import type { TrackerChangePreview, TrackerImportResult, TrackerSetup, TrackerToolStatus } from "@aria/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportResult, TrackerChoice, TrackerPanel } from "../src/renderer/src/components/CustomizeTracker";
import { activeText, configsFor, errorLines, missingRequired, NO_TRACKER_TEXT, partState, purgeText, startConfig, stopChoice, choiceFor } from "../src/renderer/src/trackerSetup";

const SERVER = "Acme Cloud";
const status = (part: TrackerToolStatus["part"], over: Partial<TrackerToolStatus> = {}): TrackerToolStatus => ({ server: SERVER, part, tools: [`${part}_tool`], required: false, ...over });

const setup = (over: Partial<TrackerSetup> = {}): TrackerSetup => ({
  active: { id: "acme", label: "Acme Tracker", file: "acme.json", hash: "3f2a9c1e", servers: [SERVER], explicitServers: false },
  configs: [
    { id: "acme", label: "Acme Tracker", file: "acme.json", hash: "3f2a9c1e", suggestedServers: [SERVER] },
    { id: "orbit", label: "Orbit Desk", file: "orbit.json", hash: "9b1d0c77", suggestedServers: ["Orbit Desk"] },
    { id: "broken", file: "broken.json", error: "the file isn't valid JSON: Unexpected token\nline two", suggestedServers: [] },
  ],
  tools: [],
  ...over,
});

const panel = (state: TrackerSetup | undefined, extra: { importing?: boolean; result?: TrackerImportResult } = {}) =>
  renderToStaticMarkup(<TrackerPanel setup={state} importing={extra.importing ?? false} result={extra.result} onImport={() => undefined} onOpenFolder={() => undefined} />);

describe("the Task tracker panel", () => {
  it("names the tracker in use, its servers, its file and hash, and lists the configs", () => {
    const html = panel(setup());
    expect(html).toContain('data-testid="tracker-active" data-tracker="acme">Acme Tracker, through Acme Cloud — acme.json (3f2a9c1e)<');
    expect(html).toContain('data-file="acme.json"');
    expect(html).toContain("Orbit Desk");
    expect(html).toContain("orbit.json (9b1d0c77)");
    // The one in use says so; the others don't.
    expect(html.match(/>In use</g)).toHaveLength(1);
    expect(html).toContain("</svg> Import config…</button>");
    expect(html).toContain("</svg> Open folder</button>");
    expect(html).not.toContain("data-testid=\"tracker-error\"");
  });

  it("shows a file that doesn't load with the first lines of what is wrong", () => {
    const html = panel(setup());
    expect(html).toContain("broken.json can&#x27;t be used:");
    expect(html).toContain("the file isn&#x27;t valid JSON: Unexpected token");
    expect(html).toContain("line two");
  });

  it("says when the config the setting names isn't the one in use", () => {
    const html = panel(setup({ error: "The task tracker config acme.json couldn't be loaded: tasks.myTasks: is missing." }));
    expect(html).toContain('data-testid="tracker-error"');
    expect(html).toContain("tasks.myTasks: is missing.");
  });

  it("says there is none, and what to do", () => {
    const html = panel(setup({ active: undefined }));
    expect(html).toContain(NO_TRACKER_TEXT);
    expect(html).toContain('data-tracker=""');
    expect(html).not.toContain(">In use<");
  });

  it("says when the folder has no config yet", () => {
    expect(panel(setup({ configs: [] }))).toContain('data-testid="tracker-no-configs"');
    // Before the state says, the panel doesn't claim there is none.
    expect(panel(undefined)).toContain("Task tracker");
    expect(panel(undefined)).not.toContain(NO_TRACKER_TEXT);
  });

  it("shows the import button busy", () => {
    const html = panel(setup(), { importing: true });
    expect(html).toMatch(/data-testid="tracker-import"[^>]*disabled=""/);
    expect(html).toContain("</svg> Importing…</button>");
  });
});

describe("what an import left", () => {
  const imported: TrackerImportResult = {
    status: "imported",
    id: "orbit",
    label: "Orbit Desk",
    file: "orbit.json",
    hash: "9b1d0c77",
    replaced: false,
    reads: ["list_orbit_hours", "get_orbit_desk"],
    reserved: ["file_orbit_hours", "amend_orbit_hours"],
  };
  const render = (result: TrackerImportResult) => renderToStaticMarkup(<ImportResult result={result} />);

  it("says what was imported, the reads ARIA makes without asking, the reserved writes, and that a config is trusted like a plugin", () => {
    const html = render(imported);
    expect(html).toContain("Imported Orbit Desk as");
    expect(html).toContain("orbit.json");
    expect(html).toContain("(9b1d0c77)");
    expect(html).toContain("list_orbit_hours, get_orbit_desk");
    expect(html).toContain("file_orbit_hours, amend_orbit_hours");
    expect(html).toContain("trusted like a plugin");
    expect(html).not.toContain("in place of the file");
  });

  it("says it took the place of a file, and what the engine added", () => {
    const html = render({ ...imported, replaced: true, note: "orbit.json had changed, so the new version is in use." });
    expect(html).toContain("in place of the file that was there");
    expect(html).toContain("so the new version is in use.");
  });

  it("names what is wrong with a file that isn't a config, or couldn't be read", () => {
    const bad = render({ status: "invalid", errors: ["id: has characters that aren't allowed", "label: is missing"] });
    expect(bad).toContain('data-status="invalid"');
    expect(bad).toContain("label: is missing");
    expect(render({ status: "failed", error: "ARIA couldn't read that file." })).toContain("ARIA couldn&#x27;t read that file.");
    expect(renderToStaticMarkup(<ImportResult result={{ status: "canceled" }} />)).toBe("");
  });
});

describe("the Use as task tracker choice", () => {
  const preview = (over: Partial<TrackerChangePreview> = {}): TrackerChangePreview => ({
    label: "Acme Tracker",
    tools: [
      status("myWork", { tools: ["list_my_issues"], found: "list_my_issues", required: true }),
      status("taskDetails", { tools: ["get_issues"], found: "get_issues" }),
      status("submit", { tools: ["add_worklogs"], required: true }),
      status("delete", { tools: ["delete_worklogs"], found: "delete_worklogs_raw", required: true, directOnly: true }),
      status("test", { tools: ["get_current_user"] }),
      // Another server's parts aren't this card's.
      { server: "Orbit Desk", part: "myWork", tools: ["list_orbit_hours"], found: "list_orbit_hours", required: true },
    ],
    reads: ["list_my_issues", "get_issues"],
    reserved: ["add_worklogs", "delete_worklogs"],
    ...over,
  });
  const render = (extra: Partial<Parameters<typeof TrackerChoice>[0]> = {}) =>
    renderToStaticMarkup(
      <TrackerChoice
        server={SERVER}
        setup={setup()}
        configId="acme"
        preview={preview()}
        checking={false}
        error={null}
        using={false}
        onConfig={() => undefined}
        onUse={() => undefined}
        onCancel={() => undefined}
        {...extra}
      />,
    );

  it("lists the configs that load, the ones that suit the server first, and the tools it has and lacks", () => {
    const html = render();
    expect(html).toContain("Use Acme Cloud as task tracker");
    expect(html).toContain("Acme Tracker — acme.json (3f2a9c1e) — suggested");
    expect(html).toContain("Orbit Desk — orbit.json (9b1d0c77)</option>");
    expect(html).not.toContain("broken.json");
    expect(html.indexOf("Acme Tracker — acme.json")).toBeLessThan(html.indexOf("Orbit Desk — orbit.json"));
    expect(html).toMatch(/data-part="myWork" data-state="found"/);
    expect(html).toMatch(/data-part="submit" data-state="missing"/);
    expect(html).toMatch(/data-part="delete" data-state="direct-only"/);
    expect(html).toMatch(/data-part="test" data-state="missing"/);
    expect(html).toContain("add_worklogs</span> isn&#x27;t on this server (needed)");
    expect(html).toContain("get_current_user</span> isn&#x27;t on this server (optional)");
    expect(html).toContain("reachable only with direct access");
    // Only this server's parts.
    expect(html).not.toContain("list_orbit_hours");
  });

  it("warns, without blocking, about a required part the server lacks, and says what ARIA would call and reserve", () => {
    const html = render();
    expect(html).toContain("Acme Cloud doesn&#x27;t have the tools for Submit, so they won&#x27;t work. You can still use it.");
    expect(html).toContain("ARIA reads with these tools without asking: <span class=\"font-mono\">list_my_issues, get_issues</span>");
    expect(html).toContain("These writes are reserved for the Time view: <span class=\"font-mono\">add_worklogs, delete_worklogs</span>");
    expect(html).not.toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""/);
  });

  it("shows a refusal and leaves Use off", () => {
    const html = render({ preview: { refusal: "Wait until the timesheet is done.", tools: [], reads: [], reserved: [] } });
    expect(html).toContain("Wait until the timesheet is done.");
    expect(html).not.toContain("data-testid=\"tracker-dialog-parts\"");
    expect(html).toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""/);
  });

  it("leaves Use off while it checks and while it uses it, and shows an error", () => {
    expect(render({ preview: undefined, checking: true })).toContain("Checking its tools on Acme Cloud…");
    expect(render({ preview: undefined, checking: true })).toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""/);
    expect(render({ using: true })).toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""[^>]*>Using…/);
    expect(render({ error: "ARIA is still starting." })).toContain("ARIA is still starting.");
  });

  it("says there is no config to pick when none loads", () => {
    const html = render({ setup: setup({ configs: [{ id: "broken", file: "broken.json", error: "the file isn't valid JSON", suggestedServers: [] }] }), configId: undefined, preview: undefined });
    expect(html).toContain('data-testid="tracker-dialog-no-configs"');
    expect(html).not.toContain("<select");
    expect(html).toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""/);
  });
});

describe("the choices behind the buttons", () => {
  it("says the tracker in use in words", () => {
    expect(activeText(setup().active)).toBe("Acme Tracker, through Acme Cloud — acme.json (3f2a9c1e)");
    expect(activeText({ id: "acme", label: "Acme Tracker", builtIn: true, servers: ["Acme Cloud", "Acme Mirror"], explicitServers: true })).toBe("Acme Tracker, through Acme Cloud and Acme Mirror — built in");
    expect(activeText({ id: "acme", label: "Acme Tracker", file: "acme.json", hash: "3f2a9c1e", servers: [], explicitServers: false })).toBe("Acme Tracker, with no server of yours yet (use one below) — acme.json (3f2a9c1e)");
    expect(activeText(undefined)).toBe(NO_TRACKER_TEXT);
  });

  it("cuts an error to its first lines", () => {
    expect(errorLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(errorLines("1\n2\n3\n4\n5\n6")).toEqual(["1", "2", "3", "4", "… and 2 more"]);
  });

  it("tells found, direct only and missing, and which required parts are missing", () => {
    expect(partState({ found: "a" })).toBe("found");
    expect(partState({ found: "a", directOnly: true })).toBe("direct-only");
    expect(partState({})).toBe("missing");
    expect(missingRequired([status("myWork", { required: true, found: "x" }), status("submit", { required: true }), status("delete", { required: true }), status("test")])).toEqual(["Submit", "Delete"]);
  });

  it("offers the configs that load, those whose names suit the server first, and starts on the one in use unless another suits the server", () => {
    expect(configsFor(setup().configs, "Orbit Desk").map((c) => c.id)).toEqual(["orbit", "acme"]);
    expect(configsFor(setup().configs, SERVER).map((c) => c.id)).toEqual(["acme", "orbit"]);
    // The config in use suits this server, or nothing else does (a second server of the same tracker): it.
    expect(startConfig(setup(), SERVER)).toBe("acme");
    expect(startConfig(setup(), "Other Server")).toBe("acme");
    // Another config suits this server and the one in use doesn't: that one.
    expect(startConfig(setup(), "Orbit Desk")).toBe("orbit");
    expect(startConfig(setup({ active: undefined }), "Orbit Desk")).toBe("orbit");
    expect(startConfig(setup({ configs: [] }), SERVER)).toBeUndefined();
  });

  it("names the servers of a choice: those of the same config in use, then this one, the first chosen preferred", () => {
    expect(choiceFor(setup(), "acme", "Acme Mirror")).toEqual({ config: "acme", servers: [SERVER, "Acme Mirror"] });
    expect(choiceFor(setup(), "orbit", "Orbit Desk")).toEqual({ config: "orbit", servers: ["Orbit Desk"] });
    expect(choiceFor(setup({ active: undefined }), "acme", SERVER)).toEqual({ config: "acme", servers: [SERVER] });
    // The built-in tracker's servers aren't a config's.
    expect(choiceFor(setup({ active: { id: "acme", label: "Acme Tracker", builtIn: true, servers: ["Elsewhere"], explicitServers: false } }), "acme", SERVER)).toEqual({ config: "acme", servers: [SERVER] });
  });

  it("makes Stop using the tracker without that server, or no tracker when it was the last", () => {
    const two = setup({ active: { id: "acme", label: "Acme Tracker", file: "acme.json", hash: "3f2a9c1e", servers: [SERVER, "Acme Mirror"], explicitServers: true } });
    expect(stopChoice(two, SERVER)).toEqual({ config: "acme", servers: ["Acme Mirror"] });
    expect(stopChoice(setup(), SERVER)).toEqual({ config: null });
    expect(stopChoice(setup({ active: undefined }), SERVER)).toEqual({ config: null });
    const builtIn = setup({ active: { id: "acme", label: "Acme Tracker", builtIn: true, servers: [SERVER, "Acme Mirror"], explicitServers: false } });
    expect(stopChoice(builtIn, SERVER)).toEqual({ servers: ["Acme Mirror"] });
  });
});

describe("the question about another tracker's data", () => {
  const purge = (counts: Partial<NonNullable<TrackerChangePreview["purge"]>["counts"]> = {}): NonNullable<TrackerChangePreview["purge"]> => ({
    from: "orbit",
    fromLabel: "Orbit Desk",
    counts: { cachedTasks: 42, rules: 6, draftRowsWithTasks: 3, registeredRows: 2, linkedActivities: 0, ...counts },
  });
  const render = (preview: TrackerChangePreview, extra: Partial<Parameters<typeof TrackerChoice>[0]> = {}) =>
    renderToStaticMarkup(
      <TrackerChoice
        server={SERVER}
        setup={setup()}
        configId="acme"
        preview={preview}
        checking={false}
        error={null}
        using={false}
        onConfig={() => undefined}
        onUse={() => undefined}
        onCancel={() => undefined}
        {...extra}
      />,
    );
  const base: TrackerChangePreview = { label: "Acme Tracker", tools: [], reads: [], reserved: [] };

  it("says what there is, whose it is, what keeping and clearing mean, and that registered entries stay as history", () => {
    expect(purgeText(purge())).toBe(
      "ARIA has 42 cached tasks, 6 rules and 3 draft rows with tasks from Orbit Desk. Keep them (used again if you switch back) or clear them? Registered entries stay as history either way.",
    );
    expect(purgeText(purge({ cachedTasks: 1, rules: 0, draftRowsWithTasks: 0, linkedActivities: 2 }))).toBe(
      "ARIA has 1 cached task and 2 activities linked to tasks from Orbit Desk. Keep them (used again if you switch back) or clear them? Registered entries stay as history either way.",
    );
    expect(purgeText(purge({ cachedTasks: 1, rules: 0, draftRowsWithTasks: 0 }))).toContain("ARIA has 1 cached task from Orbit Desk.");
    expect(purgeText(purge({ cachedTasks: 0, rules: 1, draftRowsWithTasks: 0 }))).toContain("ARIA has 1 rule from Orbit Desk.");
  });

  it("is in the dialog only when the preview asks, with keep chosen unless clear is", () => {
    const without = render(base);
    expect(without).not.toContain("tracker-dialog-purge");
    const kept = render({ ...base, purge: purge() });
    expect(kept).toContain('data-testid="tracker-dialog-purge"');
    expect(kept).toContain("ARIA has 42 cached tasks, 6 rules and 3 draft rows with tasks from Orbit Desk.");
    expect(kept).toMatch(/data-testid="tracker-dialog-purge-keep"[^>]*checked=""/);
    expect(kept).not.toMatch(/data-testid="tracker-dialog-purge-clear"[^>]*checked=""/);
    expect(kept).toContain("Clear them (ARIA copies its database first, and doesn&#x27;t clear anything if it can&#x27;t)");
    const cleared = render({ ...base, purge: purge() }, { purge: "clear" });
    expect(cleared).toMatch(/data-testid="tracker-dialog-purge-clear"[^>]*checked=""/);
    expect(cleared).not.toMatch(/data-testid="tracker-dialog-purge-keep"[^>]*checked=""/);
    // Use stays possible: the question has a default answer.
    expect(kept).not.toMatch(/data-testid="tracker-dialog-use"[^>]*disabled=""/);
  });

  it("isn't asked with a refusal in its place", () => {
    const html = render({ ...base, refusal: "Wait until the timesheet is done.", purge: purge() });
    expect(html).toContain("Wait until the timesheet is done.");
    expect(html).not.toContain("tracker-dialog-purge");
  });
});
