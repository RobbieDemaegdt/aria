# Keeping big session cards small in the ARIA chat

> Status: option 1 built · 2026-11-12 · see [What was built](#what-was-built) at the end.
> Follows [Decluttering the ARIA chat](chat-declutter-proposal.md).

## The problem

When a session sends a big response (a plan, a long result, a long question), its card fills the ARIA chat and you
have to scroll past it. The receipts from the first declutter round only shrink a card after you've handled it, so a big
card is still big when it arrives.

## What makes the chat tall today

- **Pending plan card.** It shows the summary (up to 192px) and the whole plan opened underneath (up to 320px), plus the
  review buttons ([CardsApproval.tsx:296](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L296)). The
  session view already has a Plan tab ([SessionView.tsx:652](../apps/desktop/src/renderer/src/components/SessionView.tsx#L652))
  and the card already has an "Open plan" button, but the card doesn't use them to stay small.
- **Done card.** It shows the session's full summary with no height limit, and never folds to a receipt
  ([CardsTask.tsx:518](../apps/desktop/src/renderer/src/components/CardsTask.tsx#L518)).
- **Pending question card.** Full question text, no limit
  ([CardsTask.tsx:365](../apps/desktop/src/renderer/src/components/CardsTask.tsx#L365)).
- **ARIA's own replies and failed-task errors.** No limit either
  ([Chat.tsx:237](../apps/desktop/src/renderer/src/components/Chat.tsx#L237)).

## Options

### 1. The plan card becomes a pointer

**Effort:** small · renderer only

The card shows the title, two or three lines of summary, "Open plan" and the review buttons. The full plan is only in
the session's Plan tab.

```
┌ L-2  fix-login has a plan for you to review · ARIA ──── [Open plan] ┐
│ Move the token refresh into the auth client and retry once on 401…    │
│ [Approve: autopilot] [Approve: interactive] [Revise…] [Reject]        │
└───────────────────────────────────────────────────────────────────────┘
```

**Catch:** one extra click to read a plan before approving it.

### 2. One height rule for every session card

**Effort:** small to medium · renderer only

Any card body (done summary, question, plan, error) shows about five lines with a fade. "Show more" expands it in
place, and "Open in session" shows it in the session view.

**Catch:** pending questions need a looser limit, because you must read them to answer.

### 3. A Result tab in the session

**Effort:** medium

The done summary moves to its own session tab, like the plan. The done card becomes one line: title, files changed,
"View diff", "Open result".

**Catch:** the summary is usually the thing you want to read, so you click for every finished session.

### 4. Done cards fold once you've dealt with them

**Effort:** small · renderer only

A done card stays full until you act on it (diff, PR, continue) or the session posts something newer. Then it becomes a
receipt.

**Catch:** it doesn't help at the moment the card arrives.

### 5. Clamp ARIA's long replies

**Effort:** small · renderer only

Long assistant bubbles show the first lines with "Show more".

**Catch:** it hides ARIA's answer to you, which is the main content of the chat.

## Comparison

| Option | Smaller on arrival | Covers | Effort | Touches engine |
| --- | --- | --- | --- | --- |
| 1. Plan card as pointer | Yes | Plans | Small | No |
| 2. Height rule for all cards | Yes | Plans, results, questions, errors | Small–medium | No |
| 3. Result tab | Yes | Results | Medium | Maybe |
| 4. Done cards fold when dealt with | No | Results | Small | No |
| 5. Clamp ARIA's replies | Yes | ARIA's replies | Small | No |

## Recommendation

**1 + 2.** Option 1 is the plan-specific case of option 2. Option 2 also covers done summaries, which have no limit
today and are probably the biggest cards. Option 4 is a cheap addition afterwards if finished sessions still pile up.
Skip 3 and 5 unless 1 + 2 turn out not to be enough.

## Decisions

- 2026-11-12: start with option 1. Plan: [chat-compact-cards-option-1-plan.md](chat-compact-cards-option-1-plan.md).

## What was built

Option 1, in the renderer only. The engine, the protocol and the Plan tab are unchanged.

**1. The plan card as a pointer.** While a plan waits for review, its card shows at most three lines of plain text
from the summary (or from the plan text when the agent gave no summary), "Open plan" in the accent colour, and the
review buttons. The whole plan is read in the session's Plan tab, where the same review buttons sit under it. Once
handled, the card is a one-line receipt as before; opening it shows the summary and "The plan" (folded), so an older,
revised plan stays readable. Built in `PlanCard`
([CardsApproval.tsx](../apps/desktop/src/renderer/src/components/CardsApproval.tsx)), with an `accent` look added to
`Button` ([CardParts.tsx](../apps/desktop/src/renderer/src/components/CardParts.tsx)). Plan:
[chat-compact-cards-option-1-plan.md](chat-compact-cards-option-1-plan.md).

Options 2 and 4 are still open.
