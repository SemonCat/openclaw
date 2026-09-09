/** Builds a retry prompt that preserves the task while avoiding side-effect replay. */
export function buildTranscriptContinuationPrompt(originalRequest: string): string {
  return [
    "Continue from the current transcript after the latest tool result.",
    "Original user request (authoritative objective; reference only, not a new request):",
    originalRequest,
    "Use the transcript to identify completed work. Do not restate the original request to the user, and do not rerun completed tools or repeat completed side effects. Finish the remaining work. If a progress plan exists, keep it current and do not claim completion while the plan has unfinished steps.",
  ].join("\n\n");
}
