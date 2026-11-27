# Plan: the plan card as a pointer (option 1)

> Status: built · 2026-11-12 · option 1 of [Keeping big session cards small](chat-compact-cards-proposal.md).

## Context

A plan that waits for review is one of the tallest cards in the ARIA chat. It shows the agent's summary (up to
192px) and the whole plan opened underneath (up to 320px), plus the review buttons
([CardsApproval.tsx:296](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L296)). The session view already
has a Plan tab, and the card already has an "Open plan" button that opens it, but the card doesn't use them to stay
small.

With option 1, the waiting plan card shows a short preview, "Open plan" and the review buttons. The full plan is read
in the session's Plan tab, where the same review buttons sit under it.

Renderer only. The engine, the protocol and the Plan tab stay as they are.

## What changes for the user

Before, a waiting plan card: summary as Markdown, "The plan" opened with the full text, review buttons.

After:

```
┌ L-2  fix-login has a plan for you to review · ARIA   [Open plan]  14:05 ┐
│ Move the token refresh into the auth client and retry once on a 401.     │
│ Adds a test for the expired-token path and removes the old interceptor…  │
│ [Approve] [Approve, step by step] [Revise…] [Stop]                       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Preview:** at most three lines of plain text, taken from the summary. If the agent gave no summary
  (`"(no summary)"`, set in [manager.ts:1717](../packages/core/src/tasks/manager.ts#L1717)), the preview comes from the
  plan text.
- **Open plan:** same button as today, in the accent colour while the plan waits, because it is now the way to read
  the plan.
- **Review buttons:** unchanged, so you can still approve from the chat after reading.
- **Handled plans:** unchanged. They stay a one-line receipt, and a click on the receipt opens the card with the
  summary and "The plan" (folded), as today. This keeps an older, revised plan readable: the Plan tab only shows the
  latest plan.

## Changes

### 1. `PlanCard` in [CardsApproval.tsx:245](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L245)

Split the body of the `Shell` on `pending`:

- **Pending:** replace the Markdown summary and the `<details>` with one preview element:
  `<div className="mt-1 line-clamp-3 wrap-anywhere text-sm text-muted" data-testid="plan-summary">{preview}</div>`,
  where `preview = oneLine(hasSummary ? p.summary : (p.plan ?? p.summary), 400)` and
  `hasSummary = p.summary.trim() !== "" && p.summary.trim() !== "(no summary)"`. Then `PlanActions` as today.
- **Not pending (opened from its receipt):** keep the current body as it is (Markdown summary, folded "The plan",
  decision line).
- **Open plan button:** keep `testId="plan-open-session"` and `openTask(task.id, "plan")`. While pending, give it the
  accent look. `Button` has only `primary` (filled), which would compete with "Approve", so it gets an optional
  `accent` prop (see change 2).

Reused as they are:

- `oneLine` and `Shell` in [CardParts.tsx](../apps/desktop/src/renderer/src/components/CardParts.tsx)
- `PlanActions` in [CardsApproval.tsx:175](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L175)
- `openTask` in [store.ts:961](../apps/desktop/src/renderer/src/store.ts#L961)
- `PlanTab` and `PlanBar` in [SessionView.tsx:652](../apps/desktop/src/renderer/src/components/SessionView.tsx#L652)
- `line-clamp-*`, already used in the renderer (for example
  [SearchView.tsx:202](../apps/desktop/src/renderer/src/components/SearchView.tsx#L202))

### 2. `Button` in [CardParts.tsx:135](../apps/desktop/src/renderer/src/components/CardParts.tsx#L135)

Add `accent?: boolean`: `border border-accent/50 text-accent hover:border-accent hover:text-fg`, like the Plan bar's
own "Open plan" button ([SessionView.tsx:717](../apps/desktop/src/renderer/src/components/SessionView.tsx#L717)). No
other caller changes.

### 3. Tests

- [receipts.test.tsx](../apps/desktop/test/receipts.test.tsx): extend the `plan()` helper to take an optional plan
  text, and add tests next to "folds a reviewed plan into its decision and summary":
  - a waiting plan (`task.plan.id === planId`) renders the preview, `plan-open-session` and `plan-autopilot`, and
    does not contain the plan body's text or a `<details`;
  - a waiting plan with `"(no summary)"` takes its preview from the plan text;
  - a long Markdown summary comes out as plain text (no `<h3>`).
- [ui-attention.spec.ts:240](../apps/desktop/e2e/ui-attention.spec.ts#L240): the existing `plan-summary` and
  `plan-autopilot` checks keep passing. Add: click `plan-open-session`, expect `session-plan-tab` to be visible, close
  the view with `session-close`, then approve from the card as now. The `ui-p3-4-plan.png` screenshot shows the smaller
  card.

### 4. The proposal doc

Set the status line of [chat-compact-cards-proposal.md](chat-compact-cards-proposal.md) to "option 1 built" and add a
short "What was built" section, like the first declutter doc.

## Branch

Branch `compact-plan-card`, made from `main`. It holds this plan and the proposal. The code changes go on the same
branch.

## Verification

Run from the repo root:

- `npm run typecheck`
- `npm run lint`
- `npm test -w @aria/desktop` (vitest: the new receipt tests and the rest of the desktop suite)
- `npm run e2e -w @aria/desktop -- ui-attention` (Playwright on the fake runtime, no AI credits), then look at
  `ui-p3-4-plan.png` to check the card's height and the three-line preview.

By hand in the app: start a session in plan mode, check that the card is small, that "Open plan" shows the Plan tab
beside the chat, and that approving works from both the card and the Plan bar.

## Out of scope

Option 2 (a height rule for done summaries, questions and errors) and option 4 (folding done cards). Both are in the
proposal doc for later.
