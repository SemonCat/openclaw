import type { selectMainSessionRecoveryCheckpoint } from "../agents/main-session-recovery/main-session-recovery-checkpoint.js";
import type { McpAppReconstructionData, McpAppTranscriptLookup } from "./mcp-app-transcript.js";
import type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";

export type SessionTranscriptSummaryQuery =
  | { kind: "usage" }
  | { kind: "recovery-checkpoint" }
  | { kind: "yielded-recovery-runs"; runIds: string[]; notBefore: number }
  | { kind: "mcp-app"; lookup: McpAppTranscriptLookup };

export type SessionTranscriptSummaryResult =
  | { kind: "usage"; usage: SessionTranscriptUsageSnapshot | null }
  | { kind: "yielded-recovery-runs"; yieldedRunIds: string[] }
  | {
      kind: "recovery-checkpoint";
      checkpoint: ReturnType<typeof selectMainSessionRecoveryCheckpoint>;
    }
  | { kind: "mcp-app"; data: McpAppReconstructionData | undefined };

type TranscriptVisit = (visit: (message: unknown) => void) => void;

/** Load domain policy before opening the snapshot; only compact facts cross the worker boundary. */
export async function prepareSessionTranscriptSummaryReader(
  query: SessionTranscriptSummaryQuery,
): Promise<(visit: TranscriptVisit) => SessionTranscriptSummaryResult> {
  if (query.kind === "yielded-recovery-runs") {
    const { selectMainSessionYieldedRuns } =
      await import("../agents/main-session-recovery/main-session-recovery-checkpoint.js");
    return (visit) => ({
      kind: "yielded-recovery-runs",
      yieldedRunIds: selectMainSessionYieldedRuns(visit, query.runIds, query.notBefore),
    });
  }
  if (query.kind === "recovery-checkpoint") {
    const { selectMainSessionRecoveryCheckpoint } =
      await import("../agents/main-session-recovery/main-session-recovery-checkpoint.js");
    return (visit) => ({
      kind: "recovery-checkpoint",
      checkpoint: selectMainSessionRecoveryCheckpoint(visit),
    });
  }
  if (query.kind === "mcp-app") {
    const { selectMcpAppReconstructionData } = await import("./mcp-app-transcript.js");
    return (visit) => ({
      kind: "mcp-app",
      data: selectMcpAppReconstructionData(visit, query.lookup),
    });
  }
  const { createSessionTranscriptUsageAccumulator } =
    await import("./session-transcript-derived-readers.js");
  return (visit) => {
    const usage = createSessionTranscriptUsageAccumulator();
    visit(usage.add);
    return { kind: "usage", usage: usage.finish() };
  };
}
