import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-events.js";
import { readSessionIdentityMutationVersion } from "../../sessions/session-lifecycle-events.js";
import { isGatewayAdmin } from "../session-sharing.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { collectTrackedActiveSessionRuns } from "./session-active-runs.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionListFence = {
  activeRuns: string;
  sessionIdentityMutationVersion: number;
  sessionsMutationVersion: number;
};
type SessionListOperation = SessionListFence & { promise: Promise<unknown> };
type SessionListCompleted = SessionListFence & { expiresAt?: number; result: SessionsListResult };
type SessionListState = {
  completed: Map<string, SessionListCompleted>;
  config: OpenClawConfig;
  inFlight: Map<string, SessionListOperation>;
};

const SESSIONS_LIST_COMPLETED_CACHE_LIMIT = 64;
const SESSIONS_LIST_MAX_CACHE_MS = 5_000;
const sessionListsByContext = new WeakMap<GatewayRequestContext, SessionListState>();

function readActiveRunFence(context: GatewayRequestContext): string {
  const projected = buildProjectedAgentRunIndex();
  const tracked = collectTrackedActiveSessionRuns(context).map((run) => [
    run.runId,
    run.sessionKey ?? "",
    run.sessionId ?? "",
    run.agentId ?? "",
  ]);
  return JSON.stringify([
    tracked.toSorted((left, right) => left.join("\0").localeCompare(right.join("\0"))),
    [...projected.sessionKeys].toSorted(),
    [...projected.sessionIds].toSorted(),
  ]);
}

function readSessionListFence(context: GatewayRequestContext): SessionListFence {
  return {
    activeRuns: readActiveRunFence(context),
    sessionIdentityMutationVersion: readSessionIdentityMutationVersion(),
    sessionsMutationVersion: readSessionsMutationVersion(context),
  };
}

function matchesSessionListFence(value: SessionListFence, fence: SessionListFence): boolean {
  return (
    value.activeRuns === fence.activeRuns &&
    value.sessionIdentityMutationVersion === fence.sessionIdentityMutationVersion &&
    value.sessionsMutationVersion === fence.sessionsMutationVersion
  );
}

function resolveSessionListExpiration(result: SessionsListResult): number | null {
  let expiresAt = Date.now() + SESSIONS_LIST_MAX_CACHE_MS;
  for (const session of result.sessions) {
    if (session.hasActiveRun || session.hasActiveSubagentRun || session.childSessions?.length) {
      return null;
    }
    const statusExpiration = session.agentStatus?.expiresAt;
    if (statusExpiration !== undefined && statusExpiration < expiresAt) {
      expiresAt = statusExpiration;
    }
  }
  return expiresAt;
}

function sessionListVisibilityIdentity(client: GatewayClient | null): string {
  if (isGatewayAdmin(client)) {
    return "admin";
  }
  const profileId = gatewayClientSessionCreator(client)?.id;
  return profileId ? `profile:${profileId}` : "anonymous";
}

function sessionListWorkKey(params: SessionsListParams, client: GatewayClient | null): string {
  return JSON.stringify([
    sessionListVisibilityIdentity(client),
    Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function sessionListState(
  context: GatewayRequestContext,
  config: OpenClawConfig,
): SessionListState {
  let state = sessionListsByContext.get(context);
  if (!state || state.config !== config) {
    state = { completed: new Map(), config, inFlight: new Map() };
    sessionListsByContext.set(context, state);
  }
  return state;
}

function rememberCompletedSessionList(
  state: SessionListState,
  workKey: string,
  completed: SessionListCompleted,
): void {
  state.completed.delete(workKey);
  state.completed.set(workKey, completed);
  while (state.completed.size > SESSIONS_LIST_COMPLETED_CACHE_LIMIT) {
    const oldest = state.completed.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    state.completed.delete(oldest);
  }
}

export async function respondWithCachedSessionList(params: {
  client: GatewayClient | null;
  config: OpenClawConfig;
  context: GatewayRequestContext;
  request: SessionsListParams;
  respond: RespondFn;
  run: () => Promise<SessionsListResult>;
}): Promise<void> {
  const workKey = sessionListWorkKey(params.request, params.client);
  const state = sessionListState(params.context, params.config);
  const fence = readSessionListFence(params.context);
  const cacheCompleted = params.request.activeMinutes === undefined && !params.request.spawnedBy;
  const completed = cacheCompleted ? state.completed.get(workKey) : undefined;
  if (completed && !matchesSessionListFence(completed, fence)) {
    // The beta.7 active-run fence is a state fingerprint rather than main's monotonic version.
    // Drop the older result on mismatch so an active -> idle ABA transition cannot revive it.
    state.completed.delete(workKey);
  }
  if (
    completed &&
    matchesSessionListFence(completed, fence) &&
    (completed.expiresAt === undefined || completed.expiresAt > Date.now())
  ) {
    params.respond(true, completed.result, undefined);
    return;
  }
  const pending = state.inFlight.get(workKey);
  if (pending && matchesSessionListFence(pending, fence)) {
    params.respond(true, await pending.promise, undefined);
    return;
  }

  let operation: SessionListOperation;
  const promise = new Promise<void>((done) => {
    setImmediate(done);
  })
    .then(() => {
      // Preserve beta.7's mutation safety: only the pre-start socket burst shares work.
      // Once loading begins, a direct store mutation that has no gateway context must make
      // the next request build a fresh projection instead of joining this one.
      if (state.inFlight.get(workKey) === operation) {
        state.inFlight.delete(workKey);
      }
      return params.run();
    })
    .then((result) => {
      if (cacheCompleted && matchesSessionListFence(readSessionListFence(params.context), fence)) {
        const expiresAt = resolveSessionListExpiration(result);
        if (expiresAt !== null && expiresAt > Date.now()) {
          rememberCompletedSessionList(state, workKey, { ...fence, result, expiresAt });
        }
      }
      return result;
    });
  operation = { ...fence, promise };
  state.inFlight.set(workKey, operation);
  try {
    params.respond(true, await promise, undefined);
  } finally {
    if (state.inFlight.get(workKey) === operation) {
      state.inFlight.delete(workKey);
    }
  }
}
