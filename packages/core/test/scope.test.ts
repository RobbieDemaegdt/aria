import { describe, expect, it } from "vitest";
import { classifyTool, conductorScope, toolWords } from "../src/integrations/scope.ts";

describe("classifyTool", () => {
  it.each([
    ["list_my_issues", "read"],
    ["list_worklogs_raw", "read"],
    ["search_issues", "read"],
    ["TestConnection", "read"],
    ["api_get", "read"],
    ["ListCalendarView", "read"],
    ["GetUserDateAndTimeZoneSettings", "read"],
    ["SearchMessagesQueryParameters", "read"],
    ["GetOnlineMeetingTranscripts", "read"],
    ["FindMeetingTimes", "read"],
    ["ask", "read"],
    ["fetch_blob", "read"],
    ["todo__get_items", "read"],
    ["homeassistant__GetLiveContext", "read"],
    ["llm__GetDateTime", "read"],
    ["add_worklogs", "write"],
    ["update_issues", "write"],
    ["add_issue_to_sprint", "write"],
    ["SendMessageToSelf", "write"],
    ["AcceptEvent", "write"],
    ["do_action", "write"],
    ["call_function", "write"],
    ["todo__HassListAddItem", "write"],
    ["todo__HassListCompleteItem", "write"],
    ["media_player__HassMediaUnpause", "write"],
    ["intent__HassTurnOn", "write"],
    ["DownloadAttachment", "write"],
    ["something_unknown", "write"],
    ["delete_worklogs", "destructive"],
    ["remove_issue_from_sprint", "destructive"],
    ["todo__HassListRemoveItem", "destructive"],
    ["DeleteEventById", "destructive"],
    ["api_post", "unrestricted"],
    ["api_patch", "unrestricted"],
    ["api_delete", "unrestricted"],
  ])("%s → %s", (name, expected) => {
    expect(classifyTool(name)).toBe(expected);
  });

  it("splits snake, Pascal and domain-prefixed names", () => {
    expect(toolWords("todo__HassListAddItem")).toEqual(["list", "add", "item"]);
    expect(toolWords("GetOnlineMeetingAIInsights")).toEqual(["get", "online", "meeting", "ai", "insights"]);
  });
});

describe("conductorScope", () => {
  const servers = [
    { name: "Acme", status: "connected", url: "https://tracker.example/mcp" },
    { name: "AcmeApi", status: "connected", url: "https://tracker.example/mcp/" },
    { name: "Work IQ Calendar", status: "connected", url: "https://m365.example/calendar" },
    { name: "home-assistant", status: "connected", url: "https://ha.example/mcp" },
  ];
  const tools = [
    "view", "glob", "grep", "powershell", "edit",
    "Acme-list_my_issues", "Acme-create_issues", "Acme-delete_worklogs", "Acme-api_post",
    "AcmeApi-list_my_issues",
    "Work-IQ-Calendar-ListCalendarView", "Work-IQ-Calendar-AcceptEvent",
    "home-assistant-intent__HassTurnOn",
  ].map((name) => ({ name }));

  const scope = conductorScope(tools, servers);

  it("keeps only read tools, by exact wire name", () => {
    expect(scope.readTools.sort()).toEqual(["Acme-list_my_issues", "Work-IQ-Calendar-ListCalendarView"]);
    expect(scope.availableTools).toEqual(expect.arrayContaining(["builtin:view", "builtin:glob", "builtin:grep", "custom:*", "mcp:Acme-list_my_issues"]));
    expect(scope.availableTools.some((t) => /powershell|edit|create|delete|api_post|Accept|TurnOn/.test(t))).toBe(false);
  });

  it("drops a server that has the same URL as a bigger one", () => {
    expect(scope.duplicates).toEqual(["AcmeApi"]);
    expect(scope.readTools).not.toContain("AcmeApi-list_my_issues");
  });

  it("disables servers without read tools in scope", () => {
    expect(scope.disabledMcpServers.sort()).toEqual(["AcmeApi", "home-assistant"]);
  });
});
