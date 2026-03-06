export type PendingQuestionLite = {
  requestId: string;
  questions: unknown[];
};

export function resolveQuestionSessionKey(
  requestId: string | undefined,
  eventSessionKey: string | undefined,
  requestMap: Map<string, string>,
): string | undefined {
  if (eventSessionKey) return eventSessionKey;
  if (!requestId) return undefined;
  return requestMap.get(requestId);
}

export function shouldAcceptSnapshotPending(params: {
  snapshotPending: PendingQuestionLite | null;
  currentToolName?: string | null;
  statePendingRequestId?: string | null;
  mappedSessionKey?: string;
  sessionKey: string;
}): boolean {
  const p = params.snapshotPending;
  if (!p) return false;
  if (params.currentToolName === 'AskUserQuestion') return true;
  if (params.statePendingRequestId === p.requestId) return true;
  if (params.mappedSessionKey === params.sessionKey) return true;
  return false;
}

export function normalizeToolResultText(text: string): string {
  // Keep full text in state; rendering layer decides fold/virtualization.
  return text;
}

export function getSessionListKey(sessionKey?: string): string {
  return sessionKey || 'default-session';
}