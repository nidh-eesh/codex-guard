import type { Sql } from "./rule-tables";
import type { ReviewResult } from "./review-types";

/** The `reviews` table (DESIGN.md §6, step 8). Creating it is idempotent. */
export function sqliteReviews(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'incomplete')),
    findings TEXT NOT NULL
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
    }
  };
}
