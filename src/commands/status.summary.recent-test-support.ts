type EntrySummary = { sessionKey: string; entry: Record<string, unknown> };

export function buildRecentSessionEntrySnapshot(
  listEntries: (scope?: { agentId?: string; storePath?: string }) => EntrySummary[],
  scope: { agentId?: string; limit: number; storePath?: string },
) {
  const entries = listEntries({
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  }).toSorted(
    (left, right) => Number(right.entry.updatedAt ?? 0) - Number(left.entry.updatedAt ?? 0),
  );
  return { count: entries.length, entries: entries.slice(0, scope.limit) };
}
