import assert from 'node:assert/strict';
import * as guards from '../desktop/src/lib/sessionGuards.ts';

const api: any = (guards as any).default || guards;

function testResolveQuestionSessionKey() {
  const map = new Map<string, string>();
  map.set('req-1', 'desktop:dm:a');
  assert.equal(api.resolveQuestionSessionKey('req-1', undefined, map), 'desktop:dm:a');
  assert.equal(api.resolveQuestionSessionKey('req-1', 'desktop:dm:b', map), 'desktop:dm:b');
  assert.equal(api.resolveQuestionSessionKey(undefined, undefined, map), undefined);
}

function testSnapshotPendingGate() {
  const pending = { requestId: 'req-1', questions: [] };
  assert.equal(
    api.shouldAcceptSnapshotPending({
      snapshotPending: pending,
      currentToolName: 'AskUserQuestion',
      sessionKey: 'desktop:dm:a',
    }),
    true,
  );
  assert.equal(
    api.shouldAcceptSnapshotPending({
      snapshotPending: pending,
      currentToolName: 'Read',
      statePendingRequestId: 'req-1',
      sessionKey: 'desktop:dm:a',
    }),
    true,
  );
  assert.equal(
    api.shouldAcceptSnapshotPending({
      snapshotPending: pending,
      currentToolName: 'Read',
      mappedSessionKey: 'desktop:dm:a',
      sessionKey: 'desktop:dm:a',
    }),
    true,
  );
  assert.equal(
    api.shouldAcceptSnapshotPending({
      snapshotPending: pending,
      currentToolName: 'Read',
      mappedSessionKey: 'desktop:dm:b',
      sessionKey: 'desktop:dm:a',
    }),
    false,
  );
}

function testNoTruncation() {
  const text = 'x'.repeat(5000);
  const out = api.normalizeToolResultText(text);
  assert.equal(out.length, 5000);
  assert.equal(out, text);
}

function testSessionListKey() {
  assert.equal(api.getSessionListKey('desktop:dm:abc'), 'desktop:dm:abc');
  assert.equal(api.getSessionListKey(undefined), 'default-session');
}

function main() {

  testResolveQuestionSessionKey();
  testSnapshotPendingGate();
  testNoTruncation();
  testSessionListKey();
  console.log('desktop regressions: ok');
}

main();