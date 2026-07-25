import type { OnsiteChatFrame } from '@shared/onsite-types';

export type OnsiteSessionReady = {
  sessionId: string;
  activeSessionId: string | null;
};

/**
 * Reads the canonical session mapping sent after an onsite hello. The
 * problemId guard prevents a delayed frame from the previously viewed problem
 * from changing the current problem's routing refs.
 */
export function readOnsiteSessionReady(
  frame: OnsiteChatFrame,
  problemId: string,
): OnsiteSessionReady | null {
  if (
    frame.kind !== 'onsite_session_ready'
    || frame.problemId !== problemId
    || typeof frame.sessionId !== 'string'
    || frame.sessionId.length === 0
  ) {
    return null;
  }

  return {
    sessionId: frame.sessionId,
    activeSessionId:
      typeof frame.activeSessionId === 'string' && frame.activeSessionId.length > 0
        ? frame.activeSessionId
        : null,
  };
}

/** Accept frames from the problem id, its canonical DB id, or an in-flight run id. */
export function isOnsiteFrameForSession(
  frameSessionId: string | undefined,
  problemId: string,
  canonicalSessionId: string,
  activeSessionId: string | null,
): boolean {
  if (!frameSessionId) return true;
  return frameSessionId === problemId
    || frameSessionId === canonicalSessionId
    || frameSessionId === activeSessionId;
}

/** True when an idle ack describes a subscription sent before a newer local run. */
export function isStaleOnsiteIdleAck(
  localRunStartedAt: number | null,
  subscribeSentAt: number,
): boolean {
  return localRunStartedAt !== null && localRunStartedAt >= subscribeSentAt;
}
