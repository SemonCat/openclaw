import type { AssistantMessage } from "@openclaw/llm-core";
import {
  appendAssistantMessageDiagnostic,
  readProviderRefusalReview,
  type ProviderRefusalReview,
} from "@openclaw/llm-core/diagnostics";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Compatible endpoints retain their provider identity for terminal refusal handling. */
export function recordOpenAICyberPolicyRefusal(output: AssistantMessage): void {
  if (output.stopReason !== "error" || output.errorCode !== "cyber_policy") {
    return;
  }
  appendAssistantMessageDiagnostic(output, {
    type: "provider_refusal",
    timestamp: Date.now(),
    details: { provider: output.provider, category: "cyber" },
  });
}

/** Responses uses snake_case; the ChatGPT app-server error envelope uses camelCase. */
export function readOpenAIMisalignmentReview(
  value: unknown,
  continuationSupported: boolean,
): ProviderRefusalReview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readProviderRefusalReview({
    explanation: value.detailed_explanation ?? value.detailedExplanation,
    errorType: value.error_type ?? value.errorType,
    ...(continuationSupported ? { continuation: value.steer } : {}),
  });
}
