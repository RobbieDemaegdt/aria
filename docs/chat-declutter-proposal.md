# Decluttering the ARIA chat

> Status: 1 + 2a + 3-lite built · 2026-11-07 · see [What was built](#what-was-built) at the end.

## The problem

With several sessions running, the ARIA chat fills up with notifications from all of them. Acting on one (answering,
approving) brings in more notifications. Two things go wrong:

- **You miss things.** An item that still needs you gets lost between updates that don't.
- **Scrolling back, it's not clear what a card is about** or which session it belongs to.

## Why the chat gets cluttered

- **Updates from different sessions are mixed together.** Each session's live task card stays where it first appeared
  ([manager.ts:759](../packages/core/src/tasks/manager.ts#L759)). Its later questions, approvals, notices and "done" cards
  are added at the bottom, mixed in with every other session's. When you scroll back, only the card title tells you which
  session a card belongs to.
- **Handled cards stay full size.** After you approve something, the card turns grey but still shows the whole command,
  its reason and where it runs ([CardsApproval.tsx:90](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L90)).
  An item you've dealt with looks almost the same as one that still needs you.
- **Acting adds more items.** A reply from the composer adds its own message bubble at the bottom
  ([engine.ts:1458](../packages/core/src/engine.ts#L1458)). The session then resumes and sends its next card or notice, so
  one action can leave two or three new items.
- **The tools you have are hard to find.** "Compact" is off by default and turns itself off again after a reload, because
  it's only local state ([Chat.tsx:769](../apps/desktop/src/renderer/src/components/Chat.tsx#L769)). It also hides
  everything behind a single banner at the top. The strip of session chips only shows when the sidebar is collapsed
  ([Chat.tsx:886](../apps/desktop/src/renderer/src/components/Chat.tsx#L886)).

## Options

### 1. Shrink handled cards to a one-line receipt

**Effort:** small · display only

Once a question, approval, plan, proposal or action request is handled, it becomes one line you can click to expand.
Cards that still need you stay large, so they stand out.

```
✓ P-2  fix-login · approved `npm install`             14:02 ›
✓ Q-3  fix-login · "Which branch?" → main             14:01 ›
┌ P-4  docs-sweep needs your approval ─────────────────────┐
│ git push --force …              [Approve] [Reject]        │
└───────────────────────────────────────────────────────────┘
```

The receipt is built from fields the cards already have (`decision`, `answer`, `answeredBy`, `note`).

### 2. Group updates by session

- **2a, run grouping** (small to medium): back-to-back items from the same session merge into one block with a session
  header. Each session also gets its own colour stripe on the left, so you can follow it even when sessions are mixed.
  The order stays strictly by time.
- **2b, full threads** (medium to large): the task card holds that session's whole history, collapsed to the latest few
  updates. A new event either moves the thread to the bottom, or leaves a short "↳ fix-login: 1 new update" line there
  that jumps to it.

```
┃ fix-login · ARIA · Running                 Open  Stop
┃   ✓ Q-3 → main                                     14:01
┃   ✓ P-2 approved npm install                       14:02
┃   ● P-4 needs your approval   [Approve] [Reject]   14:05
```

`sessionOwnerKey` in [Chat.tsx:300](../apps/desktop/src/renderer/src/components/Chat.tsx#L300) already works out which
session or watch an item belongs to, so both variants can build on it.

### 3. A "Needs you" tray above the composer

**Effort:** medium

Anything waiting on you is pinned above the input box and stays there until you handle it, however far the chat scrolls.
Handling it leaves a receipt in the timeline.

```
 ─────────────────────────────── timeline ───
 ┌ Needs you (2) ──────────────────────────────────┐
 │ P-4 docs-sweep · git push --force  [Approve] [Reject] │
 │ Q-7 fix-login · Which tone?        [Answer…]    │
 └─────────────────────────────────────────────────┘
 [ Ask ARIA anything…                           ]
```

**3-lite** (small): the existing "2 need you" label in the header becomes a button that jumps to the next waiting card,
and cycles through them on each click. The count also includes action requests, PR confirmations and proposals, not
only tasks as it does today ([Chat.tsx:771](../apps/desktop/src/renderer/src/components/Chat.tsx#L771)).

### 4. Make Compact the default, and improve it

**Effort:** small

- Compact is on and remembered between restarts, saved with the other UI settings.
- In place of the banner at the top, a small "··· 4 earlier updates from fix-login" line sits where those items were.
- A "New since you last looked" line appears when events arrive while you're scrolled up or busy on a card.
- The hiding rules in `findSupersededSessionItems` get tightened. For example, today a notice is hidden just because
  another notice follows it.

### 5. Split the conversation from the activity feed

**Effort:** large

The chat only shows you, ARIA and cards that need you. Every other session event goes to a filterable Activity pane
with unread markers. It's the cleanest result, but it goes against the "one single chat to control everything" goal in
PLAN.md §0.1, so it's a last resort.

## Comparison

| Option | Fixes "missing things" | Fixes "what is this card" | Effort | Touches engine |
| --- | --- | --- | --- | --- |
| 1. Receipts | Partly: pending cards stand out | Yes | Small | No |
| 2a. Run grouping + colour | No | Yes | Small–medium | No |
| 2b. Full threads | Partly | Yes | Medium–large | No |
| 3. Needs-you tray | Yes | No | Medium | No |
| 3-lite. Jump to next pending | Yes | No | Small | No |
| 4. Better Compact | Partly | Partly | Small | No |
| 5. Chat / Activity split | Yes | Yes | Large | Likely |

## Recommendation

Start with **1 + 2a + 3-lite**. Together they cover both problems:

- **Missing things:** pending cards stand out, and one click takes you to the next one.
- **Not knowing what a card is when scrolling back:** short receipts and a colour per session make it clear.

All three only change how the chat displays things, using data the cards already have, so the engine and protocol stay
as they are. If it still feels busy after that, 2b or the full tray from option 3 are the next steps.

Both choices below follow the same rule: first make the changes that keep the timeline in time order and show each card
only once. Then step up to the bigger version only if the clutter is still a problem.

### Why 2a over 2b

**2b breaks the time order of the chat.**

- **Threads moved to the bottom:** if a thread jumps down on each new event, cards move while you're reading or
  scrolling back. That breaks scrolling back to see what happened at 14:00. It also breaks jumping to a card, because
  toasts and session chips scroll to a card's position
  ([Chat.tsx:805](../apps/desktop/src/renderer/src/components/Chat.tsx#L805)).
- **Threads kept in place:** you need the "↳ 1 new update" pointer line at the bottom, so each event still adds an item.
  Smaller, but it's the same clutter we're trying to remove.

**Your messages and ARIA's replies don't belong to any session.** They stay in the main chat, while the events they
talk about are tucked into threads somewhere else. An ARIA message like "P-4 is done, Q-3 is waiting" would then sit far
from both of them.

**Collapsed threads can hide things that need you.** That's the first problem this proposal is meant to fix. Avoiding
it means extra rules, such as "always expand a thread that has something pending".

**The cost is very different.**

- 2b turns the timeline from a list into a tree. That affects day dividers, the Compact logic, clearing cards, jumping
  to a card, and the UI tests.
- 2a only draws adjacent items as one group. The list, card ids and scrolling all stay as they are.

**Where 2a falls short:** when sessions alternate (A, B, A, B), there are no back-to-back runs to group, and only the
colour stripe helps. If that turns out to be the usual pattern, 2b is worth it. 2a doesn't block that later: the session
key and the colours carry over.

### Why 3-lite over the full tray

**The full tray shows each pending card twice**, once in the timeline and once in the tray. The answer box and the
reject note keep what you've typed only inside each copy
([CardsTask.tsx:265](../apps/desktop/src/renderer/src/components/CardsTask.tsx#L265),
[CardsApproval.tsx:18](../apps/desktop/src/renderer/src/components/CardsApproval.tsx#L18)). So both copies need to stay
in sync, or the card has to leave the timeline, which loses its context.

**It takes space from the chat.** Three or four pending approvals, each with its command block, can fill half the
window. That's worse when a session view or the inspector is open and the chat is narrow. The tray would then need its
own rules for collapsing, limiting and scrolling.

**Most of what it needs is already there.** Toasts and chips already scroll to a card and flash it. 3-lite only connects
the "2 need you" label to that. With option 1 in place, pending cards are the only large cards left, so jumping to them
is usually enough.

**Where 3-lite falls short:** you still have to click to find what's pending, because nothing stays visible while you
scroll. If you still miss things after 1 + 3-lite, the full tray is the next step, and the same list of pending items
feeds it.

## What was built

Options 1, 2a and 3-lite, in the renderer only. The engine and the protocol are unchanged.

**1. Receipts.** Handled question, permission, plan and proposal cards fold into one line: an icon, the short id, the
session, what happened, and the time. A click on the line opens the whole card, and a chevron in its header folds it
back (that choice lasts until the window reloads). The line keeps the card's test id and `data-card-id`, so jumping to a
card still works. Follow-ups stay on the line: Always allow this, Undo in the task's view, Save as memory, and a started
proposal's Open button. Built in `Receipt` ([CardParts.tsx](../apps/desktop/src/renderer/src/components/CardParts.tsx))
and used by the cards in [CardsTask.tsx](../apps/desktop/src/renderer/src/components/CardsTask.tsx) and
[CardsApproval.tsx](../apps/desktop/src/renderer/src/components/CardsApproval.tsx).

Two changes from the proposal:

- **Action requests keep the whole card.** Once sent, the server's answer on the card is the thing you asked for, so
  folding it away would hide it.
- **A run has no header line.** Every card and session notice already names its session, so a header would repeat it
  and add a line per run.

**2a. Session runs.** Back-to-back items of one session or watch sit closer together behind a stripe in that session's
colour, and every session item gets the stripe, even on its own. Colours go by the order sessions first show up in the
chat, so sessions that start one after the other differ. Red and amber are left out of the palette, because they mean
"needs you" and warnings. Logic in [timelineGroups.ts](../apps/desktop/src/renderer/src/timelineGroups.ts), drawn by
`SessionRun` in [Chat.tsx](../apps/desktop/src/renderer/src/components/Chat.tsx).

**3-lite. The "need you" button.** The header's count is now a button. Each click goes to the next card that waits for
you, oldest first, and wraps round. A waiting task whose card isn't in the chat opens its session instead. The count is
the tasks that need you plus the proposals, action requests, PR confirmations, fix proposals and workflow dispatches
nobody decided yet.

**Checked with:**

- unit tests: [timeline-groups.test.ts](../apps/desktop/test/timeline-groups.test.ts) and
  [receipts.test.tsx](../apps/desktop/test/receipts.test.tsx), plus the rest of the desktop suite;
- typecheck and lint;
- the `ui-cards`, `ui-attention` and `ui-flow` Playwright specs on the fake runtime, and their screenshots.
