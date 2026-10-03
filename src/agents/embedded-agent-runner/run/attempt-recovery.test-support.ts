import { vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

export type TransportDropScenario = {
  config?: OpenClawConfig;
  assistant?: AssistantMessage;
  providerOwner?: PreparedProviderFailoverOwner;
  assistantTexts?: string[];
  errorMessage?: string;
  errorBody?: string;
  errorCode?: string;
  errorType?: string;
  completedAssistant?: AssistantMessage;
  compactionEnabled?: boolean;
  content?: AssistantMessage["content"];
  diagnostics?: AssistantMessage["diagnostics"];
  activeCount?: number;
  asyncStarted?: boolean;
  codeModeSuspended?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  failedToolCallId?: string;
  missingToolResult?: boolean;
  noTools?: boolean;
  lastToolError?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["lastToolError"];
  pluginHarnessOwnsTransport?: boolean;
  promptError?: Error;
  rateLimitRotationResult?: boolean;
  retryAvailable?: boolean;
  retryConnectionErrors?: boolean;
  replaySafe?: boolean;
  fallbackConfigured?: boolean;
  providerRetryMaxDelayMs?: number;
  onSettledTranscriptModelFallback?: () => void;
  lateSyntheticPriorFailures?: boolean;
  latestToolResult?: "success" | "missing" | "absent";
  terminalizedLatestMissingResult?: boolean;
  terminalizedResultReason?: string;
  terminalizedToolCalls?: ReadonlyArray<{ toolCallId: string; toolName: string }>;
  startedCount?: number;
  terminal?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["terminal"];
  usage?: AssistantMessage["usage"];
  terminate?: boolean;
  yieldDetected?: boolean;
};

export const disabledCompactionRuntime = {
  prepareRecoveryOwner: () => {
    throw new Error("Compaction is disabled in this recovery fixture");
  },
};

// Live shape: a code-mode exec batch settled, then the ChatGPT Responses stream
// died while the model was still reasoning, so the errored turn is thinking-only.
export async function recoverAfterTransportDrop(scenario: TransportDropScenario = {}) {
  const terminalizedLatestMissingResult = scenario.terminalizedLatestMissingResult === true;
  const priorToolCalls = scenario.lateSyntheticPriorFailures
    ? ["bash-prior-1", "bash-prior-2"]
    : terminalizedLatestMissingResult
      ? ["bash-earlier"]
      : [];
  const toolCalls = scenario.noTools
    ? []
    : scenario.lateSyntheticPriorFailures
      ? ["exec-3ce0"]
      : terminalizedLatestMissingResult
        ? ["exec-a731"]
        : ["call_1", "call_2"];
  const allToolCalls = [...priorToolCalls, ...toolCalls];
  const priorToolAssistants = priorToolCalls.map((id) =>
    buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
    }),
  );
  const latestToolName = terminalizedLatestMissingResult ? "bash" : "exec";
  const toolAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: toolCalls.map((id) => ({
      type: "toolCall",
      id,
      name: latestToolName,
      arguments: {},
    })),
  });
  const erroredAssistant =
    scenario.assistant ??
    buildEmbeddedRunnerAssistant({
      stopReason: scenario.terminal?.kind === "timeout" ? "aborted" : "error",
      errorMessage:
        scenario.errorMessage ??
        (scenario.terminal?.kind === "timeout" ? "LLM request timed out." : "WebSocket error"),
      errorBody: scenario.errorBody,
      errorCode: scenario.errorCode,
      errorType: scenario.errorType,
      diagnostics:
        scenario.diagnostics ??
        ([
          {
            type: "provider_transport_failure",
            error: { message: "WebSocket error" },
            details: { phase: "after_message_stream_start" },
          },
        ] as never),
      content: scenario.content ?? [{ type: "thinking", thinking: "checking the results" }],
      usage: scenario.usage ?? createMockUsage(0, 0),
    });
  const provider = erroredAssistant.provider;
  const modelId = erroredAssistant.model;
  const messagesSnapshot = terminalizedLatestMissingResult
    ? ([
        { role: "user", content: "wait for the Herdr agent" },
        priorToolAssistants[0],
        {
          role: "toolResult",
          toolCallId: "bash-earlier",
          toolName: "bash",
          isError: false,
        },
        toolAssistant,
        {
          role: "toolResult",
          toolCallId: "exec-a731",
          toolName: "bash",
          isError: true,
          details: { reason: scenario.terminalizedResultReason ?? "missing_tool_result" },
        },
        erroredAssistant,
      ] as never)
    : ([
        { role: "user", content: "why is it unauthorized?" },
        ...priorToolAssistants,
        ...(toolCalls.length > 0 ? [toolAssistant] : []),
        ...(scenario.latestToolResult === "absent"
          ? []
          : toolCalls
              .filter((id) => !scenario.missingToolResult || id !== "call_2")
              .map((id) =>
                scenario.latestToolResult === "missing"
                  ? {
                      role: "toolResult",
                      toolCallId: id,
                      toolName: "exec",
                      isError: true,
                      details: { reason: "missing_tool_result" },
                    }
                  : {
                      role: "toolResult",
                      toolCallId: id,
                      toolName: "exec",
                      isError: id === scenario.failedToolCallId,
                    },
              )),
        ...priorToolCalls.map((id) => ({
          role: "toolResult",
          toolCallId: id,
          toolName: "bash",
          isError: true,
          details: { reason: "missing_tool_result" },
        })),
        erroredAssistant,
      ] as never);
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: scenario.assistantTexts ?? [],
    messagesSnapshot,
    toolMetas: allToolCalls.map((toolCallId) => ({
      toolCallId,
      toolName: toolCallId.startsWith("bash-") ? "bash" : latestToolName,
      replaySafe: false,
      ...(scenario.asyncStarted ? { asyncStarted: true } : {}),
      ...(scenario.terminate ? { terminate: true } : {}),
      ...(scenario.codeModeSuspended ? { codeModeSuspended: true } : {}),
    })) as never,
    lastAssistant: erroredAssistant,
    currentAttemptAssistant: erroredAssistant,
    ...(scenario.completedAssistant
      ? { currentAttemptCompletedAssistant: scenario.completedAssistant }
      : {}),
    lastToolError:
      scenario.lastToolError ??
      (terminalizedLatestMissingResult
        ? { toolName: "bash", error: "missing tool result" }
        : scenario.lateSyntheticPriorFailures
          ? { toolName: "bash", error: "missing tool result" }
          : undefined),
    didSendDeterministicApprovalPrompt: scenario.didSendDeterministicApprovalPrompt,
    itemLifecycle: {
      startedCount: scenario.startedCount ?? allToolCalls.length,
      completedCount: terminalizedLatestMissingResult
        ? 1
        : scenario.lateSyntheticPriorFailures
          ? 1
          : toolCalls.length,
      activeCount:
        scenario.activeCount ??
        (terminalizedLatestMissingResult
          ? 1
          : scenario.lateSyntheticPriorFailures
            ? priorToolCalls.length + (scenario.latestToolResult === "success" ? 0 : 1)
            : 0),
    },
    ...(scenario.promptError
      ? { terminal: { kind: "failed", source: "prompt", error: scenario.promptError } }
      : scenario.terminal
        ? { terminal: scenario.terminal }
        : {}),
    ...(scenario.yieldDetected ? { yieldDetected: true } : {}),
    ...(scenario.providerRetryMaxDelayMs !== undefined
      ? { providerRetryMaxDelayMs: scenario.providerRetryMaxDelayMs }
      : {}),
    ...(scenario.replaySafe
      ? { currentAttemptReplayMetadata: { replaySafe: true, hadPotentialSideEffects: false } }
      : {}),
  });
  if (terminalizedLatestMissingResult) {
    Object.assign(attempt, {
      terminalizedToolCalls: scenario.terminalizedToolCalls ?? [
        { toolCallId: "exec-a731", toolName: "bash" },
      ],
    });
  }
  const terminalState = resolveEmbeddedRunAttemptTerminalState({
    attempt,
    assistant: erroredAssistant,
  });
  const markOwnedTranscriptRetry = vi.fn();
  const continueFromCurrentTranscript = vi.fn();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "run:transport-drop",
      config: scenario.config,
      retryConnectionErrors: scenario.retryConnectionErrors,
    } as Parameters<typeof createEmbeddedRunFailoverRetryController>[0]["runParams"],
    provider,
    modelId,
    agentDir: "/tmp/provider-recovery-test",
    fallbackConfigured: scenario.fallbackConfigured ?? false,
    profileFailureStore: {
      version: 1,
      profiles: {
        "openai:test-profile": {
          type: "oauth",
          provider: "openai",
          access: "test-access",
          refresh: "test-refresh",
          expires: 4_000_000_000_000,
        },
      },
    },
    getLastProfileId: () => "openai:test-profile",
    harnessOwnsTransport: () => scenario.pluginHarnessOwnsTransport ?? false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: vi.fn(async () => scenario.rateLimitRotationResult ?? false),
  });
  if (scenario.retryAvailable === false) {
    failoverRetryController.observeAttempt({ providerRetryMaxRetries: 0 });
  }
  vi.spyOn(failoverRetryController, "advanceRateLimitAuthProfile");
  vi.spyOn(failoverRetryController, "maybeMarkAuthProfileFailure");
  const onAgentEvent = vi.fn();
  const recover = () =>
    recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: scenario.config ?? {},
          agentId: "main",
          sessionId: "session:transport-drop",
          runId: "run:transport-drop",
          onAgentEvent,
          onSettledTranscriptModelFallback: scenario.onSettledTranscriptModelFallback,
        },
        resolvedSessionKey: "agent:main:transport-drop",
        agentDir: "/tmp/provider-recovery-test",
        fallbackConfigured: scenario.fallbackConfigured ?? false,
        startedAtMs: Date.now(),
        laneController: { throwIfAborted: vi.fn() },
        suspendForFailure: vi.fn(),
      },
      preparedRuntime: {
        provider,
        modelId,
        model: { id: modelId },
        genericCompactionRecoveryAllowed: scenario.compactionEnabled ?? false,
        attemptedThinking: new Set(["off"]),
        attemptAuthProfileStore: {
          version: 1,
          profiles: {
            "openai:test-profile": {
              type: "oauth",
              provider: "openai",
              access: "test-access",
              refresh: "test-refresh",
              expires: 4_000_000_000_000,
            },
          },
        },
        maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
        setThinkLevel: vi.fn(),
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "openclaw" },
          outerContextTokenMeta: {},
          contextTokenBudget: scenario.compactionEnabled ? 200_000 : undefined,
          pluginHarnessOwnsTransport: scenario.pluginHarnessOwnsTransport ?? false,
          providerRuntimeHandle: scenario.providerOwner
            ? { plugin: scenario.providerOwner }
            : undefined,
          lastProfileId: "openai:test-profile",
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: erroredAssistant,
        currentAttemptAssistant: erroredAssistant,
        currentAttemptCompletedAssistant: scenario.completedAssistant,
        assistantErrorText: erroredAssistant.errorMessage,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider, model: modelId },
        resolveReplayInvalidForAttempt: () => true,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: {
        sessionFile: "/tmp/session.jsonl",
        markOwnedTranscriptRetry,
        continueFromCurrentTranscript,
      },
      failoverRetryController,
      compactionRuntime: {
        ...disabledCompactionRuntime,
        assertRecoveryActive: () => {
          throw new Error("overflow compaction requested");
        },
      },
      contextRecoveryState,
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);
  const recovery = await recover();
  return {
    recovery,
    recover,
    attempt,
    erroredAssistant,
    markOwnedTranscriptRetry,
    continueFromCurrentTranscript,
    contextRecoveryState,
    failoverRetryController,
    onAgentEvent,
  };
}
