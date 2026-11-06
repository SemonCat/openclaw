import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "../../agents/bash-tools.notify-on-exit-ack.test-support.js";
import { createProcessTool } from "../../agents/bash-tools.process.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import { acknowledgeInternalToolResult } from "../../agents/runtime/internal-hooks.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { jsonResult } from "../../agents/tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import type {
  ChannelMessageActionContext,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import * as routedReplies from "./route-reply.js";
import * as sessionEvents from "./session-event-handoff.js";

// mock-isolation: Replace inference and OS spawning; retain real admission, queues and delivery policy.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const spawn = vi.hoisted(() => vi.fn());
// mock-isolation: Complete processes deterministically without launching children or using timers.
vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
await import("./get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);

it.for([false, true])(
  "drains exec completions privately and acknowledges only one (message tool denied: %s)",
  async (denyMessageTool, { signal }) => {
    await withOpenClawTestState(
      { label: "exec-privacy", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          messages: {
            visibleReplies: "automatic",
            queue: { cap: 20, debounceMsByChannel: { mattermost: 0 } },
          },
          tools: denyMessageTool ? { deny: ["message"] } : undefined,
          channels: { mattermost: { enabled: true } },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(cfg);
        await state.writeConfig(cfg);
        openOpenClawStateDatabase();
        const fixtureId = denyMessageTool ? "exec-privacy-denied" : "exec-privacy-available";
        const scope = { agentId: "main", sessionKey: `agent:main:${fixtureId}` };
        const route = { channel: "mattermost", to: "channel:fixture", threadId: "original-thread" };
        await replaceSessionEntry(scope, {
          sessionId: fixtureId,
          lifecycleRevision: "original",
          permissionMode: "full",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          delivery: normalizeSessionDeliveryState({ context: route }),
        });
        const started = createDeferred();
        const release = createDeferred();
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const explicitPosts = vi.fn(async ({ params }: ChannelMessageActionContext) =>
          jsonResult({ ok: true, messageId: "explicit-result", channelId: params.to }),
        );
        const registry = createTestRegistry([
          {
            pluginId: "mattermost",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "mattermost" }),
              outbound: createDirectOutboundTestAdapter({ channel: "mattermost" }),
              threading: {
                buildToolContext: ({ context }) => ({
                  currentChannelId: context.To,
                  currentThreadTs:
                    context.MessageThreadId == null ? undefined : String(context.MessageThreadId),
                }),
                resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
              } satisfies ChannelThreadingAdapter,
              messaging: {
                targetIdComparison: "case-sensitive",
                targetResolver: { looksLikeId: () => true },
              },
              actions: {
                describeMessageTool: () => ({ actions: ["send"] }),
                handleAction: explicitPosts,
              },
            },
          },
        ]);
        setActivePluginRegistry(registry);
        const runtimeRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        const model = vi.mocked(runEmbeddedAgent);
        const prompts: string[] = [];
        model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const admittedRunContext = await expectDefined(
            params.preparedRunAdmission,
            "normal admission",
          ).admit("gateway", params.runId);
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          if (params.trigger !== "event") {
            started.resolve();
            await release.promise;
            return { payloads: [{ text: "Main answer completed" }], meta: { durationMs: 1 } };
          }
          prompts.push(params.prompt);
          expect(params.sourceReplyDeliveryMode).toBe("message_tool_only");
          expect(params.currentInboundContext?.text).toContain(
            "progress and final answers, stays private",
          );
          if (params.prompt.includes("USEFUL_")) {
            const message = params.prompt.includes("USEFUL_SUCCESS")
              ? "The requested background result is ready"
              : "The background operation failed; action is required";
            const tool = createMessageTool({
              config: params.config,
              agentSessionKey: params.sessionKey,
              agentId: params.agentId,
              sessionId: params.sessionId,
              runId: params.runId,
              sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
              inputProvenance: params.inputProvenance,
              currentChannelProvider: params.messageProvider,
              currentChannelId: params.currentChannelId,
              currentMessagingTarget: params.currentMessagingTarget,
              currentThreadTs: params.currentThreadTs,
            });
            const identity = expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
              }),
              "admitted notification caller",
            );
            await withGatewayToolCallerIdentity(identity, () =>
              tool.execute("notify-result", { action: "send", message }),
            );
          }
          await params.onToolResult?.({ text: "Raw completion output" });
          await params.onBlockReply?.({ text: "Completion progress" });
          await params.onBlockReply?.({ text: "Stale completion commentary", isCommentary: true });
          if (prompts.length % 2 === 0) {
            const provider = expectDefined(params.provider, "admitted provider");
            const modelId = expectDefined(params.model, "admitted model");
            const assistant = buildEmbeddedRunnerAssistant({
              provider,
              model: modelId,
              content: [{ type: "text", text: "NO_REPLY" }],
            });
            const terminal = await resolveEmbeddedRunTerminal(
              makeTerminalInput({
                runParams: params,
                provider,
                modelId,
                modelTransportId: modelId,
                activeErrorContext: { provider, model: modelId },
                agentMeta: { sessionId: params.sessionId, provider, model: modelId },
                reportedModelRef: { provider, model: modelId },
                finalAssistantRawText: "NO_REPLY",
                attemptAssistant: assistant,
                attempt: makeEmbeddedRunnerAttempt({
                  assistantTexts: ["NO_REPLY"],
                  lastAssistant: assistant,
                  currentAttemptAssistant: assistant,
                }),
              }),
            );
            expect(terminal.action).toBe("complete");
            if (terminal.action !== "complete") {
              throw new Error("Optional completion did not settle silently");
            }
            return terminal.result;
          }
          return {
            payloads: [{ text: "No changes; ignoring stale completion" }],
            meta: { durationMs: 1 },
          };
        });
        const automatic = vi
          .spyOn(routedReplies, "routeReply")
          .mockResolvedValue({ ok: true, delivered: true });
        const mainPosts = vi.fn();
        const receipts: ReturnType<typeof sessionEvents.enqueueSessionEventForHost>[] = [];
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observer = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((...args) => {
            const receipt = enqueue(...args);
            receipts.push(receipt);
            return receipt;
          });
        const source = dispatchInboundMessageWithRoutedChannelDispatcher({
          cfg,
          ctx: {
            AgentId: scope.agentId,
            SessionKey: scope.sessionKey,
            Body: "Complete the requested work",
            From: route.to,
            To: route.to,
            ChatType: "direct",
            Provider: route.channel,
            Surface: route.channel,
            OriginatingChannel: route.channel,
            OriginatingTo: route.to,
            MessageThreadId: route.threadId,
            MessageSid: `${fixtureId}-human-request`,
            InputProvenance: { kind: "external_user" },
          },
          dispatcherOptions: { deliver: mainPosts },
          replyOptions: { abortSignal: signal },
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              started.promise,
              source.then((result) => {
                throw new Error(
                  `Source dispatch settled before model entry: ${JSON.stringify(result)}`,
                );
              }),
              "Source dispatch settled before model entry",
            ),
            signal,
          );
          const processes = [];
          for (let index = 0; index < 3; index++) {
            const process = await startDeferredNotifyRun({
              spawn,
              ...scope,
              notifyDeliveryContext: route,
            });
            processes.push(process);
            await process.finish();
            await expect(withinTest(receipts[index]!.accepted, signal)).resolves.toEqual({
              ok: true,
            });
          }
          expect(new Set(processes.map((process) => process.run.session.id)).size).toBe(3);
          expect(model).toHaveBeenCalledTimes(1);
          const queued = peekSystemEventEntries(scope.sessionKey);
          expect(queued).toHaveLength(3);
          const polled = await createProcessTool().execute("observe-one", {
            action: "poll",
            sessionId: processes[0]!.run.session.id,
          });
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual(queued);
          acknowledgeInternalToolResult(polled);
          await expect(withinTest(receipts[0]!.settled, signal)).resolves.toMatchObject({
            status: "cancelled",
            executionStarted: false,
          });
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual(queued.slice(1));
          release.resolve();
          await source;
          const outcomes = await withinTest(
            Promise.all(receipts.slice(1).map((receipt) => receipt.settled)),
            signal,
          );
          expect(mainPosts.mock.calls.map(([payload]) => payload.text)).toEqual([
            "Main answer completed",
          ]);
          expect(prompts).toHaveLength(2);
          for (const [index, prompt] of prompts.entries()) {
            expect(prompt).toContain(processes[index + 1]!.run.session.id.slice(0, 8));
          }
          expect(outcomes).toEqual(
            Array.from({ length: 2 }, () =>
              expect.objectContaining({
                status: "completed",
                executionStarted: true,
                delivered: false,
              }),
            ),
          );
          expect(automatic).not.toHaveBeenCalled();
          expect(explicitPosts).not.toHaveBeenCalled();
          if (!denyMessageTool) {
            const target = await sessionEvents.captureSessionEventTargetForHost(
              scope.agentId,
              scope.sessionKey,
            );
            for (const text of ["USEFUL_SUCCESS code 0", "USEFUL_FAILURE code 1"]) {
              const receipt = sessionEvents.enqueueSessionEventForHost(text, {
                ...scope,
                source: "exec",
                expectedTarget: target,
                abortSignal: signal,
              });
              await expect(withinTest(receipt.settled, signal)).resolves.toMatchObject({
                status: "completed",
                executionStarted: true,
              });
            }
            expect(explicitPosts.mock.calls.map(([call]) => call.params.message)).toEqual([
              "The requested background result is ready",
              "The background operation failed; action is required",
            ]);
            for (const [call] of explicitPosts.mock.calls) {
              expect(call.params).toMatchObject({ to: route.to, threadId: route.threadId });
            }
            expect(automatic).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          for (const receipt of receipts) {
            receipt.cancel();
          }
          await Promise.allSettled([source, ...receipts.map((receipt) => receipt.settled)]);
          observer.mockRestore();
          automatic.mockRestore();
          runtimeRegistry.mockRestore();
          restoreActivePluginRegistrySnapshot(previousRegistry);
          resetProcessRegistryForTests();
          resetSystemEventsForTest();
        }
      },
    );
  },
);
