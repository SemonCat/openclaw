import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { readRecentSessionEntrySnapshotReadOnly } from "./session-accessor.sqlite-status-summary.js";

describe("readRecentSessionEntrySnapshotReadOnly", () => {
  afterEach(() => closeOpenClawAgentDatabasesForTest());

  it("counts all visible rows while materializing only the newest requested entries", async () => {
    await withTestDir({ prefix: "openclaw-session-status-summary-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const now = Date.now();
      for (let index = 1; index <= 5; index += 1) {
        await replaceSessionEntry(
          { agentId: "main", storePath, sessionKey: `agent:main:session-${index}` },
          {
            sessionId: `session-${index}`,
            updatedAt: now + index,
            skillsSnapshot: { prompt: `large-${index}` } as never,
          },
        );
      }
      closeOpenClawAgentDatabasesForTest();

      const snapshot = readRecentSessionEntrySnapshotReadOnly({
        agentId: "main",
        storePath,
        clone: false,
        projection: "list",
        limit: 3,
      });

      expect(snapshot.count).toBe(5);
      expect(snapshot.entries.map(({ sessionKey }) => sessionKey)).toEqual([
        "agent:main:session-5",
        "agent:main:session-4",
        "agent:main:session-3",
      ]);
      expect(snapshot.entries[0]?.entry.skillsSnapshot).toBeUndefined();
    });
  });
});
