import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { isMainRestartRecoveryCandidate } from "../../config/sessions/restart-recovery-state.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionStoreIdentity } from "../../gateway/session-store-key.js";
import { readSessionTranscriptSummaryAsync } from "../../gateway/session-transcript-readers.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  classifySessionKeyShape,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

type RestartRecoveryDispatchParams = {
  agentId?: string;
  storeAgentId?: string;
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
};

type RestartRecoveryDispatchTarget = { agentId: string; sessionKey: string };

function resolveRestartRecoveryStoreAgentId(params: RestartRecoveryDispatchParams) {
  // Expected targets and discovered agent partitions carry their execution owner.
  // A shared SQLite store's schema owner must never override its logical session route.
  return (
    params.agentId ??
    (params.storeAgentId &&
    !resolveSqliteTargetFromSessionStorePath(params.storePath, { agentId: params.storeAgentId })
      .shared
      ? params.storeAgentId
      : undefined) ??
    (isPerAgentSessionStoreConfig(params.cfg?.session?.store) &&
    classifySessionKeyShape(params.sessionKey) === "legacy_or_alias"
      ? resolveUnsuffixedSqliteTargetFromSessionStorePath(params.storePath).agentId
      : undefined)
  );
}

/** An unconfigured writer already owns its physical store and only needs the logical route. */
export function resolveRestartRecoveryDispatchIdentity(
  params: Omit<RestartRecoveryDispatchParams, "cfg">,
): RestartRecoveryDispatchTarget {
  return {
    agentId:
      params.agentId ??
      resolveAgentIdFromSessionKey(
        params.sessionKey,
        resolveRestartRecoveryStoreAgentId(params) ?? LEGACY_IMPLICIT_AGENT_ID,
      ),
    sessionKey: params.sessionKey,
  };
}

export async function resolveRestartRecoveryDispatchTarget(
  params: RestartRecoveryDispatchParams,
): Promise<RestartRecoveryDispatchTarget | undefined> {
  if (!params.cfg) {
    return resolveRestartRecoveryDispatchIdentity(params);
  }
  const storeAgentId = resolveRestartRecoveryStoreAgentId(params);
  try {
    const target = resolveSessionStoreIdentity({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      ...(storeAgentId ? { agentId: storeAgentId } : {}),
    });
    return !params.cfg.session?.store ||
      path.resolve(
        resolveSessionStorePathCore(params.cfg.session.store, { agentId: target.agentId }),
      ) === path.resolve(params.storePath)
      ? { agentId: target.agentId, sessionKey: target.canonicalKey }
      : undefined;
  } catch (err) {
    mainSessionRecoveryLog.warn(
      `failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`,
    );
    return undefined;
  }
}

/** Captures the durable continuation that a completed requester turn yielded to. */
export function captureYieldedMainSessionContinuation(params: {
  entry: SessionEntry;
  requester: RestartRecoveryDispatchTarget | undefined;
}): (() => boolean) | undefined {
  // A prepared final may not have reached its queue yet; main recovery still owns that debt.
  if (
    params.entry.status !== undefined ||
    params.entry.pendingFinalDelivery !== undefined ||
    asFiniteNumber(params.entry.endedAt) === undefined
  ) {
    return undefined;
  }
  const requester = params.requester;
  if (!requester) {
    return undefined;
  }
  const listRuns = () =>
    listSubagentRunsForRequester(requester.sessionKey, {
      requesterAgentId: requester.agentId,
    });
  const owner = listRuns().find(
    (run) =>
      !run.collect &&
      run.expectsCompletionMessage === true &&
      !run.requesterTurnRunId &&
      run.requesterSettleWake?.requesterYieldBatch === true &&
      run.requesterSettleWake.rearmGeneration !== undefined &&
      run.requesterSettleWake.batchRunIds?.includes(run.runId),
  );
  if (!owner) {
    return undefined;
  }
  // The wake is pending/dispatching debt; completion removes it even for an abandoned batch.
  // Child delivery alone does not settle the visible final owed by a yielded requester.
  const wake = owner.requesterSettleWake;
  const rearmGeneration = wake?.rearmGeneration;
  return () =>
    listRuns().includes(owner) &&
    !owner.requesterTurnRunId &&
    owner.requesterSettleWake === wake &&
    wake?.rearmGeneration === rearmGeneration;
}

/** Reconcile older builds' yielded execution fence after its requester debt has settled. */
export async function prepareCompletedYieldedMainSessionReconciliation(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
}): Promise<
  { isCurrent: () => boolean; fences: NonNullable<SessionEntry["restartRecoveryRuns"]> } | undefined
> {
  const { entry } = params;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  if (
    !isMainRestartRecoveryCandidate(entry, params.sessionKey) ||
    entry.status !== "done" ||
    entry.abortedLastRun === true ||
    entry.lifecycleRunId !== undefined ||
    entry.mainRestartRecovery !== undefined ||
    entry.pendingFinalDelivery !== undefined ||
    entry.restartRecoveryDeliveryRunId !== undefined ||
    entry.restartRecoveryHarnessCompletion !== undefined ||
    !entry.lastRunId ||
    entry.activeWriterRunId !== entry.lastRunId
  ) {
    return undefined;
  }
  const requester = resolveRestartRecoveryDispatchIdentity(params);
  if (!entry.restartRecoveryRuns?.length || !requester) {
    return undefined;
  }
  const listRuns = () =>
    listSubagentRunsForRequester(requester.sessionKey, {
      requesterAgentId: requester.agentId,
    }).filter((run) => !run.collect && run.expectsCompletionMessage === true);
  const children = listRuns();
  // Legacy yield receipts lack an epoch. Only an unreplaced launch cohort in
  // the fence's exact epoch can corroborate it; a receipt before that cohort
  // started cannot retire a later same-ID execution.
  const childLifecycleGeneration = children[0]?.execution.lifecycleGeneration;
  const notBefore = Math.max(
    ...children.map((run) => asFiniteNumber(run.execution.startedAt) ?? Number.POSITIVE_INFINITY),
  );
  const fences = entry.restartRecoveryRuns.filter(
    (run) =>
      run.runId !== entry.lastRunId &&
      run.lifecycleGeneration === childLifecycleGeneration &&
      run.lifecycleGeneration !== lifecycleGeneration &&
      !hasLiveAgentRunContext(run.runId),
  );
  if (!fences.length || !Number.isFinite(notBefore)) {
    return undefined;
  }
  const isCurrent = () => {
    const current = listRuns();
    return (
      getAgentEventLifecycleGeneration() === lifecycleGeneration &&
      fences.every((fence) => !hasLiveAgentRunContext(fence.runId)) &&
      children.length > 0 &&
      current.length === children.length &&
      children.every(
        (run) =>
          current.includes(run) &&
          run.generation === 1 &&
          run.execution.lifecycleGeneration === childLifecycleGeneration &&
          typeof run.execution.startedAt === "number" &&
          Number.isFinite(run.execution.startedAt) &&
          run.execution.startedAt <= notBefore &&
          run.execution.status === "terminal" &&
          run.execution.endedAt !== undefined &&
          run.cleanupCompletedAt !== undefined &&
          run.delivery?.status === "delivered" &&
          !run.requesterTurnRunId &&
          !run.requesterSettleWake,
      )
    );
  };
  if (!isCurrent()) {
    return undefined;
  }
  const summary = await readSessionTranscriptSummaryAsync(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
    },
    { kind: "yielded-recovery-runs", runIds: fences.map((fence) => fence.runId), notBefore },
  );
  if (summary.kind !== "yielded-recovery-runs") {
    return undefined;
  }
  const proven = fences.filter((fence) => summary.yieldedRunIds.includes(fence.runId));
  return proven.length && isCurrent() ? { isCurrent, fences: proven } : undefined;
}
