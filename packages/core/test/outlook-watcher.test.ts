import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CardItem, EngineEvent } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateOutlookMessageRules,
  FakeRuntime,
  formatOutlookDigestLine,
  formatOutlookToastTitle,
  formatSpokenText,
  AriaEngine,
  ManualClock,
  parseOutlookMessagesPayload,
  parseUtilityTriageResponse,
  validateOutlookWebLink,
} from "../src/index.ts";
import { acmeTracker } from "./helpers/acme.ts";
import "./no-network.ts";

const tempDirs: string[] = [];
const engines: AriaEngine[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-outlook-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Outlook email watcher: payload parsing, webLink validation, and Stage 1 plain-code rules", () => {
  it("validates Outlook webLinks and sanitizes HTML/disguise characters in parsed Graph messages", () => {
    expect(validateOutlookWebLink("https://outlook.office365.com/owa/?ItemID=AAMk123")).toBe(
      "https://outlook.office365.com/owa/?ItemID=AAMk123",
    );
    expect(validateOutlookWebLink("https://outlook.office.com/mail/id/123")).toBe(
      "https://outlook.office.com/mail/id/123",
    );
    expect(validateOutlookWebLink("https://evil.example.com/outlook.office.com")).toBeUndefined();
    expect(validateOutlookWebLink("http://outlook.office.com/mail/id/123")).toBeUndefined();

    const parsed = parseOutlookMessagesPayload(
      acmeTracker,
      {
        value: [
          {
            id: "msg-1",
            conversationId: "conv-1",
            subject: "<script>evil()</script>Release sign-off for ACME-789\u202E?",
            from: {
              emailAddress: {
                name: "Alice\u200B Smith",
                address: "Alice.Smith@example.com",
              },
            },
            toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
            receivedDateTime: "2026-11-03T08:30:00Z",
            isRead: false,
            isDraft: false,
            importance: "high",
            flag: { flagStatus: "flagged" },
            bodyPreview: "<p>Hi Sam, can you confirm &amp; sign off on ACME-789 before 14:00?</p>",
            webLink: "https://outlook.office.com/mail/inbox/id/msg-1",
          },
        ],
      },
      1_700_000_000_000,
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      messageId: "msg-1",
      conversationId: "conv-1",
      subject: "evil() Release sign-off for ACME-789?",
      fromName: "Alice Smith",
      fromAddress: "alice.smith@example.com",
      toAddresses: ["sam@example.com"],
      ccAddresses: [],
      isRead: false,
      isDraft: false,
      importance: "high",
      flagged: true,
      preview: "Hi Sam, can you confirm & sign off on ACME-789 before 14:00?",
      trackerTaskId: "ACME-789",
      webLink: "https://outlook.office.com/mail/inbox/id/msg-1",
    });
  });

  it("filters out automated/GitHub/read/CC-only noise and scores VIP, High-importance, and action-needed emails", () => {
    const baseMsg = {
      messageId: "m1",
      subject: "Weekly newsletter",
      fromName: "No Reply",
      fromAddress: "noreply@company.com",
      toAddresses: ["sam@example.com"],
      ccAddresses: [],
      receivedAt: 1_000,
      isRead: false,
      isDraft: false,
      importance: "normal" as const,
      flagged: false,
    };

    // Automated noreply -> rejected
    expect(evaluateOutlookMessageRules(acmeTracker, baseMsg).candidate).toBe(false);

    // GitHub notification -> rejected (already handled by GitHub watchers)
    expect(
      evaluateOutlookMessageRules(acmeTracker, {
        ...baseMsg,
        fromName: "GitHub",
        fromAddress: "notifications@github.com",
        subject: "Re: [RobbieDemaegdt/aria] PR #12",
      }).candidate,
    ).toBe(false);

    // Pure CC without question/VIP/high-importance -> rejected
    expect(
      evaluateOutlookMessageRules(
        acmeTracker,
        {
          ...baseMsg,
          fromName: "Bob",
          fromAddress: "bob@example.com",
          subject: "Status update for Q4",
          toAddresses: ["team@example.com"],
          ccAddresses: ["sam@example.com"],
        },
        { userEmail: "sam@example.com" },
      ).candidate,
    ).toBe(false);

    // VIP sender -> urgent
    expect(
      evaluateOutlookMessageRules(
        acmeTracker,
        {
          ...baseMsg,
          fromName: "Thomas",
          fromAddress: "thomas@example.com",
          subject: "Quick sync",
        },
        { vipSenders: ["thomas@example.com"] },
      ),
    ).toMatchObject({
      candidate: true,
      urgency: "urgent",
      recipientRole: "to",
    });

    // Direct question -> action_needed
    expect(
      evaluateOutlookMessageRules(acmeTracker, {
        ...baseMsg,
        fromName: "Sarah",
        fromAddress: "sarah@example.com",
        subject: "Connector deployment",
        preview: "Could you please review the modem build before Friday?",
      }),
    ).toMatchObject({
      candidate: true,
      urgency: "action_needed",
      recipientRole: "to",
    });
  });

  it("parses Utility model triage JSON responses and formats spoken/digest strings safely", () => {
    const map = parseUtilityTriageResponse(
      '```json\n[{"id":"m-1","verdict":"urgent","reason":"<b>Asks you to approve production hotfix by 15:00</b>"},{"id":"m-2","verdict":"ignore","reason":"FYI newsletter"}]\n```',
    );
    expect(map.get("m-1")).toEqual({
      verdict: "urgent",
      reason: "Asks you to approve production hotfix by 15:00",
    });
    expect(map.get("m-2")).toEqual({
      verdict: "ignore",
      reason: "FYI newsletter",
    });

    const samplePayload = {
      messageId: "m-1",
      subject: "Hotfix approval",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      receivedAt: 1_000,
      urgency: "urgent" as const,
      reason: "Asks you to approve production hotfix by 15:00.",
      trackerTaskId: "ACME-789",
    };
    expect(formatOutlookToastTitle(samplePayload)).toBe("Urgent email · Alice");
    expect(formatOutlookDigestLine(acmeTracker, samplePayload)).toContain("[outlook] Email (urgent) from");
    expect(formatOutlookDigestLine(acmeTracker, samplePayload)).toContain(`[${acmeTracker.label} #ACME-789]`);
    expect(
      formatSpokenText({
        kind: "outlook_urgent",
        title: formatOutlookToastTitle(samplePayload),
        body: samplePayload.subject,
        cardId: "card-1",
      }),
    ).toBe("Urgent email · Alice: Hotfix approval.");
  });
});

describe("OutlookWatcher + AriaEngine end-to-end integration", () => {
  it("baselines on cold start with zero cards, then triages new unread emails with the Utility model and emits cards, toasts, and MyWork state", async () => {
    const dir = makeTempDir();
    const clock = new ManualClock(1_700_000_000_000);

    let currentMessages: Array<Record<string, unknown>> = [
      {
        id: "msg-baseline-1",
        subject: "Existing unread question?",
        from: { emailAddress: { name: "Bob", address: "bob@example.com" } },
        toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
        receivedDateTime: new Date(clock.now() - 60_000).toISOString(),
        isRead: false,
        isDraft: false,
        importance: "normal",
        bodyPreview: "Can you check this when you have time?",
        webLink: "https://outlook.office.com/mail/inbox/id/msg-baseline-1",
      },
    ];
    let pollCalls = 0;

    const mcpServer = new Server(
      { name: "work-iq-mail-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "SearchMessagesQueryParameters",
          description: "Searches Outlook messages with OData query parameters.",
          inputSchema: { type: "object", properties: { queryParameters: { type: "string" } } },
        },
      ],
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "SearchMessagesQueryParameters") {
        pollCalls++;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ value: currentMessages }) }],
        };
      }
      throw new Error(`Unexpected tool: ${req.params.name}`);
    });

    const runtime = new FakeRuntime();
    runtime.inventoryResult = {
      servers: [{ name: "Work IQ Mail", status: "connected", source: "plugin" }],
      tools: [
        {
          name: "Work-IQ-Mail-SearchMessagesQueryParameters",
          server: "Work IQ Mail",
          tool: "SearchMessagesQueryParameters",
          description: "Searches Outlook messages.",
        },
      ],
    };

    const events: EngineEvent[] = [];
    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [],
      tracker: acmeTracker,
      attentionClock: clock,
      watchClock: clock,
      watchJitter: 0,
      mcpTransportFactory: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        return clientTransport;
      },
    });
    engines.push(engine);
    engine.onEvent((e) => events.push(e));

    await engine.start();
    for (let i = 0; i < 40 && pollCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 30));

    // 1. Cold start: 1 poll executed, ZERO outlook_mail cards emitted, but MyWork.outlook has the baseline actionable email
    expect(pollCalls).toBe(1);
    const initialCards = engine
      .getState()
      .timeline.filter((i): i is Extract<CardItem, { cardType: "outlook_mail" }> => i.kind === "card" && i.cardType === "outlook_mail");
    expect(initialCards).toHaveLength(0);

    const myWork1 = await engine.myWork(false);
    expect(myWork1.outlook?.status).toBe("ok");
    expect(myWork1.outlook?.messages).toHaveLength(1);
    expect(myWork1.outlook?.messages[0]?.messageId).toBe("msg-baseline-1");

    // 2. Enable Utility model triage and mark user away so blocking/milestone toasts fire
    engine.setUtilitySettings({ enabled: true });
    runtime.utilityHandler = () => ({
      ok: true,
      text: JSON.stringify([
        {
          id: "msg-new-urgent",
          verdict: "urgent",
          reason: "Needs your sign-off on the Q4 connector release before 16:00 today.",
        },
        {
          id: "msg-new-fyi",
          verdict: "ignore",
          reason: "General FYI announcement.",
        },
      ]),
    });

    engine.setPresence(false, clock.now());

    // 3. Add two new unread emails (one urgent, one FYI that Utility model filters out) and advance 5 minutes
    currentMessages = [
      ...currentMessages,
      {
        id: "msg-new-urgent",
        subject: "Q4 Connector Release Sign-off (ACME-789)",
        from: { emailAddress: { name: "Alice Smith", address: "alice@example.com" } },
        toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
        receivedDateTime: new Date(clock.now() + 60_000).toISOString(),
        isRead: false,
        isDraft: false,
        importance: "normal",
        bodyPreview: "Hi Sam, can you approve the Q4 connector release for ACME-789 before 16:00?",
        webLink: "https://outlook.office.com/mail/inbox/id/msg-new-urgent",
      },
      {
        id: "msg-new-fyi",
        subject: "Office coffee machine maintenance",
        from: { emailAddress: { name: "Facilities", address: "facilities@example.com" } },
        toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
        receivedDateTime: new Date(clock.now() + 60_000).toISOString(),
        isRead: false,
        isDraft: false,
        importance: "normal",
        bodyPreview: "The coffee machine on floor 2 is back online.",
      },
    ];

    clock.advance(5 * 60_000);
    for (let i = 0; i < 40 && pollCalls < 2; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 40));

    expect(pollCalls).toBe(2);

    // Only msg-new-urgent produced a card (msg-new-fyi was filtered out by the Utility model!)
    const mailCards = engine
      .getState()
      .timeline.filter((i): i is Extract<CardItem, { cardType: "outlook_mail" }> => i.kind === "card" && i.cardType === "outlook_mail");
    expect(mailCards).toHaveLength(1);
    expect(mailCards[0]!.payload).toMatchObject({
      messageId: "msg-new-urgent",
      subject: "Q4 Connector Release Sign-off (ACME-789)",
      fromName: "Alice Smith",
      fromAddress: "alice@example.com",
      urgency: "urgent",
      reason: "Needs your sign-off on the Q4 connector release before 16:00 today.",
      trackerTaskId: "ACME-789",
      webLink: "https://outlook.office.com/mail/inbox/id/msg-new-urgent",
    });

    // Blocking toast fired while away
    const toasts = events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast");
    expect(toasts.some((t) => t.priority === "blocking" && t.title === "Urgent email · Alice Smith")).toBe(true);

    // Dismissing the card removes it from timeline and from MyWork.outlook.messages
    engine.dismissCard(mailCards[0]!.id);
    const myWorkAfterDismiss = await engine.myWork(false);
    expect(myWorkAfterDismiss.outlook?.messages.map((m) => m.messageId)).toEqual(["msg-baseline-1"]);
  });

  it("wakes and polls Work IQ Mail when reconnected via runtime OAuth (without direct bearerToken or transportFactory, even when only write tools were initially in catalog)", async () => {
    const dir = makeTempDir();
    const clock = new ManualClock(1_700_000_000_000);

    let actionCalls = 0;
    const runtime = new FakeRuntime();
    // Simulate real CopilotRuntime where mcpResults is undefined and calls go through runMcpAction (OAuth session)
    (runtime as { mcpResults?: Record<string, unknown> }).mcpResults = undefined;
    (runtime as { callMcpToolDirect?: unknown }).callMcpToolDirect = undefined;
    runtime.runMcpAction = async (req) => {
      actionCalls++;
      expect(req.server).toBe("Work IQ Mail");
      expect(req.tool).toBe("SearchMessagesQueryParameters");
      return {
        ok: true,
        result: JSON.stringify({
          value: [
            {
              id: "msg-oauth-1",
              subject: "Can you review the connector PR?",
              from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
              toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
              receivedDateTime: new Date(clock.now() - 10_000).toISOString(),
              isRead: false,
              isDraft: false,
              importance: "high",
              bodyPreview: "Please review before 17:00.",
            },
          ],
        }),
      };
    };

    // Initially Work IQ Mail is needs-auth and only has a write tool in catalog
    runtime.inventoryResult = {
      servers: [{ name: "Work IQ Mail", status: "needs-auth", source: "plugin" }],
      tools: [
        {
          name: "Work-IQ-Mail-ReplyToMessage",
          server: "Work IQ Mail",
          tool: "ReplyToMessage",
          description: "Reply to a message.",
        },
      ],
    };

    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [],
      attentionClock: clock,
      watchClock: clock,
      watchJitter: 0,
    });
    engines.push(engine);
    await engine.start();

    const beforeReconnect = await engine.myWork(false);
    expect(beforeReconnect.outlook?.status).toBe("needs_auth");

    // User reconnects Work IQ Mail via Sign in (status becomes "connected", even if getCurrentMetadata only listed write tools)
    await engine.signIn("Work IQ Mail");

    for (let i = 0; i < 40 && actionCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 30));

    expect(actionCalls).toBe(1);
    const afterReconnect = await engine.myWork(false);
    expect(afterReconnect.outlook?.status).toBe("ok");
    expect(afterReconnect.outlook?.messages).toHaveLength(1);
    expect(afterReconnect.outlook?.messages[0]?.messageId).toBe("msg-oauth-1");
  });
});
