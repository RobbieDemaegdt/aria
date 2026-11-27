import type { BudgetSettings, DailyBudgetState, EngineEvent, NoticeItem } from "@aria/protocol";
import type { Store } from "../store/store.ts";
import type { TimekeeperRunner } from "../timekeeper/session.ts";
import type { AttentionEvent } from "./attention.ts";
import type { Clock } from "./clock.ts";

export interface DailyBudgetDeps {
  db: () => Store;
  isOpen: () => boolean;
  clock: Clock;
  timekeeper: () => TimekeeperRunner | undefined;
  emit: (event: EngineEvent) => void;
  notice: (level: NoticeItem["level"], text: string, cause?: string) => void;
  digest: (line: string) => void;
  attention: (event: AttentionEvent) => void;
}

/** The daily AI credit budget: what you set, what today has used, and the warning and alert when it gets there. */
export class DailyBudget {
  constructor(private readonly deps: DailyBudgetDeps) {}

  private todayIso(): string {
    const timekeeper = this.deps.timekeeper();
    if (timekeeper) return timekeeper.todayIso();
    const clock = this.deps.clock;
    const d = new Date(clock.now());
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  budgetSettings(): BudgetSettings {
    const stored = this.deps.isOpen()
      ? this.deps.db().getSetting<{ dailyBudgetCredits?: number | null; budgetWarningPercent?: number }>("budget.settings")
      : undefined;
    const rawPct = stored?.budgetWarningPercent;
    const budgetWarningPercent =
      typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 50 && rawPct <= 99
        ? Math.round(rawPct)
        : 80;
    const rawDaily = stored?.dailyBudgetCredits;
    const dailyBudgetCredits =
      typeof rawDaily === "number" && Number.isFinite(rawDaily) && rawDaily > 0 ? rawDaily : null;
    return {
      dailyBudgetCredits,
      budgetWarningPercent,
    };
  }

  dailyBudgetState(): DailyBudgetState {
    const settings = this.budgetSettings();
    const date = this.todayIso();
    const stored = this.deps.isOpen()
      ? this.deps.db().getSetting<{ date?: string; usedNano?: number; warnedForCap?: number; alertedForCap?: number }>("budget.daily")
      : undefined;
    const usedNano =
      stored?.date === date && typeof stored.usedNano === "number" && Number.isFinite(stored.usedNano)
        ? Math.max(0, stored.usedNano)
        : 0;
    const usedCredits = Math.round(usedNano / 1e7) / 100;
    const cap = settings.dailyBudgetCredits;
    const warnPct = settings.budgetWarningPercent;
    const warningReached = Boolean(cap && cap > 0 && usedNano / 1e9 >= (cap * warnPct) / 100);
    const limitReached = Boolean(cap && cap > 0 && usedNano / 1e9 >= cap);
    return {
      date,
      usedCredits,
      dailyBudgetCredits: cap,
      budgetWarningPercent: warnPct,
      warningReached,
      limitReached,
    };
  }

  setBudgetSettings(patch: { dailyBudgetCredits?: number | null; budgetWarningPercent?: number }): DailyBudgetState {
    const current = this.budgetSettings();
    let dailyBudgetCredits = current.dailyBudgetCredits ?? null;
    if (patch.dailyBudgetCredits !== undefined) {
      if (patch.dailyBudgetCredits === null || patch.dailyBudgetCredits <= 0) {
        dailyBudgetCredits = null;
      } else {
        if (
          !Number.isFinite(patch.dailyBudgetCredits) ||
          patch.dailyBudgetCredits < 0.1 ||
          patch.dailyBudgetCredits > 100_000
        ) {
          throw new Error("Daily budget must be between 0.1 and 100,000 AI credits.");
        }
        dailyBudgetCredits = Math.round(patch.dailyBudgetCredits * 100) / 100;
      }
    }
    let budgetWarningPercent = current.budgetWarningPercent;
    if (patch.budgetWarningPercent !== undefined) {
      if (
        !Number.isFinite(patch.budgetWarningPercent) ||
        patch.budgetWarningPercent < 50 ||
        patch.budgetWarningPercent > 99
      ) {
        throw new Error("Budget warning threshold must be an integer between 50% and 99%.");
      }
      budgetWarningPercent = Math.round(patch.budgetWarningPercent);
    }
    this.deps.db().setSetting("budget.settings", { dailyBudgetCredits, budgetWarningPercent });
    const state = this.dailyBudgetState();
    this.deps.emit({ type: "budget", budget: state });
    return state;
  }

  recordDailyUsage(deltaNano: number): void {
    if (!this.deps.isOpen() || deltaNano <= 0) return;
    const settings = this.budgetSettings();
    const date = this.todayIso();
    const stored = this.deps.db().getSetting<{
      date?: string;
      usedNano?: number;
      warnedForCap?: number;
      alertedForCap?: number;
    }>("budget.daily");
    const isSameDay = stored?.date === date;
    const prevNano = isSameDay && typeof stored?.usedNano === "number" ? Math.max(0, stored.usedNano) : 0;
    const usedNano = prevNano + deltaNano;
    let warnedForCap = isSameDay ? stored?.warnedForCap : undefined;
    let alertedForCap = isSameDay ? stored?.alertedForCap : undefined;

    const cap = settings.dailyBudgetCredits;
    const warnPct = settings.budgetWarningPercent;
    const usedCredits = Math.round(usedNano / 1e7) / 100;

    let emitReached = false;
    let emitWarning = false;

    if (cap && cap > 0) {
      const warnThreshold = (cap * warnPct) / 100;
      if (usedNano / 1e9 >= cap && alertedForCap !== cap) {
        alertedForCap = cap;
        warnedForCap = cap;
        emitReached = true;
      } else if (usedNano / 1e9 < cap && usedNano / 1e9 >= warnThreshold && warnedForCap !== cap) {
        warnedForCap = cap;
        emitWarning = true;
      }
    }

    this.deps.db().setSetting("budget.daily", {
      date,
      usedNano,
      ...(warnedForCap !== undefined ? { warnedForCap } : {}),
      ...(alertedForCap !== undefined ? { alertedForCap } : {}),
    });

    if (emitReached && cap) {
      const msg = `Today's AI credit usage (${usedCredits} credits) has reached your daily budget of ${cap} credits.`;
      this.deps.notice("warning", msg, "daily_budget_reached");
      this.deps.digest(
        `[budget] Today's AI credit usage (${usedCredits} credits) reached your daily budget of ${cap} credits.`,
      );
      this.deps.attention({
        kind: "budget",
        title: "Daily AI credit budget reached",
        body: `Today's tasks used ${usedCredits} of ${cap} AI credits.`,
      });
    } else if (emitWarning && cap) {
      const msg = `Today's AI credit usage (${usedCredits} credits) has reached ${warnPct}% of your ${cap}-credit daily budget.`;
      this.deps.notice("warning", msg, "daily_budget_warning");
      this.deps.digest(
        `[budget] Today's AI credit usage (${usedCredits} credits) reached ${warnPct}% of your ${cap}-credit daily budget.`,
      );
    }

    this.deps.emit({ type: "budget", budget: this.dailyBudgetState() });
  }
}
