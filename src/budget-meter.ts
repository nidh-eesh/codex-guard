import { budgetDay, type BudgetLeft } from "./budget-ledger";

/**
 * The shared budget meter as agent state: what's left today, pushed when a
 * workspace connects, after a review settles and after a chat turn. Nothing
 * polls it, so it can be a little behind other workspaces' use.
 */
export interface BudgetMeter extends BudgetLeft {
  /** The UTC date the percentages are for. */
  day: string;
}

export function budgetMeterText(meter: BudgetMeter): string {
  return `Shared AI budget today: reviews ${meter.reviews}% chat ${meter.chat}% left resets 05:30 IST (00:00 UTC)`;
}

/**
 * The meter while it's for today's budget. After 00:00 UTC it describes
 * yesterday, so it's hidden until the next push.
 */
export function currentMeter(
  meter: BudgetMeter | null | undefined,
  now: Date
): BudgetMeter | null {
  return meter && meter.day === budgetDay(now) ? meter : null;
}

/** Below this share left, the page shows a budget as running low. */
export const LOW_BUDGET_PERCENT = 20;

export type MeterTone = "ok" | "low" | "empty";

/** How the page colours one budget's bar. */
export function meterTone(percent: number): MeterTone {
  if (percent <= 0) return "empty";
  if (percent < LOW_BUDGET_PERCENT) return "low";
  return "ok";
}
