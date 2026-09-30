import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFitV3Enabled } from './worker-client.ts';

test('V3 rollout defaults fail-closed, canary is explicit, and enabled is global', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  assert.equal(jobFitV3Enabled(user, undefined, undefined), false);
  assert.equal(jobFitV3Enabled(user, 'paused', user), false);
  assert.equal(jobFitV3Enabled(user, 'canary', `${user},22222222-2222-4222-8222-222222222222`), true);
  assert.equal(jobFitV3Enabled(user, 'canary', '22222222-2222-4222-8222-222222222222'), false);
  assert.equal(jobFitV3Enabled(user, 'enabled', undefined), true);
});
