/** The day's review budget (D12); the rest of the Free plan's 10,000 is for chat. */
export const DAILY_REVIEW_NEURONS = 8_000;

export const DAILY_LIMIT_MESSAGE =
  "The daily review limit has been reached. Try again tomorrow.";

/** A review refused because the day's budget can't cover its worst case. */
export class DailyLimitError extends Error {}

/** One day's spend and open reservations. NeuronBudget keeps it in SQLite. */
export interface BudgetLedger {
  spent(): number;
  reservedTotal(): number;
  reservation(reviewId: string): number | undefined;
  addReservation(reviewId: string, neurons: number): void;
  removeReservation(reviewId: string): void;
  addSpent(neurons: number): void;
}

/** The budget's key: the UTC date, so each day starts afresh. */
export function budgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserves a review's worst case. False when what's spent, what's reserved
 * and this reservation would pass the cap. Reserving the same review again
 * succeeds without counting twice.
 */
export function reserveBudget(
  ledger: BudgetLedger,
  reviewId: string,
  neurons: number,
  cap: number = DAILY_REVIEW_NEURONS
): boolean {
  if (ledger.reservation(reviewId) !== undefined) return true;
  if (ledger.spent() + ledger.reservedTotal() + neurons > cap) return false;
  ledger.addReservation(reviewId, neurons);
  return true;
}

/**
 * Replaces a review's reservation with what the review really cost, which
 * can be more (retries) or less. Settling a review twice, or one that was
 * never reserved, changes nothing.
 */
export function settleBudget(
  ledger: BudgetLedger,
  reviewId: string,
  neurons: number
): void {
  if (ledger.reservation(reviewId) === undefined) return;
  ledger.removeReservation(reviewId);
  ledger.addSpent(neurons);
}
