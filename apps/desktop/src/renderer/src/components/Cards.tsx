import type { CardItem } from "@aria/protocol";
import { PermissionCard, PlanCard } from "./CardsApproval";
import { PrConfirmCard } from "./CardsPr";
import { CiCard, FixProposalCard, GitHubAccountCard, OutlookMailCard, PrCard, TrackerUpdateCard, WatchEndedCard } from "./CardsWatch";
import { AwayCard, MorningBriefCardView, ReminderCardView } from "./CardsDaily";
import { ActionRequestCard, WorkflowDispatchCard } from "./CardsAction";
import { TimeRegisteredCard, TimesheetDraftCard } from "./CardsTime";
import { BudgetCard, DoneCard, FailedCard, InterruptedCard, ProposalCard, QuestionCard, TaskCard } from "./CardsTask";
import { WhatsNewCardView } from "./Onboarding";

// The views import these from here; they live in the files beside this one.
export { Button, CardMetaContext, formatHoursMinutes, ShortId } from "./CardParts";
export { PermissionActions, PlanActions } from "./CardsApproval";
export { PrConfirmCard } from "./CardsPr";
export { OpenPrButton, QuestionForm, ReplyButton, TaskPrLink, TaskReplyForm } from "./CardsTask";
import { CardMetaContext } from "./CardParts";

function renderCardBody(card: CardItem) {
  switch (card.cardType) {
    case "task":
      return <TaskCard card={card} />;
    case "task_question":
      return <QuestionCard card={card} />;
    case "task_permission":
      return <PermissionCard card={card} />;
    case "task_plan":
      return <PlanCard card={card} />;
    case "task_budget":
      return <BudgetCard card={card} />;
    case "task_done":
      return <DoneCard card={card} />;
    case "task_failed":
      return <FailedCard card={card} />;
    case "tasks_interrupted":
      return <InterruptedCard card={card} />;
    case "profile_proposal":
      return <ProposalCard card={card} />;
    case "away_digest":
      return <AwayCard card={card} />;
    case "ci":
      return <CiCard card={card} />;
    case "pr":
      return <PrCard card={card} />;
    case "github_account":
      return <GitHubAccountCard card={card} />;
    case "watch_ended":
      return <WatchEndedCard card={card} />;
    case "pr_confirm":
      return <PrConfirmCard card={card} />;
    case "fix_proposal":
      return <FixProposalCard card={card} />;
    case "action_request":
      return <ActionRequestCard card={card} />;
    case "workflow_dispatch":
      return <WorkflowDispatchCard card={card} />;
    case "timesheet_draft":
      return <TimesheetDraftCard card={card} />;
    case "time_registered":
      return <TimeRegisteredCard card={card} />;
    case "reminder":
      return <ReminderCardView card={card} />;
    case "morning_brief":
      return <MorningBriefCardView card={card} />;
    case "tracker_update":
      return <TrackerUpdateCard card={card} />;
    case "outlook_mail":
      return <OutlookMailCard card={card} />;
    case "whats_new":
      return <WhatsNewCardView card={card} />;
    default:
      return null;
  }
}

export function Card({ card }: { card: CardItem }) {
  const body = renderCardBody(card);
  if (!body) return null;
  return (
    <CardMetaContext.Provider value={{ createdAt: card.createdAt, ...(card.updatedAt !== undefined ? { updatedAt: card.updatedAt } : {}) }}>
      {body}
    </CardMetaContext.Provider>
  );
}
