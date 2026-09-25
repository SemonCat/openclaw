// Use-time approval validation belongs to the live run and worker claim owners.
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type {
  AgentRuntimeDelegatedAuthority,
  AgentRuntimeIdentity,
} from "./agent-runtime-identity-token.js";
import { resolveMessageActionTurnCapability } from "./message-action-turn-capability.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

export type AgentRuntimeApprovalAuthorityValidator = (identity: AgentRuntimeIdentity) => boolean;

type WorkerTurnClaimValidator = {
  validateTurnClaim(claim: WorkerSessionTurnClaim): boolean;
};

function validateAgentRuntimeDelegatedAuthority(
  authority: AgentRuntimeDelegatedAuthority,
  placements?: WorkerTurnClaimValidator,
): boolean {
  if (!validateAgentRunDelegatedAuthority(authority)) {
    return false;
  }
  return authority.kind === "local"
    ? true
    : placements?.validateTurnClaim?.(authority.turnClaim) === true;
}

/** Builds the use-time approval gate from the run owner and canonical worker store. */
export function createAgentRuntimeApprovalAuthorityValidator(
  placements?: WorkerTurnClaimValidator,
): AgentRuntimeApprovalAuthorityValidator {
  return (identity) => {
    if (!validateAgentRuntimeDelegatedAuthority(identity.delegatedAuthority, placements)) {
      return false;
    }
    const messageActionContext = identity.messageActionContext;
    if (!messageActionContext) {
      return true;
    }
    if (!messageActionContext.turnCapability) {
      return false;
    }
    return Boolean(
      resolveMessageActionTurnCapability({
        token: messageActionContext.turnCapability,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: messageActionContext.sessionId,
      }),
    );
  };
}
