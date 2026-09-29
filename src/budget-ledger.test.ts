import { describe, expect, it } from "vitest";
import {
  assertReserved,
  budgetDay,
  budgetLeft,
  chatTurnAllowed,
  DAILY_CHAT_LIMIT_MESSAGE,
  DAILY_CHAT_NEURONS,
  DAILY_LIMIT_MESSAGE,
  DAILY_REVIEW_NEURONS,
  DailyLimitError,
  percentLeft,
  REVIEW_BUSY_MESSAGE,
  reserveBudget,
  ReviewBusyError,
  settleBudget,
  type BudgetLedger
} from "./budget-ledger";

function memoryLedger(spent = 0, chatSpent = 0) {
  const state = { spent, chatSpent, reservations: new Map<string, number>() };
  const ledger: BudgetLedger = {
    spent: () => state.spent,
    reservedTotal: () =>
      [...state.reservations.values()].reduce((sum, n) => sum + n, 0),
    reservation: (id) => state.reservations.get(id),
    addReservation: (id, neurons) => void state.reservations.set(id, neurons),
    removeReservation: (id) => void state.reservations.delete(id),
    addSpent: (neurons) => void (state.spent += neurons),
    chatSpent: () => state.chatSpent,
    addChatSpent: (neurons) => void (state.chatSpent += neurons)
  };
  return { ledger, state };
}

describe("reserveBudget", () => {
  it("reserves while spent and reserved stay within the cap", () => {
    const { ledger, state } = memoryLedger(1_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe("reserved");
    expect(state.reservations.get("r1")).toBe(3_000);
  });

  it("allows a reservation that reaches the cap exactly", () => {
    const { ledger } = memoryLedger(5_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe("reserved");
  });

  it("is busy when running reservations hold the room it needs", () => {
    const { ledger, state } = memoryLedger(4_000);
    reserveBudget(ledger, "r1", 3_000, 8_000);
    expect(reserveBudget(ledger, "r2", 1_001, 8_000)).toBe("busy");
    expect(state.reservations.has("r2")).toBe(false);
  });

  it("is busy, not full, when it would reach the cap exactly once they settle", () => {
    const { ledger } = memoryLedger(5_000);
    reserveBudget(ledger, "r1", 2_000, 8_000);
    expect(reserveBudget(ledger, "r2", 3_000, 8_000)).toBe("busy");
  });

  it("is full when what's spent leaves no room, reservations or not", () => {
    expect(reserveBudget(memoryLedger(7_000).ledger, "r1", 1_001, 8_000)).toBe(
      "full"
    );
    const { ledger, state } = memoryLedger(7_000);
    reserveBudget(ledger, "r1", 500, 8_000);
    expect(reserveBudget(ledger, "r2", 1_001, 8_000)).toBe("full");
    expect(state.reservations.has("r2")).toBe(false);
  });

  it("makes a second largest review wait for the first (D24)", () => {
    const { ledger } = memoryLedger();
    expect(reserveBudget(ledger, "r1", 3_200)).toBe("reserved");
    expect(reserveBudget(ledger, "r2", 3_200)).toBe("busy");
  });

  it("counts a review reserved twice only once", () => {
    const { ledger } = memoryLedger();
    reserveBudget(ledger, "r1", 3_000, 8_000);
    expect(reserveBudget(ledger, "r1", 3_000, 8_000)).toBe("reserved");
    expect(ledger.reservedTotal()).toBe(3_000);
  });

  it("allows a review that costs nothing, even with the budget spent", () => {
    const { ledger } = memoryLedger(8_000);
    expect(reserveBudget(ledger, "r1", 0, 8_000)).toBe("reserved");
  });

  it("uses the 6,000-neuron daily budget by default (D12)", () => {
    expect(DAILY_REVIEW_NEURONS).toBe(6_000);
    const { ledger } = memoryLedger(5_999);
    expect(reserveBudget(ledger, "r1", 2)).toBe("full");
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
    expect(reserveBudget(ledger, "r2", 2_000, 8_000)).toBe("busy");
    settleBudget(ledger, "r1", 1_000);
    expect(reserveBudget(ledger, "r2", 2_000, 8_000)).toBe("reserved");
  });
});

describe("assertReserved", () => {
  it("lets a reserved review through", () => {
    expect(() => assertReserved("reserved")).not.toThrow();
  });

  it("refuses a busy review with the DESIGN.md §5 message", () => {
    expect(() => assertReserved("busy")).toThrow(ReviewBusyError);
    expect(() => assertReserved("busy")).toThrow(REVIEW_BUSY_MESSAGE);
  });

  it("refuses a review over the daily limit with its message", () => {
    expect(() => assertReserved("full")).toThrow(DailyLimitError);
    expect(() => assertReserved("full")).toThrow(DAILY_LIMIT_MESSAGE);
  });
});

describe("chatTurnAllowed (D26)", () => {
  it("lets a turn start while the chat spend is under the cap", () => {
    expect(chatTurnAllowed(memoryLedger(0, 1_999).ledger, 2_000)).toBe(true);
  });

  it("refuses once the chat spend reaches the cap", () => {
    expect(chatTurnAllowed(memoryLedger(0, 2_000).ledger, 2_000)).toBe(false);
    expect(chatTurnAllowed(memoryLedger(0, 2_600).ledger, 2_000)).toBe(false);
  });

  it("isn't blocked by reviews using their whole budget", () => {
    const { ledger } = memoryLedger(7_000);
    reserveBudget(ledger, "r1", 1_000, 8_000);
    expect(chatTurnAllowed(ledger, 2_000)).toBe(true);
  });

  it("doesn't take room from reviews", () => {
    const { ledger } = memoryLedger(0, 2_000);
    expect(reserveBudget(ledger, "r1", 8_000, 8_000)).toBe("reserved");
  });

  it("uses the 3,000-neuron daily chat budget by default", () => {
    expect(DAILY_CHAT_NEURONS).toBe(3_000);
    expect(chatTurnAllowed(memoryLedger(0, 2_999.5).ledger)).toBe(true);
    expect(chatTurnAllowed(memoryLedger(0, 3_000).ledger)).toBe(false);
  });

  it("leaves 1,000 of the Free plan's 10,000 for overshoot and testing", () => {
    expect(DAILY_REVIEW_NEURONS + DAILY_CHAT_NEURONS).toBe(9_000);
  });
});

describe("percentLeft", () => {
  it("is 100 before anything is used, and 0 at the cap", () => {
    expect(percentLeft(0, 6_000)).toBe(100);
    expect(percentLeft(6_000, 6_000)).toBe(0);
  });

  it("rounds down, so it never shows more than is left", () => {
    expect(percentLeft(1, 6_000)).toBe(99);
    expect(percentLeft(5_999, 6_000)).toBe(0);
    expect(percentLeft(1_500, 6_000)).toBe(75);
  });

  it("is 0, not negative, when spend has passed the cap", () => {
    expect(percentLeft(6_500, 6_000)).toBe(0);
  });
});

describe("budgetLeft", () => {
  it("counts running reviews' reservations as used", () => {
    const { ledger } = memoryLedger(600);
    reserveBudget(ledger, "r1", 900, 6_000);
    expect(budgetLeft(ledger, 6_000, 3_000).reviews).toBe(75);
  });

  it("gives the room back when a review settles below its reservation", () => {
    const { ledger } = memoryLedger();
    reserveBudget(ledger, "r1", 3_000, 6_000);
    expect(budgetLeft(ledger, 6_000, 3_000).reviews).toBe(50);
    settleBudget(ledger, "r1", 300);
    expect(budgetLeft(ledger, 6_000, 3_000).reviews).toBe(95);
  });

  it("reports chat apart from reviews", () => {
    const { ledger } = memoryLedger(6_000, 750);
    expect(budgetLeft(ledger, 6_000, 3_000)).toEqual({ reviews: 0, chat: 75 });
  });

  it("uses the day's caps by default", () => {
    expect(budgetLeft(memoryLedger(600, 300).ledger)).toEqual({
      reviews: 90,
      chat: 90
    });
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

it("refuses a chat turn with the DESIGN.md §5 message", () => {
  expect(DAILY_CHAT_LIMIT_MESSAGE).toBe(
    "The daily chat limit has been reached. Try again tomorrow."
  );
});

it("refuses a busy review with the DESIGN.md §5 message", () => {
  expect(REVIEW_BUSY_MESSAGE).toBe(
    "Another review is running. Try again in a few minutes."
  );
});
