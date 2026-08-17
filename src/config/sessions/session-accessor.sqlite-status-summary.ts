import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { parseReadableSqliteSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

export type RecentSessionEntrySnapshot = {
  count: number;
  entries: SessionEntrySummary[];
};

/** Reads only the total count and newest rows needed by status surfaces. */
export function readRecentSessionEntrySnapshotReadOnly(
  scope: SessionEntryListScope & { limit: number },
): RecentSessionEntrySnapshot {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const db = getSessionKysely(database.db);
    const countRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select((expression) => expression.fn.countAll<number | bigint>().as("count"))
        .where("session_key", "not in", ["global", "unknown"])
        .where("session_key", "not like", "agent:%:internal-session-effects:%"),
    );
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["current_session_id", "entry_json", "session_key", "updated_at"])
        .where("session_key", "not in", ["global", "unknown"])
        .where("session_key", "not like", "agent:%:internal-session-effects:%")
        .orderBy("updated_at", "desc")
        .orderBy("session_key", "asc")
        .limit(Math.max(0, Math.floor(scope.limit))),
    ).rows;
    const entries = rows.flatMap((row) => {
      const entry = parseReadableSqliteSessionEntryRow(database, row);
      if (!entry) {
        return [];
      }
      const projected = scope.projection === "list" ? { ...entry } : entry;
      if (scope.projection === "list") {
        delete projected.skillsSnapshot;
        delete projected.systemPromptReport;
      }
      return [
        {
          sessionKey: row.session_key,
          entry: scope.clone === false ? projected : cloneSessionEntry(projected),
        },
      ];
    });
    return { count: countRow ? coerceSqliteNumber(countRow.count) : 0, entries };
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : { count: 0, entries: [] };
}
