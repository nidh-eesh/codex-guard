import { describe, expect, it } from "vitest";
import {
  budgetMeterText,
  currentMeter,
  meterTone,
  type BudgetMeter
} from "./budget-meter";

const meter: BudgetMeter = { day: "2026-09-29", reviews: 94, chat: 100 };

describe("budgetMeterText", () => {
  it("shows both percentages and when the budget resets", () => {
    expect(budgetMeterText(meter)).toBe(
      "Shared AI budget today: reviews 94% chat 100% left resets 05:30 IST (00:00 UTC)"
    );
  });
});

describe("currentMeter", () => {
  it("shows the meter on the UTC day it was pushed", () => {
    expect(currentMeter(meter, new Date("2026-09-29T23:59:59Z"))).toBe(meter);
  });

  it("hides it once the UTC day turns, whatever the local date", () => {
    // The budget resets at 00:00 UTC (05:30 IST); the old numbers are stale
    expect(currentMeter(meter, new Date("2026-09-30T00:00:00Z"))).toBeNull();
  });

  it("shows nothing before the first push, or from state saved before the meter existed", () => {
    expect(currentMeter(null, new Date("2026-09-29T12:00:00Z"))).toBeNull();
    expect(
      currentMeter(undefined, new Date("2026-09-29T12:00:00Z"))
    ).toBeNull();
  });
});

describe("meterTone", () => {
  it("is ok from 20% left up", () => {
    expect(meterTone(100)).toBe("ok");
    expect(meterTone(20)).toBe("ok");
  });

  it("is low under 20% left", () => {
    expect(meterTone(19)).toBe("low");
    expect(meterTone(1)).toBe("low");
  });

  it("is empty with nothing left", () => {
    expect(meterTone(0)).toBe("empty");
  });
});
