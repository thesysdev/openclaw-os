"use client";

import { resolveChatSessionKey } from "@/lib/engines/openclaw/OpenClawEngine";

/**
 * Reverse the `agentId -> sessionKey` lookup: given a session key, find
 * which known agent it resolves to. Used to route cron entries back to the
 * thread the user actually opens.
 */
export function sessionRouteIdFromSessionKey(
  sessionKey: string,
  knownAgentIds: Set<string>,
): string {
  for (const agentId of knownAgentIds) {
    if (resolveChatSessionKey(agentId, knownAgentIds) === sessionKey) {
      return agentId;
    }
  }

  return sessionKey;
}
