import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveIncompleteTurnPayloadText,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
} from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("incomplete-turn terminal metadata", () => {
  it("accepts a completed speech-only answer with provider reasoning", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        { type: "thinking", thinking: "Prepare a spoken greeting.", thinkingSignature: "" },
        { type: "text", text: "" },
      ],
      openclawDelivery: { tts: { tagged: true, text: "Have a lovely day." } },
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("keeps the provider refusal reason alongside the side-effect warning", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "anthropic",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 0,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(
      "The AI provider refused this request because it flagged possible cybersecurity risk (cyber_policy). Review the request and the provider's access requirements before continuing. Some actions may have completed; check their results. Note: some tool actions may have already been executed — please verify before retrying.",
    );
  });

  it.each([false, true])(
    "surfaces a content-filtered response with potential side effects: %s",
    (hadPotentialSideEffects) => {
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage: "Provider incomplete_reason: content_filter",
        diagnostics: [
          {
            type: "openai_responses_terminal",
            timestamp: 0,
            details: {
              eventType: "response.incomplete",
              stopReason: "error",
              incompleteReason: "content_filter",
              endTurn: "absent",
            },
          },
        ],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        currentAttemptAssistant: assistant,
        toolMetas: hadPotentialSideEffects ? [{ toolName: "exec" }] : [],
      });

      const text = resolveIncompleteTurnPayloadText({
        payloadCount: 0,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      });

      expect(text).toBe(
        "The AI provider stopped this response because of its content filter (content_filter). Review the request before trying again." +
          (hadPotentialSideEffects
            ? " Note: some tool actions may have already been executed — please verify before retrying."
            : ""),
      );
      if (hadPotentialSideEffects) {
        expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText: text })).toBe(true);
      }
    },
  );

  it("keeps an explicitly replay-safe structured provider refusal replayable", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "openai", category: "cyber" },
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      externalAbort: false,
      timedOut: false,
      attempt,
    });

    expect(incompleteTurnText).toContain("provider refused this request");
    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(false);
  });

  it("uses the current completed assistant instead of stale session tool-use evidence", () => {
    const staleAssistant = buildEmbeddedRunnerAssistant({ stopReason: "toolUse" });
    const currentAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Here is the final answer." }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Analysis...", "Here is the final answer."],
      toolMetas: [{ toolName: "update_plan" }],
      lastAssistant: staleAssistant,
      currentAttemptAssistant: currentAssistant,
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("keeps completed tool-use evidence incomplete when the current transcript slice is absent", () => {
    const assistant = buildEmbeddedRunnerAssistant({ stopReason: "toolUse" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Let me update the file..."],
      toolMetas: [{ toolName: "write" }],
      lastAssistant: assistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toContain("couldn't generate a response");
  });

  it("emits a silent cron reply from the trailing current-attempt tool result", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "NO_REPLY" }],
          details: { aggregated: "NO_REPLY" },
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        buildEmbeddedRunnerAssistant({}),
      ],
    });

    expect(
      resolveSilentToolResultReplyPayload({
        isCronTrigger: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toEqual({ text: "NO_REPLY" });
  });

  it("does not reuse an older silent tool result without current tool activity", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "NO_REPLY" }],
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        {
          role: "user",
          content: [{ type: "text", text: "Current cron prompt" }],
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        buildEmbeddedRunnerAssistant({}),
      ],
    });

    expect(
      resolveSilentToolResultReplyPayload({
        isCronTrigger: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });
});

describe("tool-authored source replies", () => {
  // A `canDeliverSourceReply` tool wrote the final answer; the host delivers it, so a
  // tool-use stop with no post-tool assistant text is not an incomplete turn.
  it("treats a final tool-authored source reply as a complete tool-use turn", () => {
    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt: makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          toolMetas: [{ toolName: "order_status", meta: "orderId=SO1" }],
          // A live run starts with no source reply delivered yet.
          sourceReplyDeliveryState: "missing",
          messagingToolSourceReplyPayloads: [
            {
              text: "Pedido SO1 creado.",
              sourceReplyFinal: true,
              toolAuthored: true,
            },
          ],
          lastAssistant: buildEmbeddedRunnerAssistant({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "order_status",
                arguments: { orderId: "SO1" },
              },
            ],
          }),
        }),
      }),
    ).toBeNull();
  });
});
