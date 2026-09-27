import type { RuleTables } from "./rule-changes";
import type { CustomRule, DisabledDefault } from "./rules";

type SqlValue = string | number | boolean | null;

/** The agent's `this.sql` tagged template. */
export type Sql = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
) => T[];

/**
 * The rule tables in the agent's SQLite database, the source of truth for
 * rules (DESIGN.md §3). Creating them is idempotent.
 */
export function sqliteRuleTables(sql: Sql): RuleTables {
  // The 'c_' check repeats CUSTOM_RULE_ID_PREFIX; DDL can't take parameters
  sql`CREATE TABLE IF NOT EXISTS custom_rules (
    id TEXT PRIMARY KEY CHECK (substr(id, 1, 2) = 'c_'),
    text TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
    created_at INTEGER NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS disabled_defaults (
    rule_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    rule_text TEXT NOT NULL,
    disabled_at INTEGER NOT NULL
  )`;

  return {
    customRules: () => sql<CustomRule>`
      SELECT id, text, severity, created_at AS createdAt
      FROM custom_rules
      ORDER BY created_at, id`,
    disabledDefaults: () => sql<DisabledDefault>`
      SELECT rule_id AS ruleId, reason, rule_text AS ruleText,
        disabled_at AS disabledAt
      FROM disabled_defaults`,
    insertCustomRule: (rule) => {
      sql`INSERT INTO custom_rules (id, text, severity, created_at)
        VALUES (${rule.id}, ${rule.text}, ${rule.severity}, ${rule.createdAt})`;
    },
    deleteCustomRule: (id) => {
      sql`DELETE FROM custom_rules WHERE id = ${id}`;
    },
    insertDisabledDefault: (row) => {
      sql`INSERT INTO disabled_defaults (rule_id, reason, rule_text, disabled_at)
        VALUES (${row.ruleId}, ${row.reason}, ${row.ruleText}, ${row.disabledAt})`;
    },
    deleteDisabledDefault: (ruleId) => {
      sql`DELETE FROM disabled_defaults WHERE rule_id = ${ruleId}`;
    }
  };
}
