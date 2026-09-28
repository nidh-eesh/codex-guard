import type { Sql } from "./rule-tables";
import type { ReviewResult } from "./review-types";

export interface Reservation {
  /** The UTC date whose budget holds the reservation. */
  day: string;
  neurons: number;
}

/**
 * The `reviews` table (DESIGN.md §6, step 8), and each running review's
 * budget reservation (D12). Creating them is idempotent.
 */
export function sqliteReviews(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'incomplete')),
    findings TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS review_reservations (
    review_id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    neurons REAL NOT NULL
  )`;

  return {
    /**
     * Stores a review under its workflow instance ID. Returns false if that
     * ID is already stored, so a repeated completion callback is a no-op.
     */
    insert(id: string, createdAt: number, result: ReviewResult): boolean {
      if (sql`SELECT 1 FROM reviews WHERE id = ${id}`.length > 0) return false;
      sql`INSERT INTO reviews (id, created_at, verdict, findings)
        VALUES (${id}, ${createdAt}, ${result.verdict}, ${JSON.stringify(result.findings)})`;
      return true;
    },

    /** Remembers which day's budget a running review reserved against. */
    saveReservation(reviewId: string, { day, neurons }: Reservation): void {
      sql`INSERT OR REPLACE INTO review_reservations (review_id, day, neurons)
        VALUES (${reviewId}, ${day}, ${neurons})`;
    },

    reservation(reviewId: string): Reservation | undefined {
      return sql<Reservation>`SELECT day, neurons FROM review_reservations
        WHERE review_id = ${reviewId}`[0];
    },

    deleteReservation(reviewId: string): void {
      sql`DELETE FROM review_reservations WHERE review_id = ${reviewId}`;
    }
  };
}
