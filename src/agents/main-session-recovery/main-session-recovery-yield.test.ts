import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { recordLifecycleFence } from "../../config/sessions/restart-recovery-state.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
} from "./main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "./main-session-recovery-store.test-support.js";
import * as recoveryTarget from "./main-session-restart-recovery-target.js";

describe("yielded requester admission", () => {
  const sessionKey = "agent:main:main";
  let storePath: string;
  let lifecycleGeneration: string;
  const { fixtureStore, resetCase } = createMainSessionRecoveryStoreFixture();
  const write = (entry: SessionEntry) =>
    sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  const read = () => sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  const claimRecovery = (overrides: { runId?: string } = {}) =>
    claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
      ...overrides,
    });

  const child = createSubagentRunRecord({
    runId: "yielded-child",
    childSessionKey: "agent:main:subagent:yielded-child",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["yielded-child"],
    },
  });

  beforeEach(async () => {
    storePath = fixtureStore();
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    child.requesterTurnRunId = undefined;
    subagentRuns.set(child.runId, child);
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      abortedLastRun: false,
      endedAt: 1000,
      activeWriterRunId: "yielded-run",
      lifecycleRunId: "yielded-run",
      restartRecoveryRuns: [{ runId: "yielded-run", lifecycleGeneration }],
      restartRecoveryTerminalRunIds: ["previous-terminal-run"],
    });
  });

  afterEach(async () => {
    subagentRuns.delete(child.runId);
    clearAgentRunContext("yielded-run");
    vi.restoreAllMocks();
    await resetCase();
  });

  it.each(["current", "previous"])(
    "transfers a %s-generation yielded fence before admitting successive turns",
    async (generation) => {
      if (generation === "previous") {
        await write({
          ...read(),
          restartRecoveryRuns: [
            { runId: "yielded-run", lifecycleGeneration: "previous-generation" },
          ],
        });
      }
      await expect(claimRecovery({ runId: "settle-run" })).resolves.toMatchObject({
        kind: "not_required",
      });
      expect(read().restartRecoveryRuns).toBeUndefined();
      expect(subagentRuns.get(child.runId)).toBe(child);
      expect(child.requesterTurnRunId).toBeUndefined();
      expect(child.requesterSettleWake?.batchRunIds).toEqual([child.runId]);

      child.requesterTurnRunId = "settle-run";
      const started = read();
      recordLifecycleFence(started, { runId: "settle-run", lifecycleGeneration });
      await write(started);
      const settled = projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: lifecycleGeneration,
        entry: read(),
        event: { runId: "settle-run", lifecycleGeneration, data: { phase: "end" } },
        snapshotPatch: { status: "done", endedAt: 2000 },
      });
      expect(settled.action).toBe("apply");
      if (settled.action === "apply") {
        await write({ ...read(), ...settled.patch });
      }
      subagentRuns.delete(child.runId);
      await expect(claimRecovery({ runId: "later-user-run" })).resolves.toMatchObject({
        kind: "not_required",
      });
      expect(read().restartRecoveryRuns).toBeUndefined();
    },
  );

  it.each(["absent", "adopted"])("keeps fencing %s child custody", async (custody) => {
    if (custody === "absent") {
      subagentRuns.delete(child.runId);
    } else {
      child.requesterTurnRunId = "adopting-turn";
    }
    await expect(claimRecovery()).resolves.toMatchObject({ kind: "invalidated" });
    expect(read().restartRecoveryRuns).toEqual([{ runId: "yielded-run", lifecycleGeneration }]);
  });

  it.each([
    { mainRestartRecovery: { cycleId: "debt", revision: 1, chargedAttempts: 0 } },
    { restartRecoveryDeliveryRunId: "delivery-run" },
    { restartRecoveryRuns: [{ runId: "other-run", lifecycleGeneration: "other-generation" }] },
    { lifecycleRunId: "other-run" },
  ] satisfies Partial<SessionEntry>[])("preserves separate custody: %j", async (debt) => {
    await write({ ...read(), ...debt });
    const before = read();
    await expect(claimRecovery()).resolves.toMatchObject({ kind: "invalidated" });
    expect(read()).toEqual(before);
  });

  it("rejects a handoff if the child batch is adopted before commit", async () => {
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) =>
      replace({
        ...params,
        update: async (entries) => {
          const result = await params.update(entries);
          child.requesterTurnRunId = "competing-turn";
          return result;
        },
      }),
    );
    await expect(claimRecovery()).rejects.toThrow("continuation changed before recovery handoff");
    expect(read().restartRecoveryRuns).toEqual([{ runId: "yielded-run", lifecycleGeneration }]);
  });

  async function completedRequester() {
    const completedChild = createSubagentRunRecord({
      ...child,
      generation: 1,
      execution: {
        status: "terminal",
        startedAt: 100,
        lifecycleGeneration: "previous-generation",
        endedAt: 1500,
        outcome: { status: "ok" },
      },
      delivery: { status: "delivered", disposition: "delivered", deliveredAt: 1900 },
      cleanupCompletedAt: 1600,
      requesterSettleWake: undefined,
      requesterTurnRunId: undefined,
    });
    subagentRuns.set(child.runId, completedChild);
    return completedChild;
  }

  async function savedYield(runId = "yielded-run", status = "yielded") {
    await sessionAccessor.appendTranscriptMessage(
      { sessionKey, storePath, sessionId: "session-1" },
      {
        cwd: path.dirname(storePath),
        message: {
          role: "toolResult",
          toolName: "sessions_yield",
          toolCallId: "yield-call",
          isError: false,
          timestamp: 200,
          content: [{ type: "text", text: JSON.stringify({ status }) }],
          __openclaw: { runId },
        },
      },
    );
  }

  it("admits the next human turn after a yielded parent and requester completion", async () => {
    const yielded = projectMainSessionRecoveryLifecycle({
      currentLifecycleGeneration: lifecycleGeneration,
      entry: read(),
      event: {
        runId: "yielded-run",
        lifecycleGeneration,
        data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
      },
      snapshotPatch: { status: undefined, endedAt: 1000 },
    });
    expect(yielded.action).toBe("apply");
    if (yielded.action === "apply") {
      await write({ ...read(), ...yielded.patch });
    }
    const announcement = read();
    recordLifecycleFence(announcement, { runId: "settle-run", lifecycleGeneration });
    await write(announcement);
    const completed = projectMainSessionRecoveryLifecycle({
      currentLifecycleGeneration: lifecycleGeneration,
      entry: read(),
      event: { runId: "settle-run", lifecycleGeneration, data: { phase: "end" } },
      snapshotPatch: { status: "done", endedAt: 2000, lifecycleRunId: undefined },
    });
    expect(completed.action).toBe("apply");
    if (completed.action === "apply") {
      await write({ ...read(), ...completed.patch });
    }
    await completedRequester();
    await expect(claimRecovery({ runId: "later-user-run" })).resolves.toMatchObject({
      kind: "not_required",
    });
    expect(read().restartRecoveryRuns).toBeUndefined();
  });

  async function savedCompletedRequester() {
    await completedRequester();
    await savedYield();
    await write({
      ...read(),
      status: "done",
      lifecycleRunId: undefined,
      lastRunId: "settle-run",
      activeWriterRunId: "settle-run",
      restartRecoveryRuns: [{ runId: "yielded-run", lifecycleGeneration: "previous-generation" }],
    });
  }

  it.each(["claim", "observe"] as const)(
    "reconciles persisted yielded residue through %s before the next human turn",
    async (boundary) => {
      await savedCompletedRequester();
      if (boundary === "observe") {
        await commitMainSessionRecovery({
          target: { sessionKey, storePath },
          command: { kind: "observe", lifecycleGeneration, sessionKey, cycleId: "unused" },
        });
        expect(read().restartRecoveryRuns).toBeUndefined();
      }
      const admitted = await admitReplyTurn({
        kind: "visible",
        resetTriggered: false,
        sessionKey,
        sessionId: "session-1",
        expectedSessionId: "session-1",
        storePath,
      });
      try {
        expect(admitted.status).toBe("owned");
        expect(read().restartRecoveryRuns).toBeUndefined();
      } finally {
        if (admitted.status === "owned") {
          admitted.operation.complete();
        }
      }
    },
  );

  it.each([
    "current generation",
    "unrelated run",
    "live execution",
    "pending child",
    "child wake",
    "child delivery",
    "pending final",
    "interrupted",
    "reservation",
    "unproven yield",
    "replacement older generation",
    "yield before child launch",
    "replaced child",
  ])("does not discard persisted %s custody", async (custody) => {
    await savedCompletedRequester();
    const completedChild = subagentRuns.get(child.runId)!;
    switch (custody) {
      case "current generation":
        await write({
          ...read(),
          restartRecoveryRuns: [{ runId: "yielded-run", lifecycleGeneration }],
        });
        break;
      case "unrelated run":
        await write({
          ...read(),
          restartRecoveryRuns: [
            { runId: "unrelated-run", lifecycleGeneration: "previous-generation" },
          ],
        });
        break;
      case "live execution":
        registerAgentRunContext("yielded-run", { projectSessionActive: true });
        break;
      case "pending child":
        subagentRuns.set(child.runId, { ...completedChild, execution: { status: "running" } });
        break;
      case "child wake":
        subagentRuns.set(child.runId, {
          ...completedChild,
          requesterSettleWake: child.requesterSettleWake,
        });
        break;
      case "child delivery":
        subagentRuns.set(child.runId, { ...completedChild, delivery: { status: "pending" } });
        break;
      case "pending final":
        await write({
          ...read(),
          pendingFinalDelivery: { kind: "replayable", text: "owed final", createdAt: 100 },
        });
        break;
      case "interrupted":
        await write({ ...read(), abortedLastRun: true, status: "interrupted" });
        break;
      case "reservation":
        await write({
          ...read(),
          mainRestartRecovery: {
            cycleId: "owned",
            revision: 1,
            chargedAttempts: 1,
            reservation: { runId: "reserved", lifecycleGeneration, attempt: 1 },
          },
        });
        break;
      case "unproven yield":
        await savedYield("unproven-run", "nothing_pending");
        await write({
          ...read(),
          lastRunId: "settle-run",
          activeWriterRunId: "settle-run",
          restartRecoveryRuns: [
            { runId: "unproven-run", lifecycleGeneration: "previous-generation" },
          ],
        });
        break;
      case "replacement older generation":
        await write({
          ...read(),
          restartRecoveryRuns: [
            { runId: "yielded-run", lifecycleGeneration: "replacement-previous-generation" },
          ],
        });
        break;
      case "yield before child launch":
        subagentRuns.set(child.runId, {
          ...completedChild,
          execution: { ...completedChild.execution, startedAt: 300 },
        });
        break;
      case "replaced child":
        subagentRuns.set(child.runId, { ...completedChild, generation: 2 });
    }
    const fences = read().restartRecoveryRuns;
    await claimRecovery();
    expect(read().restartRecoveryRuns).toEqual(fences);
  });

  it.each(["generation", "cancellation"] as const)(
    "rejects %s changes during preparation even without yielded reconciliation",
    async (change) => {
      await write({ ...read(), status: "interrupted", abortedLastRun: true });
      const before = read();
      let cancelled = false;
      const prepare = recoveryTarget.prepareCompletedYieldedMainSessionReconciliation;
      vi.spyOn(
        recoveryTarget,
        "prepareCompletedYieldedMainSessionReconciliation",
      ).mockImplementationOnce(async (params) => {
        const result = await prepare(params);
        expect(result).toBeUndefined();
        if (change === "generation") {
          rotateAgentRunRegistryLifecycleGeneration();
        } else {
          cancelled = true;
        }
        return result;
      });
      const result = await commitMainSessionRecovery({
        target: { sessionKey, storePath },
        command: { kind: "observe", sessionKey, lifecycleGeneration, cycleId: "stale-cycle" },
        shouldContinue: () => !cancelled,
      });
      expect(result.transition).toEqual({ kind: "rejected", reason: "stale_generation" });
      expect(read()).toEqual(before);
    },
  );

  it("rechecks generation at commit without yielded reconciliation", async () => {
    await write({ ...read(), status: "interrupted", abortedLastRun: true });
    const before = read();
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) =>
      replace({
        ...params,
        update: async (entries) => {
          const result = await params.update(entries);
          rotateAgentRunRegistryLifecycleGeneration();
          return result;
        },
      }),
    );
    await expect(
      commitMainSessionRecovery({
        target: { sessionKey, storePath },
        command: { kind: "observe", sessionKey, lifecycleGeneration, cycleId: "stale-cycle" },
      }),
    ).rejects.toThrow("Recovery command changed before commit");
    expect(read()).toEqual(before);
  });

  it("rejects reconciliation if requester custody changes before commit", async () => {
    await savedCompletedRequester();
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) =>
      replace({
        ...params,
        update: async (entries) => {
          const result = await params.update(entries);
          subagentRuns.get(child.runId)!.requesterSettleWake = child.requesterSettleWake;
          return result;
        },
      }),
    );
    await expect(claimRecovery()).rejects.toThrow("custody changed before recovery reconciliation");
    expect(read().restartRecoveryRuns).toEqual([
      { runId: "yielded-run", lifecycleGeneration: "previous-generation" },
    ]);
  });

  it("retires only the proven predecessor and retains a sibling fence", async () => {
    await savedCompletedRequester();
    const siblings = [
      { runId: "unsettled-sibling", lifecycleGeneration: "previous-generation" },
      { runId: "yielded-run", lifecycleGeneration: "replacement-previous-generation" },
    ];
    await write({ ...read(), restartRecoveryRuns: [...read().restartRecoveryRuns!, ...siblings] });
    await expect(claimRecovery()).resolves.toMatchObject({ kind: "invalidated" });
    expect(read().restartRecoveryRuns).toEqual(siblings);
    expect(read().restartRecoveryTerminalRunIds).not.toContain("yielded-run");
  });
});
