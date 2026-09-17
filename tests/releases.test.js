import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableRelease, checkForRelease } from '../src/releases.js';

const release = (tag_name, extra = {}) => ({ tag_name, html_url: `https://github.com/stargazerwna/nodesatlas/releases/tag/${tag_name}`, ...extra });

test('only offers newer stable versions, comparing numbers rather than strings', () => {
  assert.equal(getAvailableRelease(release('v1.10.0'), '1.2.1').version, '1.10.0');
  assert.equal(getAvailableRelease(release('v2.0.0'), '1.9.9').version, '2.0.0');
  assert.equal(getAvailableRelease(release('v1.2.1'), '1.2.1'), null);
  assert.equal(getAvailableRelease(release('v1.2.0'), '1.2.1'), null);
  assert.equal(getAvailableRelease(release('v1.2.1'), '1.2.1-beta.1').version, '1.2.1');
  for (const item of [release('v2.0.0-beta.1'), release('v2.0.0', { draft: true }), release('v2.0.0', { prerelease: true }), release('invalid'), release('v2.0.0', { html_url: 'https://example.com' }), null]) {
    assert.equal(getAvailableRelease(item, '1.2.1'), null);
  }
});

test('handles GitHub responses and quietly tolerates failed checks', async () => {
  assert.equal((await checkForRelease('1.2.1', async () => ({ ok: true, json: async () => release('v1.3.0') }))).version, '1.3.0');
  for (const fetcher of [async () => ({ ok: false }), async () => { throw Error('offline'); }, async () => ({ ok: true, json: async () => { throw Error('invalid JSON'); } })]) {
    assert.equal(await checkForRelease('1.2.1', fetcher), null);
  }
});
