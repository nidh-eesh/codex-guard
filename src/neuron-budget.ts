import { DurableObject } from "cloudflare:workers";
import {
  reserveBudget,
  settleBudget,
  type BudgetLedger
} from "./budget-ledger";

/**
 * One day's review budget (D12). There is one instance per UTC date, named
 * by it, so each day starts afresh. A plain Durable Object, not an Agent: it
 * has no fetch handler, the router refuses every agent namespace but the
 * chat agent's, and only the chat agent calls it, over RPC.
 */
export class NeuronBudget extends DurableObject<Env> {
  private readonly ledger: BudgetLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      review_id TEXT PRIMARY KEY,
      neurons REAL NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS spent (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      neurons REAL NOT NULL
    )`);
    sql.exec("INSERT OR IGNORE INTO spent (id, neurons) VALUES (1, 0)");

    // Synchronous SQL: each reserve or settle reads and writes without
    // yielding, so two reviews can't both take the last of the budget
    this.ledger = {
      spent: () =>
        sql
          .exec<{ neurons: number }>("SELECT neurons FROM spent WHERE id = 1")
          .one().neurons,
      reservedTotal: () =>
        sql
          .exec<{ total: number }>(
            "SELECT COALESCE(SUM(neurons), 0) AS total FROM reservations"
          )
          .one().total,
      reservation: (reviewId) =>
        sql
          .exec<{ neurons: number }>(
            "SELECT neurons FROM reservations WHERE review_id = ?",
            reviewId
          )
          .toArray()[0]?.neurons,
      addReservation: (reviewId, neurons) => {
        sql.exec(
          "INSERT INTO reservations (review_id, neurons) VALUES (?, ?)",
          reviewId,
          neurons
        );
      },
      removeReservation: (reviewId) => {
        sql.exec("DELETE FROM reservations WHERE review_id = ?", reviewId);
      },
      addSpent: (neurons) => {
        sql.exec(
          "UPDATE spent SET neurons = neurons + ? WHERE id = 1",
          neurons
        );
      }
    };
  }

  reserve(reviewId: string, neurons: number): boolean {
    return reserveBudget(this.ledger, reviewId, neurons);
  }

  settle(reviewId: string, neurons: number): void {
    settleBudget(this.ledger, reviewId, neurons);
  }
}
