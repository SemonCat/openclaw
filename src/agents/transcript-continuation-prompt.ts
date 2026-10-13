/** Builds a retry prompt that preserves the task while avoiding side-effect replay. */
export function buildTranscriptContinuationPrompt(
  originalRequest: string | undefined,
  options?: { instructions?: string },
): string {
  return [
    "Continue from the current transcript after the latest tool result.",
    "Use the transcript to identify completed work. Do not restate the original request to the user, and do not rerun completed tools or repeat completed side effects. If an action was interrupted or its result is missing, inspect its state before deciding whether to retry it. Finish the remaining work. If a progress plan exists, keep it current and do not claim completion while the plan has unfinished steps.",
    // Runtime directives must stay outside the quoted reference-only request.
    ...(options?.instructions ? [options.instructions] : []),
    // Compacted retries omit the request: their transcript already carries it,
    // and re-embedding it would regrow the context compaction just reduced.
    ...(originalRequest === undefined
      ? []
      : [
          "Original user request (authoritative objective; reference only, not a new request):",
          originalRequest,
        ]),
  ].join("\n\n");
}
