import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { YIELD_DIAGNOSTIC_TEXT } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

function prepareYield(
  input: {
    yieldDetected?: boolean;
    assistantTexts?: string[];
    assistantErrorMessage?: string;
    continuation?: boolean;
    codeModeEngaged?: boolean;
    trigger?: Parameters<typeof prepareEmbeddedRunTerminal>[0]["runParams"]["trigger"];
    terminalState?: EmbeddedRunTerminalState;
    lastToolError?: NonNullable<Parameters<typeof makeEmbeddedRunnerAttempt>[0]>["lastToolError"];
    attempt?: Partial<EmbeddedRunAttemptWithReceiptEvidence>;
  } = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "aborted",
    errorMessage: input.assistantErrorMessage,
    content: [{ type: "toolCall", id: "yield-call", name: "sessions_yield", arguments: {} }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal:
      input.yieldDetected === false ? { kind: "ok" } : { kind: "aborted", source: "yield_cleanup" },
    assistantTexts: input.assistantTexts ?? [],
    lastAssistant: assistant,
    currentAttemptAssistant: undefined,
    // The subscriber retains message_end after yield strips the synthetic abort from history.
    currentAttemptCompletedAssistant: assistant,
    yieldDetected: input.yieldDetected ?? true,
    runtimeContinuationStarted: input.continuation ?? true,
    codeModeEngaged: input.codeModeEngaged,
    lastToolError: input.lastToolError ?? { toolName: "exec", error: "Command exited with code 1" },
    toolMetas: [{ toolName: "exec", isError: true }],
    ...input.attempt,
  });
  const terminal = makeTerminalInput({
    attempt,
    runParams: { trigger: input.trigger, authProfileStateMode: "read-only" },
    ...(input.terminalState ? { terminalState: input.terminalState } : {}),
  });
  const prepared = prepareEmbeddedRunTerminal({
    runParams: {
      ...terminal.runParams,
      admittedRunContext: createTestAdmittedRunContext("run:terminal-resolution"),
    },
    attempt,
    currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
    provider: "openai",
    model: "mock-1",
    activeErrorContext: { provider: "openai", model: "mock-1" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: terminal.terminalState,
  });
  return { attempt, terminal, prepared };
}

describe("yielded terminal payloads after an earlier tool failure", () => {
  it.each([false, true])(
    "does not replay tool-call prose after a textless yield (signed commentary=%s)",
    async (signedCommentary) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "yield-progress",
        onAgentEvent,
        onPartialReply: () => false,
      });
      try {
        for (const [index, text] of [
          "Inspecting the files.",
          "Checking the tests.",
          "Waiting for work.",
        ].entries()) {
          const message = buildEmbeddedRunnerAssistant({
            api: "openai-completions",
            stopReason: "toolUse",
            content: [
              {
                type: "text",
                text,
                ...(signedCommentary
                  ? {
                      textSignature: JSON.stringify({
                        v: 1,
                        id: `progress-${index}`,
                        phase: "commentary",
                      }),
                    }
                  : {}),
              },
              { type: "toolCall", id: `call-${index}`, name: "exec", arguments: {} },
            ],
          });
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
        }
        const yieldMessage = buildEmbeddedRunnerAssistant({
          api: "openai-completions",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
        });
        emit({ type: "message_start", message: yieldMessage });
        emit({ type: "message_end", message: yieldMessage });
        await subscription.waitForPendingEvents();
        expect(subscription.assistantTexts).toHaveLength(signedCommentary ? 0 : 3);
        if (signedCommentary) {
          expect(
            onAgentEvent.mock.calls
              .map(([event]) => event)
              .filter((event) => event.stream === "item" && event.data.kind === "preamble"),
          ).toEqual(
            ["Inspecting the files.", "Checking the tests.", "Waiting for work."].map(
              (progressText) =>
                expect.objectContaining({
                  stream: "item",
                  data: expect.objectContaining({ kind: "preamble", phase: "end", progressText }),
                }),
            ),
          );
        }
        const { terminal, prepared } = prepareYield({
          assistantTexts: [...subscription.assistantTexts],
          attempt: { lastAssistant: yieldMessage, currentAttemptCompletedAssistant: yieldMessage },
        });
        expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
        const result = await resolveEmbeddedRunTerminal({ ...terminal, prepared });
        expect(result.action).toBe("complete");
        if (result.action !== "complete") {
          throw new Error("Expected a paused terminal result");
        }
        expect(result.result.payloads ?? []).toEqual([]);
        expect(result.result.meta).toMatchObject({ yielded: true, livenessState: "paused" });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      assistantTexts: [],
      assistantErrorMessage: "Agent run aborted",
      continuation: true,
      lastToolError: { toolName: "sessions_send", error: "Gateway delivery is unconfirmed" },
    },
    {
      assistantTexts: ["Checking the task.", "Waiting for the child."],
      assistantErrorMessage: "Agent run aborted",
      continuation: true,
      lastToolError: { toolName: "sessions_send", error: "Gateway delivery is unconfirmed" },
    },
    {
      assistantTexts: [],
      continuation: true,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
    },
    {
      assistantTexts: [],
      continuation: false,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
    },
  ])(
    "preserves cleanup-error suppression and continuation: $assistantTexts / $continuation",
    async (input) => {
      const { attempt, terminal, prepared } = prepareYield(input);
      expect(attempt.lastToolError).toBe(input.lastToolError);
      expect(terminal.terminalState.outcome.status).toBe("ok");
      expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
      expect(prepared.payloadsWithToolMedia?.some((payload) => payload.isError)).not.toBe(true);
      expect(prepared.attemptToolSummary).toMatchObject({
        unresolvedError: { toolName: input.lastToolError.toolName },
      });
      const result = await resolveEmbeddedRunTerminal({ ...terminal, prepared });
      expect(result.action).toBe("complete");
      if (result.action !== "complete") {
        throw new Error("Expected a paused terminal result");
      }
      expect(result.result.meta).toMatchObject({
        yielded: true,
        aborted: false,
        livenessState: "paused",
      });
      expect(result.result.meta.error).toBeUndefined();
      expect(result.result.meta.toolSummary).toMatchObject({
        unresolvedError: { toolName: input.lastToolError.toolName },
      });
      expect(result.result.payloads ?? []).toEqual(
        input.continuation ? [] : [{ text: YIELD_DIAGNOSTIC_TEXT }],
      );
      expect(terminal.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it("keeps a genuine final answer authoritative over preceding tool-call prose", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Actual answer." }],
    });
    const { prepared } = prepareYield({
      yieldDetected: false,
      assistantTexts: ["Checking the files.", "Actual answer."],
      attempt: {
        lastAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        lastToolError: undefined,
      },
    });
    expect(prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Actual answer." }),
    ]);
  });

  it("preserves earlier input answers while discarding the yielded input's prose", () => {
    const assistantTexts = ["Earlier answer.", "Checking the next input."];
    const { prepared } = prepareYield({
      assistantTexts,
      attempt: {
        answerSegments: [
          {
            textEnd: 1,
            messageEnd: 0,
            finalMessageStart: 0,
            lastAssistant: buildEmbeddedRunnerAssistant({
              content: [{ type: "text", text: "Earlier answer." }],
            }),
          },
        ],
      },
    });
    expect(prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Earlier answer." }),
    ]);
    expect(getReplyPayloadMetadata(prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject({
      precedingInputAnswer: true,
    });
    expect(assistantTexts).toEqual(["Earlier answer.", "Checking the next input."]);
  });

  it("preserves a kept answer's media directives and tool-produced attachments", () => {
    const { prepared } = prepareYield({
      assistantTexts: ["Checking the files."],
      attempt: {
        keptAnswer: {
          assistant: buildEmbeddedRunnerAssistant({
            content: [
              { type: "text", text: "Completed answer.\nMEDIA:https://example.test/answer.png" },
            ],
          }),
          messageIndex: 0,
        },
        toolMediaUrls: ["https://example.test/tool.png"],
      },
    });
    expect(prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        text: "Completed answer.",
        mediaUrls: ["https://example.test/answer.png", "https://example.test/tool.png"],
      }),
    ]);
  });

  it.each(["missing", "pending"] as const)(
    "preserves tool-authored replies and %s source delivery custody",
    (sourceReplyDeliveryState) => {
      const { prepared } = prepareYield({
        assistantTexts: ["Checking the files."],
        attempt: {
          sourceReplyDeliveryState,
          messagingToolSourceReplyPayloads: [{ text: "Tool answer.", toolAuthored: true }],
          toolMediaUrls: ["https://example.test/tool.png"],
        },
      });
      expect(prepared.payloadsWithToolMedia).toEqual(
        sourceReplyDeliveryState === "pending"
          ? [expect.objectContaining({ text: "Tool answer." })]
          : [
              expect.objectContaining({
                text: "Tool answer.",
                mediaUrls: ["https://example.test/tool.png"],
              }),
            ],
      );
      if (sourceReplyDeliveryState === "pending") {
        expect(prepared.payloadsWithToolMedia?.[0]?.mediaUrls).toBeUndefined();
      }
      expect(prepared.replyDeliveryState).toBe(sourceReplyDeliveryState);
    },
  );

  it.each([
    {
      name: "an ordinary completed turn",
      yieldDetected: false,
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
    },
    {
      name: "a failed yielded turn",
      yieldDetected: true,
      outcome: { reason: "failed", status: "error", error: "Provider failed" },
    },
    {
      name: "a timed-out yielded turn",
      yieldDetected: true,
      outcome: {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    },
  ] satisfies {
    name: string;
    yieldDetected: boolean;
    outcome: EmbeddedRunTerminalState["outcome"];
  }[])("retains tool-error presentation for $name", ({ yieldDetected, outcome }) => {
    const { prepared } = prepareYield({
      yieldDetected,
      terminalState: { outcome, signalOwnedInterruption: false },
    });
    const warning = prepared.payloadsWithToolMedia?.find((payload) => payload.isError);
    expect(warning).toMatchObject({ text: expect.stringContaining("failed"), isError: true });
    expect(getReplyPayloadMetadata(warning ?? {})).toMatchObject({
      toolErrorWarning: { toolName: "exec" },
    });
  });

  it("preserves restart presentation when a yielded turn is cancelled", () => {
    const { prepared } = prepareYield({
      terminalState: {
        outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
        signalOwnedInterruption: true,
      },
    });
    expect(prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Gateway restarting…" }),
    ]);
    expect(prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
  });

  it("retains safe Code Mode cron failure metadata during a clean yield", () => {
    const { prepared } = prepareYield({
      codeModeEngaged: true,
      trigger: "cron",
      lastToolError: {
        toolName: "exec",
        error:
          "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
      },
    });
    expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
    expect(prepared.terminalToolFailure).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("retains fatal cron denial diagnostics without warning on a clean yield", () => {
    const denial = {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error: "SYSTEM_RUN_DENIED: approval required",
    };
    const { attempt, prepared } = prepareYield({ lastToolError: denial, trigger: "cron" });
    expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
    expect(attempt.lastToolError).toBe(denial);
    expect(prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: denial.error,
      fatalForCron: true,
    });
  });
});
