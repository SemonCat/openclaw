import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import type {
  GetReplyOptions,
  QueuedReplyDeliveryCorrelation,
} from "../get-reply-options.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { isFollowupRunAborted } from "./queue/types.js";

/** Presentation follows the collected source identities, never the current drain's source. */
export async function notifyQueuedFollowupDeliveryCorrelations(
  turn: AdmittedFollowupTurn,
  notify: (correlation: QueuedReplyDeliveryCorrelation) => Promise<void> | void,
): Promise<void> {
  for (const correlation of turn.queued.deliveryCorrelations ?? []) {
    if (
      turn.sendPolicy !== "allow" ||
      turn.queued.currentInboundEventKind === "room_event" ||
      isFollowupRunAborted(turn.queued) ||
      turn.operation.abortSignal.aborted
    ) {
      return;
    }
    try {
      turn.queued.operatorAuthority?.assertCurrent();
    } catch {
      return;
    }
    try {
      await notify(correlation);
    } catch (error) {
      defaultRuntime.error?.(
        `followup queue: source presentation failed: ${formatErrorMessage(error)}`,
      );
    }
  }
}

export async function settleQueuedFollowupPresentation(
  onQueuedFollowupSettled: GetReplyOptions["onQueuedFollowupSettled"],
): Promise<void> {
  try {
    await onQueuedFollowupSettled?.();
  } catch (error) {
    defaultRuntime.error?.(
      `followup queue: queued presentation cleanup failed: ${formatErrorMessage(error)}`,
    );
  }
}
