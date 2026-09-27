import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { runWithCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
} from "../../cron/task-run-detail.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedTaskRegistryRowsForTests } from "../../test-utils/task-registry-sqlite.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import {
  createCronCreatorAuthorityRunScope,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function withCronHistory(
  run: (fixture: {
    jobId: string;
    foreignJobId: string;
    cron: CronService;
    context: GatewayRequestContext;
    query: (
      params: Record<string, unknown>,
      client?: GatewayClient,
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    viewer: GatewayClient;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const owner = roleClient("none", "history-owner");
    const foreign = roleClient("none", "history-foreign");
    const viewer = roleClient("view", "history-viewer");
    const ownKey = "agent:main:history-own";
    const foreignKey = "agent:main:history-foreign";
    for (const [sessionKey, client] of [
      [ownKey, owner],
      [foreignKey, foreign],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(client.authenticatedUserProfile, "fixture profile").profileId,
          },
        },
      );
    }
    const storePath = state.path("cron", "jobs.json");
    const cron = new CronService({
      storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      const jobs = [];
      for (const sessionKey of [ownKey, foreignKey]) {
        const result = await cron.add({
          name: sessionKey,
          agentId: "main",
          owner: { agentId: "main", sessionKey },
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "fixture" },
          delivery: { mode: "none" },
        });
        jobs.push("job" in result ? result.job : result);
      }
      const jobId = expectDefined(jobs[0], "own job").id;
      const foreignJobId = expectDefined(jobs[1], "foreign job").id;
      const rows: Array<Pick<CronRunLogEntry, "sessionKey" | "status" | "summary" | "jobId">> = [
        { jobId, sessionKey: foreignKey, status: "error", summary: "needle hidden" },
        { jobId, sessionKey: ownKey, status: "error", summary: "needle first" },
        { jobId, sessionKey: foreignKey, status: "ok", summary: "other hidden" },
        { jobId, status: "error", summary: "needle second" },
        { jobId, sessionKey: ownKey, status: "ok", summary: "other third" },
        { jobId: foreignJobId, sessionKey: ownKey, status: "error", summary: "needle foreign job" },
      ];
      const now = Date.now();
      const tasks = rows.map((row, index): TaskRecord => {
        const entry: CronRunLogEntry = {
          ...row,
          action: "finished",
          ts: now + index,
          runId: `history-run-${index}`,
          deliveryStatus: row.status === "error" ? "not-delivered" : "delivered",
        };
        return {
          taskId: `history-task-${index}`,
          runtime: "cron",
          sourceId: entry.jobId,
          requesterSessionKey: "",
          ownerKey: "",
          scopeKind: "system",
          childSessionKey: entry.sessionKey,
          agentId: "main",
          task: "history fixture",
          status: cronRunStatusToTaskStatus(entry),
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: entry.ts,
          endedAt: entry.ts,
          detail: cronRunLogEntryToTaskDetail(entry, { storeKey: cronStoreKey(storePath) }),
        };
      });
      seedTaskRegistryRowsForTests(new Map(tasks.map((task) => [task.taskId, task])).values());
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const query = async (params: Record<string, unknown>, client = owner) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers["cron.runs"],
          "cron.runs handler",
        )({
          req: { type: "req", id: "history-request", method: "cron.runs", params },
          params,
          client,
          respond,
          context,
          isWebchatConnect: () => false,
        });
        return respond;
      };
      await run({ jobId, foreignJobId, cron, context, query, viewer });
    } finally {
      cron.stop();
    }
  });
}

describe("cron.runs session visibility", () => {
  it.each(["job", "all"] as const)(
    "paginates visible %s history before counting and slicing",
    async (scope) => {
      await withCronHistory(async ({ jobId, query }) => {
        const selector = scope === "job" ? { id: jobId } : { scope };
        for (const [offset, summary] of [
          "needle first",
          "needle second",
          "other third",
        ].entries()) {
          const respond = await query({
            ...selector,
            agentId: "MAIN",
            limit: 1,
            offset,
            sortDir: "asc",
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            {
              entries: [expect.objectContaining({ summary })],
              total: 3,
              offset,
              limit: 1,
              hasMore: offset < 2,
              nextOffset: offset < 2 ? offset + 1 : null,
            },
            undefined,
          );
        }
        expect(await query({ ...selector, offset: 99, limit: 1 })).toHaveBeenCalledWith(
          true,
          {
            entries: [],
            total: 3,
            offset: 3,
            limit: 1,
            hasMore: false,
            nextOffset: null,
          },
          undefined,
        );
      });
    },
  );

  it.each(["job", "all"] as const)("combines %s visibility with history filters", async (scope) => {
    await withCronHistory(async ({ jobId, query }) => {
      const respond = await query({
        ...(scope === "job" ? { id: jobId } : { scope }),
        agentId: "MAIN",
        statuses: ["error"],
        status: "ok",
        deliveryStatuses: ["not-delivered"],
        deliveryStatus: "delivered",
        query: "needle",
        sortDir: "asc",
        offset: 1,
        limit: 1,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          entries: [expect.objectContaining({ summary: "needle second" })],
          total: 2,
          offset: 1,
          limit: 1,
          hasMore: false,
          nextOffset: null,
        },
        undefined,
      );
    });
  });

  it.each([
    { filter: { query: "absent text" }, total: 0, offset: 0 },
    { filter: { runId: "absent-run" }, total: 0, offset: 0 },
    { filter: { runId: "history-run-1", offset: 99 }, total: 1, offset: 1 },
  ])(
    "keeps deleted-job empty pages distinct from missing history: $filter",
    async ({ filter, total, offset }) => {
      await withCronHistory(async ({ jobId, cron, query, viewer }) => {
        await cron.remove(jobId);
        expect(await query({ id: jobId, ...filter, limit: 1 }, viewer)).toHaveBeenCalledWith(
          true,
          { entries: [], total, offset, limit: 1, hasMore: false, nextOffset: null },
          undefined,
        );
        expect(
          await query({ id: "missing-job", ...filter, limit: 1 }, viewer),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
          }),
        );
      });
    },
  );

  it("keeps foreign jobs hidden and retained deleted-job history available to viewers", async () => {
    await withCronHistory(async ({ jobId, foreignJobId, cron, query, viewer }) => {
      expect(await query({ id: foreignJobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId: foreignJobId } }),
      );
      await cron.remove(jobId);
      expect(await query({ id: jobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId } }),
      );
      expect(
        await query({ id: jobId, limit: 1, runId: "history-run-1" }, viewer),
      ).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          entries: [expect.objectContaining({ summary: "needle first" })],
          total: 1,
        }),
        undefined,
      );
    });
  });
});

describe("automation history through admitted agent tools", () => {
  it.each(["channel-owner", "control-ui-admin", "unprivileged", "revoked-owner"] as const)(
    "keeps get and runs consistent for %s",
    async (source) => {
      await withCronHistory(async ({ foreignJobId, cron, context }) => {
        const operationalRunInstance = createOperationalRunInstanceRef("history-management-run");
        const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
        let current = true;
        const scope = createCronCreatorAuthorityRunScope(
          operationalRunInstance.runId,
          source === "control-ui-admin"
            ? { kind: "unknown" }
            : { kind: "external", channel: "mattermost" },
          source === "unprivileged"
            ? undefined
            : source === "control-ui-admin"
              ? { source }
              : { source: "channel-owner", isCurrent: () => current },
        );
        try {
          await runWithCronCreatorAuthorityCapability(scope, () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:mattermost:channel:history-manager",
                operationalRunInstance,
                approvalAuthority: authority,
                receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
                gatewayContextResolver: () => context,
              },
              async () => {
                const tool = createCronTool({
                  runId: operationalRunInstance.runId,
                  agentSessionKey: "agent:main:mattermost:channel:history-manager",
                });
                if (source === "unprivileged") {
                  await expect(
                    tool.execute("history", { action: "runs", jobId: foreignJobId }),
                  ).rejects.toThrow(/not found/i);
                  return;
                }
                await expect(
                  tool.execute("get", { action: "get", jobId: foreignJobId }),
                ).resolves.toMatchObject({ details: { id: foreignJobId } });
                if (source === "revoked-owner") {
                  const readJob = cron.readJob.bind(cron);
                  vi.spyOn(cron, "readJob").mockImplementationOnce(async (...args) => {
                    const job = await readJob(...args);
                    current = false;
                    return job;
                  });
                  await expect(
                    tool.execute("history", { action: "runs", jobId: foreignJobId }),
                  ).rejects.toThrow(/admin grant.*missing, expired, or already used/i);
                } else {
                  await expect(
                    tool.execute("history", { action: "runs", jobId: foreignJobId }),
                  ).resolves.toMatchObject({
                    details: {
                      entries: [
                        expect.objectContaining({
                          jobId: foreignJobId,
                          summary: "needle foreign job",
                        }),
                      ],
                      total: 1,
                    },
                  });
                }
              },
            ),
          );
        } finally {
          revokeCronCreatorAuthorityRunScope(scope);
          releaseAgentRunDelegatedAuthority(authority);
        }
      });
    },
  );
});
