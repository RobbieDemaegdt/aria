import type { IntegrationServer, IntegrationTool, Task, TrackerInfo } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { canSignIn, effectLabel, filterTools, noteShown, orderedServers, runningTasks, serverReaches, sourceLabel, statusLabel, workDataWarning, yourRules } from "../src/renderer/src/integrations";

const ACME: TrackerInfo = { id: "acme", label: "Acme", taskUrlTemplate: "https://acme.example/tasks/{id}", taskRefPlaceholder: "Acme task ID", capabilities: { timeLogs: true, projects: true } };
const server = (over: Partial<IntegrationServer>): IntegrationServer => ({ name: "S", status: "connected", seen: true, lastSeen: 1, toolCount: 0, github: false, ...over });
const tool = (over: Partial<IntegrationTool>): IntegrationTool => ({
  server: "Work IQ Mail",
  tool: "SearchMessages",
  wireName: "Work-IQ-Mail-SearchMessages",
  cls: "read",
  github: false,
  seen: true,
  lastSeen: 1,
  rules: { aria: { effect: "auto", isDefault: true, allowed: ["auto", "ask", "never"] }, tasks: { effect: "never", isDefault: true, allowed: ["auto", "ask", "never"] } },
  ...over,
});

describe("Customize › Integrations in words", () => {
  it("says where a server comes from and how it is, and when it can be signed in to", () => {
    expect(sourceLabel({ source: "plugin", sourcePlugin: "workiq" })).toBe("Plugin workiq");
    expect(sourceLabel({ source: "user" })).toBe("Copilot CLI config");
    expect(sourceLabel({ source: "aria" })).toBe("ARIA config");
    expect(statusLabel({ status: "needs-auth" })).toBe("Needs sign-in");
    expect(statusLabel({ status: "disabled", configuredInAria: true })).toBe("Disabled in ARIA");
    expect(statusLabel({ status: "failed", error: "401" })).toBe("Failed: 401");
    expect(canSignIn(server({ status: "needs-auth" }))).toBe(true);
    expect(canSignIn(server({ status: "needs-auth", seen: false }))).toBe(false);
    expect(canSignIn(server({ status: "connected" }))).toBe(false);
    expect(orderedServers([server({ name: "b" }), server({ name: "gone", seen: false }), server({ name: "a" })]).map((s) => s.name)).toEqual(["a", "b", "gone"]);
  });

  it("names what Ask means for ARIA and for tasks", () => {
    expect(effectLabel("ask", "aria", "read")).toMatch(/action card/);
    expect(effectLabel("ask", "tasks", "write")).toBe("Asks you every time");
    expect(effectLabel("auto", "tasks", "read")).toBe("Runs on its own");
  });

  it("warns when a task may read through a server (D32, D35), not when it's off, and says what to do", () => {
    expect(workDataWarning(tool({}))).toBeUndefined();
    const on = tool({ rules: { ...tool({}).rules, tasks: { effect: "auto", isDefault: false, allowed: ["auto", "ask", "never"] } } });
    expect(workDataWarning(on)).toMatch(/repository's instructions/);
    expect(workDataWarning(on)).toMatch(/Set Tasks back to Never unless a task needs it\.$/);
    // GitHub's read tools, on for tasks by default (D35): every repository the account can see (the user's choice, 2026-10-19).
    const github = tool({ server: "github-mcp-server", tool: "search_code", wireName: "github-mcp-server-search_code", github: true, rules: { ...tool({}).rules, tasks: { effect: "auto", isDefault: true, allowed: ["auto", "ask", "never"] } } });
    expect(workDataWarning(github)).toMatch(/another repository your GitHub account can see \(private ones and other organisations' included\) and copy it into its work/);
    expect(workDataWarning(github)).toMatch(/Ask or Never/);
    // Already on Ask: the advice is Never.
    const asking = workDataWarning({ ...github, rules: { ...github.rules, tasks: { ...github.rules.tasks, effect: "ask" } } });
    expect(asking).toMatch(/another repository/);
    expect(asking).toMatch(/Set Tasks to Never for this tool/);
    expect(asking).not.toMatch(/Ask or Never/);
    expect(workDataWarning({ ...github, rules: { ...github.rules, tasks: { ...github.rules.tasks, effect: "never" } } })).toBeUndefined();
    expect(workDataWarning({ ...github, cls: "write" })).toBeUndefined();
    expect(workDataWarning({ ...on, github: true })).not.toMatch(/mail/);
    // What it could read, where ARIA knows the server; a server it doesn't know isn't said to hold your mail.
    expect(workDataWarning(on, server({ name: "Work IQ Mail" }))).toMatch(/read your mail, chats and calendar through this tool/);
    expect(workDataWarning(on, server({ name: "Acme Tasks", tracker: true }), ACME)).toMatch(/read your Acme tasks and time/);
    expect(workDataWarning(on, server({ name: "home-assistant" }))).toMatch(/read whatever this tool can reach, and put it in the repository/);
    expect(workDataWarning(on, server({ name: "home-assistant" }))).not.toMatch(/mail/);
  });

  it("knows Work IQ by its names in the Copilot CLI setup, and the task tracker's servers by core's flag", () => {
    expect(serverReaches(server({ name: "Work IQ Teams" }))).toMatch(/mail/);
    expect(serverReaches(server({ name: "workiq", sourcePlugin: "workiq" }))).toMatch(/mail/);
    expect(serverReaches(server({ name: "Mail", sourcePlugin: "workiq" }))).toMatch(/mail/);
    expect(serverReaches(server({ name: "AcmeApi", tracker: true }), ACME)).toBe("your Acme tasks and time");
    expect(serverReaches(server({ name: "AcmeApi" }), ACME)).toBeUndefined();
    expect(serverReaches(server({ name: "AcmeApi", tracker: true }))).toBe("your Tracker tasks and time");
    expect(serverReaches(server({ name: "SlideDeckBuilder" }))).toBeUndefined();
    expect(serverReaches(undefined)).toBeUndefined();
  });

  it("shows a rule's note only where the row differs from what the page says above the list", () => {
    const read = tool({ rules: { aria: { effect: "auto", isDefault: true, allowed: ["auto", "ask", "never"], note: "Ask needs an action card (Phase 5)" }, tasks: { effect: "never", isDefault: true, allowed: ["auto", "ask", "never"] } } });
    expect(noteShown("aria", read)).toBe(false);
    // ARIA's Ask on a read tool works like Never (D22): said on the row.
    expect(noteShown("aria", { ...read, rules: { ...read.rules, aria: { ...read.rules.aria, effect: "ask" } } })).toBe(true);
    expect(noteShown("tasks", read)).toBe(false);
    const write = tool({ cls: "write", rules: { aria: { effect: "ask", isDefault: true, allowed: ["ask", "never"], note: "ARIA can't change things on its own" }, tasks: { effect: "never", isDefault: true, allowed: ["ask", "never"], note: "A task can use a tool that changes things only after your approval" } } });
    // The general rule for a write: not repeated on every row (it opens on "Why?").
    expect(noteShown("aria", write)).toBe(false);
    expect(noteShown("tasks", write)).toBe(false);
    // A select a fixed rule locks (D31) always says why.
    expect(noteShown("tasks", { ...write, rules: { ...write.rules, tasks: { effect: "never", isDefault: true, allowed: ["never"], note: "Always refused for tasks" } } })).toBe(true);
  });

  it("lists your own rules for a server, per tool and scope (what a move to another server takes along)", () => {
    const mine = tool({ server: "Old", tool: "a", rules: { aria: { effect: "never", isDefault: false, allowed: ["auto", "ask", "never"] }, tasks: { effect: "auto", isDefault: false, allowed: ["auto", "ask", "never"] } } });
    expect(yourRules([mine, tool({ server: "Old", tool: "b" }), tool({ server: "New", tool: "a", rules: mine.rules })], "Old")).toEqual([
      { tool: "a", scope: "aria" },
      { tool: "a", scope: "tasks" },
    ]);
    expect(yourRules([tool({ server: "Old" })], "Old")).toEqual([]);
  });

  it("filters tools, and counts the tasks that keep the tools they opened with", () => {
    const changed = tool({ tool: "SendMail", wireName: "Work-IQ-Mail-SendMail", rules: { ...tool({}).rules, aria: { effect: "never", isDefault: false, allowed: ["ask", "never"] } } });
    expect(filterTools([tool({}), changed], "send", false).map((t) => t.tool)).toEqual(["SendMail"]);
    expect(filterTools([tool({}), changed], "", true).map((t) => t.tool)).toEqual(["SendMail"]);
    expect(filterTools([tool({}), changed], "work iq", false)).toHaveLength(2);
    const t = (state: Task["state"]) => ({ state }) as Task;
    expect(runningTasks([t("running"), t("waiting_permission"), t("done"), t("queued")])).toBe(2);
  });
});
