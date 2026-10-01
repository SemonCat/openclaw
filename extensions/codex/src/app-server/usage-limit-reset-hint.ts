export const CODEX_USAGE_LIMIT_MESSAGE_PREFIX =
  "You've reached your Codex subscription usage limit.";

/** Preserves only provider or OpenClaw reset hints with a bounded known grammar. */
export function extractCodexResetHint(
  message: string | undefined,
  allowEnrichedHint: boolean,
): [text: string, recoveryAction: string] | undefined {
  if (!message) {
    return undefined;
  }
  if (allowEnrichedHint && message.startsWith(CODEX_USAGE_LIMIT_MESSAGE_PREFIX)) {
    const nextReset =
      /^ Next reset (in\s+\d+\s+(?:seconds?|minutes?|hours?|days?),\s+[A-Z][a-z]{2}\s+\d{1,2}(?:,\s+\d{4})?\s+at\s+\d{1,2}:\d{2}\s+[AP]M\s+\S{1,16})\.(?:\s|$)/u.exec(
        message.slice(CODEX_USAGE_LIMIT_MESSAGE_PREFIX.length),
      );
    if (nextReset?.[1]) {
      return [`Next reset ${nextReset[1].trim()}`, "Wait until the reset time"];
    }
  }
  const tryAgainAt = /\btry again\s+(at\s+[^.!?\n]+)(?:[.!?]|$)/iu.exec(message);
  const tryAgainRelative = /\btry again\s+((?:tomorrow|in\s+[^.!?\n]+)[^.!?\n]*)(?:[.!?]|$)/iu.exec(
    message,
  );
  const retryHint = tryAgainAt?.[1]?.trim() || tryAgainRelative?.[1]?.trim();
  return retryHint
    ? [`Codex says to try again ${retryHint}`, "Wait until the retry time"]
    : undefined;
}
