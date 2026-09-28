import { describe, expect, it } from "vitest";
import {
  budgetDay,
  DAILY_LIMIT_MESSAGE,
  DAILY_REVIEW_NEURONS,
  reserveBudget,
  settleBudget,
  type BudgetLedger
} from "./budget-ledger";

function memoryLedger(spent = 0) {
  const state = { spent, reservations: new Map<string, number>() };
  const ledger: BudgetLedger = {
    spent: () => state.spent,
    reservedTotal: () =>
      [...state.reservations.values()].reduce((sum, n) => sum + n, 0),
    reservation: (id) => state.reservations.get(id),
    addReservation: (id, neurons) => void state.reservations.set(id, neurons),
    removeReservation: (id) => void state.reservations.delete(id),
    addSpent: (neurons) => void (state.spent += neurons)
  };
  return { ledger, state };
}

describe("reserveBudget", () => {
  it("reserves while spent and reserved stay within the cap", () => {
    const { ledger, state } = memoryLedger(1_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe(true);
    expect(state.reservations.get("r1")).toBe(3_000);
  });

  it("allows a reservation that reaches the cap exactly", () => {
    const { ledger } = memoryLedger(5_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe(true);
  });

  it("refuses one that would pass the cap, counting spent and reserved", () => {
    const { ledger, state } = memoryLedger(4_000);
    reserveBudget(ledger, "r1", 3_000, 8_000);
    expect(reserveBudget(ledger, "r2", 1_001, 8_000)).toBe(false);
    expect(state.reservations.has("r2")).toBe(false);
  });

  it("counts a review reserved twice only once", () => {
    const { ledger } = memoryLedger();
    reserveBudget(ledger, "r1", 3_000, 8_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe(true);
    expect(ledger.reservedTotal()).toBe(3_000);
  });

  it("allows a review that costs nothing, even with the budget spent", () => {
    const { ledger } = memoryLedger(8_000);
    expect(reserveBudget(ledger, "r1", 0, 8_000)).toBe(true);
  });

  it("uses the 8,000-neuron daily budget by default (D12)", () => {
    expect(DAILY_REVIEW_NEURONS).toBe(8_000);
    const { ledger } = memoryLedger(7_999);
    expect(reserveBudget(ledger, "r1", 2)).toBe(false);
  });
});

describe("settleBudget", () => {
  it("replaces the reservation with the real cost", () => {
    const { ledger, state } = memoryLedger(100);
    reserveBudget(ledger, "r1", 3_000, 8_000);
    settleBudget(ledger, "r1", 1_100);
    expect(state.reservations.has("r1")).toBe(false);
    expect(state.spent).toBe(1_200);
  });

  it("records a cost above the reservation (retries)", () => {
    const { ledger, state } = memoryLedger();
    reserveBudget(ledger, "r1", 1_000, 8_000);
    settleBudget(ledger, "r1", 2_500);
    expect(state.spent).toBe(2_500);
  });

  it("ignores a second settle of the same review", () => {
    const { ledger, state } = memoryLedger();
    reserveBudget(ledger, "r1", 3_000, 8_000);
    settleBudget(ledger, "r1", 1_000);
    settleBudget(ledger, "r1", 1_000);
    expect(state.spent).toBe(1_000);
  });

  it("ignores a review that was never reserved", () => {
    const { ledger, state } = memoryLedger();
    settleBudget(ledger, "unknown", 500);
    expect(state.spent).toBe(0);
  });

  it("frees the reserved room for the next review", () => {
    const { ledger } = memoryLedger();
    reserveBudget(ledger, "r1", 7_000, 8_000);
    expect(reserveBudget(ledger, "r2", 2_000, 8_000)).toBe(false);
    settleBudget(ledger, "r1", 1_000);
    expect(reserveBudget(ledger, "r2", 2_000, 8_000)).toBe(true);
  });
});

describe("budgetDay", () => {
  it("is the UTC date, whatever the local time zone", () => {
    expect(budgetDay(new Date("2026-09-28T23:59:59Z"))).toBe("2026-09-28");
    expect(budgetDay(new Date("2026-09-29T00:00:00Z"))).toBe("2026-09-29");
  });
});

it("refuses with the DESIGN.md §5 message", () => {
  expect(DAILY_LIMIT_MESSAGE).toBe(
    "The daily review limit has been reached. Try again tomorrow."
  );
});
