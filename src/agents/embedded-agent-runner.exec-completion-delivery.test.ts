import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type {
  ChannelMessageActionContext,
  ChannelThreadingAdapter,
} from "../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage, Context } from "../llm/types.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { readEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import { submitEmbeddedAttemptPrompt } from "./embedded-agent-runner/run/attempt-prompt-submit.js";
import { createBaseInput } from "./embedded-agent-runner/run/attempt-prompt-submit.test-support.js";
import { createAttemptSetupFixture } from "./embedded-agent-runner/run/attempt-setup.test-support.js";
import type { EmbeddedRunAttemptInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { dropReasoningFromHistory } from "./embedded-agent-runner/thinking.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { jsonResult } from "./tools/common.js";

registerAgentSessionLoopTestLifecycle();

const infer = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let prepareTools: typeof import("./embedded-agent-runner/run/attempt-tool-prepare.js").prepareEmbeddedAttemptToolBase;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const previousRegistry = captureActivePluginRegistrySnapshot();
const posts = vi.fn(async ({ params }: ChannelMessageActionContext) => {
  const result = { messageId: "completion-result", channelId: String(params.to) };
  return jsonResult({
    ok: true,
    ...result,
    receipt: createMessageReceiptFromOutboundResults({
      results: [result],
      kind: "text",
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
    }),
  });
});
const route = {
  channel: "mattermost",
  to: "channel:completion-fixture",
  accountId: "work",
  threadId: "original-thread",
};
const registry = createTestRegistry([
  {
    pluginId: "mattermost",
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id: "mattermost" }),
      outbound: createDirectOutboundTestAdapter({ channel: "mattermost" }),
      threading: {
        resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
      } satisfies ChannelThreadingAdapter,
      messaging: {
        targetIdComparison: "case-sensitive",
        targetResolver: { looksLikeId: () => true },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction: posts,
      },
    },
  },
]);

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "exec-completion-delivery" });
  setActivePluginRegistry(registry);
  // Replace inference, model discovery and provider auth. Keep the real run loop,
  // admission, tool construction/presentation, message execution and source policy.
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full", pluginRegistry: registry });
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => infer(params) });
  vi.doUnmock("./harness/selection.js");
  // mock-isolation: Model-file generation is outside delivery and must not write provider state.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Use an offline model; provider discovery and credentials are not under test.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ prepareEmbeddedAttemptToolBase: prepareTools } =
    await import("./embedded-agent-runner/run/attempt-tool-prepare.js"));
});

afterAll(async () => {
  restoreActivePluginRegistrySnapshot(previousRegistry);
  await state?.cleanup();
});

type Scenario = {
  name: string;
  attempts: number;
  notify?: boolean;
  delivered?: boolean;
  text?: string;
  recoveryText?: string;
  source?: string;
  silentExpected?: boolean;
  roomEvent?: boolean;
  pending?: boolean;
  denyMessageTool?: boolean;
  denySend?: boolean;
  denyAtSend?: boolean;
  toolsAllow?: string[];
  lastToolError?: ToolErrorSummary;
  providerRecovery?: boolean;
};
const privateNotes =
  "The old background check is superseded by a newer result that was already reported. " +
  "These are private coordination notes about internal follow-up work, not a new notification. " +
  "There is no change requiring the user to act and no pending answer to send.";

it.each<Scenario>([
  { name: "success", attempts: 2, notify: true },
  {
    name: "private final mistaken for delivered",
    attempts: 2,
    notify: true,
    providerRecovery: true,
  },
  {
    name: "actionable failure",
    attempts: 2,
    notify: true,
    source: "exec-event",
    lastToolError: {
      toolName: "process",
      executionStarted: true,
      terminalDiagnostic: {
        kind: "process",
        sessionId: "failed-check",
        reason: { kind: "exit", exitCode: 1 },
      },
    },
  },
  { name: "stale notes", attempts: 2, text: privateNotes },
  { name: "ignored recovery", attempts: 2, text: privateNotes, recoveryText: privateNotes },
  { name: "deliberately private run", attempts: 1, silentExpected: true },
  { name: "explicit silence", attempts: 1, text: "NO_REPLY" },
  { name: "routine acknowledgment", attempts: 1, text: "HEARTBEAT_OK" },
  { name: "room event", attempts: 1, roomEvent: true },
  { name: "ordinary heartbeat", attempts: 1, source: "heartbeat" },
  { name: "already delivered", attempts: 1, delivered: true },
  { name: "ambiguous delivery", attempts: 1, pending: true },
  {
    name: "failed message attempt",
    attempts: 1,
    lastToolError: { toolName: "message", executionStarted: true },
  },
  { name: "message tool denied", attempts: 2, denyMessageTool: true },
  { name: "send policy denied", attempts: 1, denySend: true, notify: true },
  { name: "send policy revoked during inference", attempts: 2, denyAtSend: true },
  { name: "captured surface excludes message", attempts: 1, toolsAllow: ["process"] },
  {
    name: "captured intersection excludes message",
    attempts: 1,
    toolsAllow: attachToolAllowlistIntersection(["message", "process"], [["process"]]),
  },
])(
  "settles exec completion $name with authorized source delivery or private silence",
  async (scenario) => {
    infer.mockReset();
    posts.mockClear();
    const sessionId = `completion-${scenario.name.replaceAll(" ", "-")}`;
    const sessionKey = `agent:main:${sessionId}`;
    const config: OpenClawConfig = {
      ...createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      messages: { visibleReplies: "automatic" },
      tools: {
        codeMode: false,
        toolSearch: { enabled: false },
        ...(scenario.denyMessageTool ? { deny: ["message"] } : {}),
      },
      channels: { mattermost: { enabled: true } },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(config);
    await state.writeConfig(config);
    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      permissionMode: "full",
      ...(scenario.denySend ? { sendPolicy: "deny" as const } : {}),
      delivery: normalizeSessionDeliveryState({ context: route }),
    };
    await replaceSessionEntry({ agentId: "main", sessionKey }, sessionEntry);
    const privateFinal =
      scenario.text ??
      (scenario.name === "success"
        ? "The requested checks passed. The background work is complete and the result is ready."
        : "The required check failed. The user needs to fix the reported error before continuing.");
    const notification = `New result: ${privateFinal}`;
    let privateAssistant: AssistantMessage | undefined;
    infer.mockImplementation(async (params) => {
      const tools = await prepareTools({
        attempt: params as EmbeddedRunAttemptInternalParams,
        agentDir: state.agentDir(),
        setup: createAttemptSetupFixture({
          sandboxSessionKey: sessionKey,
          effectiveCwd: state.workspaceDir,
          effectiveWorkspace: state.workspaceDir,
          resolvedWorkspace: state.workspaceDir,
          sessionPermissionRoot: state.workspaceDir,
        }),
        markCoreToolStage: () => {},
        onYield: async () => {},
        runAbortController: new AbortController(),
        runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
        skillUsagePaths: [],
        skillsSnapshot: undefined,
        codeModeSkills: [],
        toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
      });
      try {
        const visible = tools.toolSurfaceRuntime.compactTools(tools.toolsRaw).tools;
        const message = visible.find((tool) => tool.name === "message");
        if (scenario.denyMessageTool) {
          expect(message).toBeUndefined();
        } else {
          expect(message, "the real completion tool surface must advertise delivery").toBeDefined();
        }
        const isRecovery = infer.mock.calls.length > 1;
        if (isRecovery) {
          expect(params.suppressNextUserMessagePersistence).toBe(true);
          expect(params.prompt).toContain("useful new result");
          expect(visible.map((tool) => tool.name)).toEqual(
            scenario.denyMessageTool ? [] : ["message"],
          );
          if (scenario.name === "success") {
            for (const invalid of [
              { target: "channel:another-conversation" },
              { threadId: "another-thread" },
              { accountId: "another-account" },
              { channel: "telegram" },
              { action: "delete" },
            ]) {
              await expect(
                message!.execute("wrong-route", {
                  action: "send",
                  target: params.currentMessagingTarget,
                  message: notification,
                  ...invalid,
                }),
              ).rejects.toThrow();
            }
            expect(posts).not.toHaveBeenCalled();
          }
          if (scenario.denyAtSend) {
            sessionEntry.sendPolicy = "deny";
            await expect(
              message!.execute("late-denial", {
                action: "send",
                target: params.currentMessagingTarget,
                message: notification,
              }),
            ).rejects.toThrow();
            expect(posts).not.toHaveBeenCalled();
          }
        }
        const shouldSend = scenario.delivered || (isRecovery && scenario.notify);
        let delivered = false;
        if (shouldSend && !scenario.providerRecovery) {
          const delivery = await message!.execute("deliver-completion", {
            action: "send",
            message: notification,
            target: params.currentMessagingTarget,
          });
          const fact = readEmbeddedMessageDeliveryFact(
            readToolResultDetails(delivery)?.messageDelivery,
          );
          expect(fact).toMatchObject({
            status: "settled",
            sourceReplyDelivered: true,
            primaryPlatformMessageId: "completion-result",
            partialDelivery: false,
          });
          delivered = fact?.sourceReplyDelivered === true;
        }
        if (isRecovery && scenario.providerRecovery) {
          const manager = SessionManager.inMemory();
          const prefix = {
            role: "user" as const,
            content: "Wait for the check result.",
            timestamp: 1,
          };
          await manager.appendMessageAsync(prefix);
          await manager.appendMessageAsync(privateAssistant!);
          const { session } = await createTestSession({
            sessionManager: manager,
            customTools: toToolDefinitions([message!]),
          });
          const originalBranch = structuredClone(manager.getBranch());
          session.agent.state.messages = dropReasoningFromHistory(session.messages);
          const preparedFinal = structuredClone(session.messages[1]);
          const requests: Context[] = [];
          const payloads: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
          streamMocks.streamSimple.mockImplementation((model, context) => {
            requests.push({
              ...context,
              messages: structuredClone(context.messages),
              tools: context.tools?.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
            });
            payloads.push(buildOpenAIResponsesParams(model, context, undefined));
            // Reproduce the observed provider mistake: assistant history is
            // interpreted as an answer already sent to the source conversation.
            const alreadyAnswered = context.messages.some(
              (entry) =>
                entry.role === "assistant" &&
                entry.content.some((part) => part.type === "text" && part.text === privateFinal),
            );
            const sent = context.messages.some((entry) => entry.role === "toolResult");
            return createAssistantResultStream(
              createAssistant(
                model,
                alreadyAnswered || sent
                  ? [{ type: "text", text: "NO_REPLY" }]
                  : [
                      {
                        type: "toolCall",
                        id: "deliver-completion",
                        name: "message",
                        arguments: {
                          action: "send",
                          target: params.currentMessagingTarget,
                          message: notification,
                        },
                      },
                    ],
                alreadyAnswered || sent ? "stop" : "toolUse",
              ),
            );
          });
          await submitEmbeddedAttemptPrompt({
            ...createBaseInput(),
            attempt: params,
            activeSession: session,
            appendContext: undefined,
            prependContext: undefined,
            modelPrompt: params.prompt,
            transcriptPrompt: params.prompt,
            runtimeOnly: true,
            promptActiveSession: (prompt, options) => session.prompt(prompt, options),
          });
          expect(requests.length, "the external inference fixture must execute").toBeGreaterThan(0);
          expect(
            posts,
            "the undelivered completion must reach the source message tool",
          ).toHaveBeenCalledTimes(1);
          expect(requests).toHaveLength(2);
          expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["message"]);
          expect(requests[0]?.messages[0]).toEqual(prefix);
          expect(JSON.stringify(payloads[0]?.input)).toContain("UNDELIVERED private result");
          expect(JSON.stringify(payloads)).not.toContain("private-recovery-reasoning");
          expect(requests[0]?.messages[1]).toMatchObject({
            role: "user",
            content: expect.stringContaining(JSON.stringify({ undeliveredResult: privateFinal })),
          });
          expect(session.messages[1]).toEqual(preparedFinal);
          expect(JSON.stringify(manager.getBranch().slice(0, originalBranch.length))).toBe(
            JSON.stringify(originalBranch),
          );
          const receipt = session.messages.find((entry) => entry.role === "toolResult");
          const fact = readEmbeddedMessageDeliveryFact(
            receipt?.role === "toolResult"
              ? readToolResultDetails(receipt)?.messageDelivery
              : undefined,
          );
          expect(fact).toMatchObject({ status: "settled", sourceReplyDelivered: true });
          delivered = fact?.sourceReplyDelivered === true;
        }
        const text = delivered || isRecovery ? (scenario.recoveryText ?? "NO_REPLY") : privateFinal;
        const assistant = buildEmbeddedRunnerAssistant({
          content: [
            ...(scenario.providerRecovery && !isRecovery
              ? [{ type: "thinking" as const, thinking: "private-recovery-reasoning" }]
              : []),
            { type: "text", text },
          ],
        });
        if (!isRecovery) {
          privateAssistant = assistant;
        }
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: sessionId,
          assistantTexts: [text],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          toolMetas: [
            {
              toolName: scenario.lastToolError?.toolName ?? "process",
              isError: !isRecovery && scenario.lastToolError !== undefined,
              replaySafe: true,
            },
          ],
          lastToolError: isRecovery ? undefined : scenario.lastToolError,
          ...(scenario.pending ? { sourceReplyDeliveryState: "pending" as const } : {}),
          ...(delivered
            ? {
                didDeliverSourceReplyViaMessageTool: true,
                sourceReplyDeliveryState: "delivered",
                messagingToolSentTargets: [
                  {
                    tool: "message",
                    provider: route.channel,
                    to: route.to,
                    sourceReplyFinal: true,
                  },
                ],
              }
            : {}),
        });
      } finally {
        await tools.releaseTools("test-complete");
        tools.toolSurfaceRuntime.cleanup();
      }
    });

    const { prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js");
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      config,
      `run-${sessionId}`,
      "main",
      "exec-completion-delivery-test",
    );
    let result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
    try {
      result = await runEmbeddedAgent({
        preparedRunAdmission,
        canRecoverExecCompletionDelivery: () =>
          resolveSendPolicy({ cfg: config, entry: sessionEntry, sessionKey }) !== "deny",
        agentId: "main",
        agentDir: state.agentDir(),
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        workspaceDir: state.workspaceDir,
        config,
        provider: "openai",
        model: "mock-1",
        runId: `run-${sessionId}`,
        prompt: `Exec completed (${sessionId}, code ${scenario.name === "success" ? 0 : 1})`,
        inputProvenance: { kind: "internal_system", sourceTool: scenario.source ?? "exec" },
        trigger: "heartbeat",
        currentInboundEventKind: scenario.roomEvent ? "room_event" : undefined,
        silentExpected: scenario.silentExpected,
        terminalReplyExpectation: "optional",
        sourceReplyDeliveryMode: "message_tool_only",
        forceMessageTool: true,
        toolsAllow: scenario.toolsAllow,
        requireExplicitMessageTarget: true,
        messageProvider: route.channel,
        currentChannelId: route.to,
        currentMessagingTarget: route.to,
        currentThreadTs: route.threadId,
        agentAccountId: route.accountId,
        timeoutMs: 60_000,
      });
    } finally {
      preparedRunAdmission.close();
    }
    expect(infer).toHaveBeenCalledTimes(scenario.attempts);
    const expectedPosts = (scenario.notify || scenario.delivered) && !scenario.denySend ? 1 : 0;
    expect(posts).toHaveBeenCalledTimes(expectedPosts);
    if (expectedPosts) {
      expect(posts.mock.calls[0]?.[0].accountId).toBe(route.accountId);
      expect(posts.mock.calls[0]?.[0].params).toMatchObject({
        to: route.to,
        threadId: route.threadId,
        message: notification,
      });
      expect(result.sourceReplyDeliveryState).toBe("delivered");
    } else {
      expect(result.sourceReplyDeliveryState).not.toBe("delivered");
    }
  },
);
