import path from "node:path";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

export function resetCliAttemptFixtureDatabases(suiteRoot: string): void {
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
      continue;
    }
    runOpenClawAgentWriteTransaction(
      (fixture) => {
        fixture.db.exec(`
          DELETE FROM session_transcript_fts;
          DELETE FROM session_transcript_fts_rows;
          DELETE FROM session_nodes;
          DELETE FROM conversations;
          DELETE FROM auth_profile_store;
          DELETE FROM auth_profile_state;
          DELETE FROM cache_entries;
        `);
      },
      database,
      { operationLabel: "test.attempt-execution.reset" },
    );
  }
}

/** Model capability and channel discovery fixtures for CLI fallback tests. */
export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => null },
      } satisfies ChannelPlugin,
    },
  ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
      },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}

import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import { runAgentAttempt } from "./attempt-execution.js";

export type RunAgentAttemptParams = Parameters<typeof runAgentAttempt>[0];

export type RunAgentAttemptOverrides = Omit<
  Partial<RunAgentAttemptParams>,
  | "agentDir"
  | "modelRoutingProvenance"
  | "opts"
  | "runContext"
  | "sessionEntry"
  | "sessionKey"
  | "workspaceDir"
> & {
  agentDir: RunAgentAttemptParams["agentDir"];
  modelRoutingProvenance?: ModelFallbackAttemptProvenance;
  sessionEntry: NonNullable<RunAgentAttemptParams["sessionEntry"]>;
  sessionKey: NonNullable<RunAgentAttemptParams["sessionKey"]>;
  workspaceDir: RunAgentAttemptParams["workspaceDir"];
  opts?: Partial<RunAgentAttemptParams["opts"]>;
  runContext?: Partial<RunAgentAttemptParams["runContext"]>;
};

export function makeRunAgentAttemptParams(
  overrides: RunAgentAttemptOverrides,
): RunAgentAttemptParams {
  const provider = overrides.providerOverride ?? "openai";
  const model = overrides.modelOverride ?? "gpt-5.4";
  const isFallbackRetry = overrides.isFallbackRetry ?? false;
  const runId = overrides.runId ?? `run-${overrides.sessionEntry.sessionId}`;
  const modelRoutingProvenance: ModelFallbackAttemptProvenance =
    overrides.modelRoutingProvenance ?? {
      requestedProvider: overrides.originalProvider ?? provider,
      requestedModel: model,
      stage: isFallbackRetry ? "fallback" : "initial",
    };
  return {
    providerOverride: provider,
    originalProvider: provider,
    modelOverride: model,
    cfg: {} as OpenClawConfig,
    sessionId: overrides.sessionEntry.sessionId,
    sessionAgentId: "main",
    sessionFile: path.join(overrides.workspaceDir, "session.jsonl"),
    body: "continue",
    isFallbackRetry,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId,
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    onAgentEvent: vi.fn(),
    authProfileProvider: provider,
    sessionHasHistory: false,
    ...overrides,
    modelRoutingProvenance,
    pluginGeneration: overrides.pluginGeneration,
    preparedRunAdmission: overrides.preparedRunAdmission ?? createTestPreparedRunAdmission(runId),
    lifecycleGeneration: overrides.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    opts: { ...overrides.opts } as RunAgentAttemptParams["opts"],
    runContext: { ...overrides.runContext } as RunAgentAttemptParams["runContext"],
  };
}
