/**
 * The day's budgets (D12, D26). Of the Free plan's 10,000 neurons, the 1,000
 * left over absorb overshoot (D24, D26) and the author's own testing: evals
 * and local dev use Workers AI too, and nothing here counts them.
 */
export const DAILY_REVIEW_NEURONS = 6_000;
export const DAILY_CHAT_NEURONS = 3_000;

export const DAILY_LIMIT_MESSAGE =
  "The daily review limit has been reached. Try again tomorrow.";

export const DAILY_CHAT_LIMIT_MESSAGE =
  "The daily chat limit has been reached. Try again tomorrow.";

export const REVIEW_BUSY_MESSAGE =
  "Another review is running. Try again in a few minutes.";

/** A review refused because the day's budget can't cover its worst case. */
export class DailyLimitError extends Error {}

/** A review refused because running reviews hold the room it needs (D24). */
export class ReviewBusyError extends Error {}

/**
 * What reserving a review did. `busy`: what's spent leaves room, but the
 * running reviews' reservations don't, so it would fit once they settle
 * (reviews usually settle well below what they reserve). `full`: what's
 * spent leaves no room today.
 */
export type ReserveOutcome = "reserved" | "busy" | "full";

/** One day's spend and open reservations. NeuronBudget keeps it in SQLite. */
export interface BudgetLedger {
  spent(): number;
  reservedTotal(): number;
  reservation(reviewId: string): number | undefined;
  addReservation(reviewId: string, neurons: number): void;
  removeReservation(reviewId: string): void;
  addSpent(neurons: number): void;
  /** Chat spend, kept apart from reviews: neither can use up the other's. */
  chatSpent(): number;
  addChatSpent(neurons: number): void;
}

/** The budget's key: the UTC date, so each day starts afresh. */
export function budgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserves a review's worst case, unless what's spent, what's reserved and
 * this reservation would pass the cap. Reserving the same review again
 * succeeds without counting twice.
 */
export function reserveBudget(
  ledger: BudgetLedger,
  reviewId: string,
  neurons: number,
  cap: number = DAILY_REVIEW_NEURONS
): ReserveOutcome {
  if (ledger.reservation(reviewId) !== undefined) return "reserved";
  const spent = ledger.spent();
  if (spent + neurons > cap) return "full";
  if (spent + ledger.reservedTotal() + neurons > cap) return "busy";
  ledger.addReservation(reviewId, neurons);
  return "reserved";
}

/** Throws the DESIGN.md §5 refusal for a review the budget didn't reserve. */
export function assertReserved(outcome: ReserveOutcome): void {
  if (outcome === "busy") throw new ReviewBusyError(REVIEW_BUSY_MESSAGE);
  if (outcome === "full") throw new DailyLimitError(DAILY_LIMIT_MESSAGE);
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

/**
 * Whether a new chat turn may start (D26). A turn's cost is known only once
 * it ends, so nothing is reserved: turns start while the day's chat spend is
 * under the cap, and each is charged after it finishes.
 */
export function chatTurnAllowed(
  ledger: BudgetLedger,
  cap: number = DAILY_CHAT_NEURONS
): boolean {
  return ledger.chatSpent() < cap;
}

/** What's left of the day's budgets, in whole percent, for the meter. */
export interface BudgetLeft {
  reviews: number;
  chat: number;
}

/**
 * The percentage of `cap` left after `used`, rounded down so the meter never
 * shows more than is left, and between 0 and 100 (spend can pass the cap).
 */
export function percentLeft(used: number, cap: number): number {
  return Math.min(100, Math.max(0, Math.floor(((cap - used) * 100) / cap)));
}

/**
 * What's left of each budget. Running reviews' reservations count as used:
 * that room isn't available to the next review until they settle.
 */
export function budgetLeft(
  ledger: BudgetLedger,
  reviewCap: number = DAILY_REVIEW_NEURONS,
  chatCap: number = DAILY_CHAT_NEURONS
): BudgetLeft {
  return {
    reviews: percentLeft(ledger.spent() + ledger.reservedTotal(), reviewCap),
    chat: percentLeft(ledger.chatSpent(), chatCap)
  };
}
