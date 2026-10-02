import './env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { parseTrustProxy, resolveListen, createApp } = await import('../server/index.js');

afterEach(() => { delete process.env.TRUST_PROXY; });

test('parseTrustProxy understands the values Express accepts', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(''), undefined);
  assert.equal(parseTrustProxy('   '), undefined);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy(' loopback, 10.0.0.0/8 '), 'loopback, 10.0.0.0/8');
});

test('resolveListen defaults to port 3000 on all interfaces', () => {
  assert.deepEqual(resolveListen({}), { port: 3000, host: undefined });
  assert.deepEqual(resolveListen({ PORT: '8080', HOST: '127.0.0.1' }), { port: 8080, host: '127.0.0.1' });
  assert.deepEqual(resolveListen({ HOST: '' }), { port: 3000, host: undefined });
});

test('createApp applies TRUST_PROXY', () => {
  assert.ok(!createApp().get('trust proxy'), 'off by default');
  process.env.TRUST_PROXY = 'loopback';
  assert.equal(createApp().get('trust proxy'), 'loopback');
  process.env.TRUST_PROXY = '1';
  assert.equal(createApp().get('trust proxy'), 1);
});
