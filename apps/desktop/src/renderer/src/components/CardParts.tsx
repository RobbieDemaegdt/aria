// What the cards share: their frame, their buttons, the short ids you name them by, and a few helpers.
import { ChevronRight, ChevronUp, X } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { fullDateTime, turnTime } from "../inspector";
import { useAria } from "../store";

export interface CardMeta {
  createdAt: number;
  updatedAt?: number;
}

export const CardMetaContext = createContext<CardMeta | null>(null);

export const useTask = (taskId: string) => useAria((s) => s.tasks.find((t) => t.id === taskId));

/** A pending item's short id (Q-3, P-2, L-1, B-1): how you and ARIA refer to it in the chat. */
export function ShortId({ id }: { id?: string | undefined }) {
  if (!id) return null;
  return (
    <span className="mr-1.5 rounded bg-raised px-1 py-px font-mono text-[11px] font-normal text-muted" data-testid="short-id" title={`Write ${id} in the chat to refer to this (ARIA only approves what your own message names)`}>
      {id}
    </span>
  );
}

/** When the card was made and last changed, from the card's own item (or the timeline when it's drawn elsewhere). */
function useCardTimes(cardId: string) {
  const ctxMeta = useContext(CardMetaContext);
  const storeItem = useAria((s) => (ctxMeta ? undefined : s.timeline.find((i) => i.id === cardId)));
  const createdAt = ctxMeta?.createdAt ?? storeItem?.createdAt;
  const updatedAt = ctxMeta?.updatedAt ?? (storeItem && "updatedAt" in storeItem ? storeItem.updatedAt : undefined);
  return { createdAt, updatedAt, timestamp: updatedAt ?? createdAt };
}

function CardTime({ cardId }: { cardId: string }) {
  const { createdAt, updatedAt, timestamp } = useCardTimes(cardId);
  if (timestamp === undefined) return null;
  return (
    <time
      data-testid="card-time"
      dateTime={new Date(timestamp).toISOString()}
      title={updatedAt && createdAt && updatedAt !== createdAt ? `Updated ${fullDateTime(updatedAt)} (created ${fullDateTime(createdAt)})` : fullDateTime(timestamp)}
      className="shrink-0 text-[11px] font-normal text-muted"
    >
      {turnTime(timestamp)}
    </time>
  );
}

function DismissButton({ cardId }: { cardId: string }) {
  const dismissCard = useAria((s) => s.dismissCard);
  return (
    <button
      type="button"
      data-testid="card-dismiss"
      aria-label="Clear card from chat"
      title="Clear card from chat"
      onClick={() => void dismissCard(cardId)}
      className="-mr-1 shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:bg-raised hover:text-fg focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/** `onCollapse`: the card was handled and you opened it from its one-line receipt; this folds it back. */
export function Shell({ tone = "border-line", icon, title, right, children, testId, cardId, onCollapse }: { tone?: string; icon?: ReactNode; title: ReactNode; right?: ReactNode; children?: ReactNode; testId: string; cardId: string; onCollapse?: (() => void) | undefined }) {
  return (
    <div className={`group/card rounded-lg border ${tone} bg-panel px-3.5 py-2.5 text-sm`} data-testid={testId} data-card-id={cardId}>
      <div className="flex items-center gap-2">
        {icon}
        <div className="min-w-0 flex-1 truncate font-medium">{title}</div>
        {right}
        <CardTime cardId={cardId} />
        {onCollapse && (
          <button
            type="button"
            data-testid="card-collapse"
            aria-expanded={true}
            aria-label="Fold back to one line"
            title="Fold back to one line"
            onClick={onCollapse}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-raised hover:text-fg"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        )}
        <DismissButton cardId={cardId} />
      </div>
      {children}
    </div>
  );
}

/**
 * A handled card (answered, decided, started, dismissed or no longer waiting) as one line, so what still needs you
 * stands out (docs/chat-declutter-proposal.md, option 1). It keeps the card's test id and `data-card-id`, so a jump to
 * the card still lands here. `summary` says what happened; `actions` sit at the end of the line; `extras` (a follow-up
 * such as "Always allow this") go under it. A click on the line opens the whole card.
 */
export function Receipt({ testId, cardId, icon, shortId, title, summary, actions, extras, onExpand }: { testId: string; cardId: string; icon: ReactNode; shortId?: string | undefined; title: ReactNode; summary: ReactNode; actions?: ReactNode; extras?: ReactNode; onExpand: () => void }) {
  return (
    <div className="group/card rounded-md border border-line/60 bg-panel/50 px-3 py-1 text-xs" data-testid={testId} data-card-id={cardId} data-receipt="true">
      <div className="flex min-h-6 items-center gap-2">
        <button
          type="button"
          data-testid="receipt-expand"
          aria-expanded={false}
          title="Show the whole card"
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted hover:text-fg"
        >
          <span className="shrink-0">{icon}</span>
          {shortId && (
            <span className="shrink-0 whitespace-nowrap">
              <ShortId id={shortId} />
            </span>
          )}
          <span className="min-w-0 truncate">
            <span className="font-medium text-fg">{title}</span>
            <span> · </span>
            {summary}
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        {actions}
        <CardTime cardId={cardId} />
        <DismissButton cardId={cardId} />
      </div>
      {extras}
    </div>
  );
}

/** `primary`: filled, for the main action. `accent`: outlined in the accent colour, for a way in that shouldn't compete with it. */
export function Button({ onClick, children, primary, accent, testId, disabled, title, type = "button" }: { onClick?: () => void; children: ReactNode; primary?: boolean; accent?: boolean; testId?: string; disabled?: boolean; title?: string; type?: "button" | "submit" }) {
  const look = primary ? "bg-accent text-white hover:bg-accent/90" : accent ? "border border-accent/50 text-accent hover:border-accent hover:text-fg" : "border border-line text-muted hover:border-accent hover:text-fg";
  return (
    <button
      type={type}
      data-testid={testId}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  );
}

/** Markdown or a command as one plain line for a receipt: no heading, quote or emphasis marks, whitespace runs as one space. */
export function oneLine(text: string, max = 160): string {
  const flat = text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Escapes any invisible format or control characters (except \n and \t) as \uXXXX so a card can never visually disguise its payload. */
export function visibleJsonText(text: string): string {
  return text.replace(/[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

export function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}
