import { isHeartbeatAcknowledgementText } from "../../../auto-reply/heartbeat.js";
import { isExecCompletionTurn } from "../../../auto-reply/internal-turn-source.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { isRuntimeToolAllowed } from "../../tool-policy-match.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import { hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const EXEC_COMPLETION_DELIVERY_INSTRUCTION =
  "The internal exec completion ended with private assistant text and no confirmed source delivery. " +
  "Review the existing conversation and completed result. If there is a useful new result the user " +
  "is waiting for or a new actionable failure, send a concise notification using message(action=send) " +
  "to the captured current source conversation, honoring the tool's target requirements and " +
  "preserving its current thread. Do not copy private notes. " +
  "If the result is routine, stale, already reported, intentionally private, or no notification is " +
  "needed or permitted, finish with NO_REPLY. Do not repeat completed work or run other tools. " +
  "Ordinary assistant text still stays private.";

/** Offers one delivery decision under the terminal owner's existing run and route. */
export function tryRecoverExecCompletionDelivery(input: {
  runParams: RunEmbeddedAgentInternalParams;
  attempt: EmbeddedRunAttemptResult;
  attemptAssistant?: AssistantMessage;
  prepared: Pick<
    ReturnType<typeof prepareEmbeddedRunTerminal>,
    "replyDeliveryState" | "finalAssistantVisibleText"
  >;
  retryState: EmbeddedRunTerminalRetryState;
  sessionPromptState: Pick<
    Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>,
    "activateInternalPrompt"
  >;
  terminalInterrupted: boolean;
  settledTurnFinalizationAttempted: boolean;
}): boolean {
  const { runParams, attempt, retryState } = input;
  if (
    !isExecCompletionTurn({ InputProvenance: runParams.inputProvenance }) ||
    runParams.sourceReplyDeliveryMode !== "message_tool_only" ||
    runParams.currentInboundEventKind === "room_event" ||
    runParams.silentExpected === true ||
    runParams.disableTools === true ||
    runParams.disableMessageTool === true ||
    !isRuntimeToolAllowed("message", runParams.toolsAllow) ||
    runParams.canRecoverExecCompletionDelivery?.() !== true ||
    input.settledTurnFinalizationAttempted ||
    input.terminalInterrupted ||
    projectAgentRunAttemptTerminal(attempt.terminal).promptError ||
    isTerminalAssistantError(input.attemptAssistant) ||
    hasAttemptTerminalState({
      ...attempt,
      // A confirmed process failure is the result to report, not a delivered
      // reply. Keep message failures and every other terminal effect fenced.
      lastToolError:
        attempt.lastToolError?.terminalDiagnostic?.kind === "process"
          ? undefined
          : attempt.lastToolError,
    }) ||
    resolveSourceReplyDelivery(attempt, input.prepared.replyDeliveryState) !== "missing" ||
    isHeartbeatAcknowledgementText(input.prepared.finalAssistantVisibleText) ||
    !input.attemptAssistant ||
    !input.prepared.finalAssistantVisibleText ||
    retryState.execCompletionDeliveryAttempts >= 1
  ) {
    return false;
  }
  // A private final is not permission to send it. Restrict this same-run pass
  // to a source-bound tool decision; its ordinary output remains private.
  retryState.execCompletionDeliveryAttempts += 1;
  runParams.execCompletionDeliveryRecovery = {
    timestamp: input.attemptAssistant.timestamp,
    responseId: input.attemptAssistant.responseId,
    turnId: input.attemptAssistant.turnId,
    visibleText: input.prepared.finalAssistantVisibleText,
  };
  runParams.toolsAllow = ["message"];
  runParams.disableToolSearch = true;
  runParams.codeModeOverride = false;
  runParams.forceCodeModeTools = undefined;
  input.sessionPromptState.activateInternalPrompt(EXEC_COMPLETION_DELIVERY_INSTRUCTION);
  return true;
}
