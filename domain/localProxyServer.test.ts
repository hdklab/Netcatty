import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LOCAL_PROXY_SERVER_CONFIG,
  DEFAULT_LOCAL_PROXY_SERVER_PORT,
  buildLocalProxyAuth,
  formatLocalProxyEndpoint,
  isLocalProxyOpenToNetwork,
  normalizeLocalProxyServerConfig,
  resolveLocalProxyListenHost,
  resolveLocalProxyUpstream,
  validateLocalProxyServerConfig,
  type LocalProxyServerConfig,
} from './localProxyServer.ts';
import type { ProxyProfile } from './models.ts';

const profile = (id: string, config: ProxyProfile['config']): ProxyProfile => ({
  id,
  label: id,
  config,
  createdAt: 1,
});

const httpProfile = profile('http-1', {
  type: 'http',
  host: '10.0.0.9',
  port: 3128,
  username: 'proxy-user',
  password: 'proxy-pass',
});
const socksProfile = profile('socks-1', { type: 'socks5', host: '127.0.0.1', port: 1080 });
const commandProfile = profile('cmd-1', {
  type: 'command',
  host: '',
  port: 0,
  command: 'ssh -W %h:%p jump',
});

const configWith = (patch: Partial<LocalProxyServerConfig>): LocalProxyServerConfig => ({
  ...DEFAULT_LOCAL_PROXY_SERVER_CONFIG,
  ...patch,
});

test('a first-time enable is reachable from other devices', () => {
  assert.equal(DEFAULT_LOCAL_PROXY_SERVER_CONFIG.scope, 'lan');
  assert.equal(resolveLocalProxyListenHost(DEFAULT_LOCAL_PROXY_SERVER_CONFIG), '0.0.0.0');
});

test('normalizeLocalProxyServerConfig falls back to defaults for garbage input', () => {
  assert.deepEqual(normalizeLocalProxyServerConfig(null), DEFAULT_LOCAL_PROXY_SERVER_CONFIG);
  assert.deepEqual(normalizeLocalProxyServerConfig('nope'), DEFAULT_LOCAL_PROXY_SERVER_CONFIG);
  assert.deepEqual(normalizeLocalProxyServerConfig({}), DEFAULT_LOCAL_PROXY_SERVER_CONFIG);
});

test('normalizeLocalProxyServerConfig keeps valid values and drops invalid ones', () => {
  const normalized = normalizeLocalProxyServerConfig({
    enabled: true,
    scope: 'lan',
    port: 1081,
    upstreamProfileId: '  socks-1  ',
    authEnabled: true,
    username: 'catty',
    password: 'secret',
  });
  assert.deepEqual(normalized, {
    enabled: true,
    scope: 'lan',
    port: 1081,
    upstreamProfileId: 'socks-1',
    authEnabled: true,
    username: 'catty',
    password: 'secret',
  });

  const bad = normalizeLocalProxyServerConfig({ enabled: 'yes', scope: 'wan', port: 70000 });
  assert.equal(bad.enabled, false);
  assert.equal(bad.scope, DEFAULT_LOCAL_PROXY_SERVER_CONFIG.scope, 'unknown scope falls back to the default');
  const explicitLoopback = normalizeLocalProxyServerConfig({ scope: 'loopback' });
  assert.equal(explicitLoopback.scope, 'loopback');
  assert.equal(bad.port, DEFAULT_LOCAL_PROXY_SERVER_PORT);
  assert.equal(bad.upstreamProfileId, null);
});

test('validateLocalProxyServerConfig rejects bad ports and missing credentials', () => {
  assert.equal(validateLocalProxyServerConfig(configWith({ port: 1080 })), null);
  assert.equal(validateLocalProxyServerConfig(configWith({ port: 0 })), 'invalid-port');
  assert.equal(validateLocalProxyServerConfig(configWith({ port: 65536 })), 'invalid-port');
  assert.equal(
    validateLocalProxyServerConfig(configWith({ authEnabled: true, username: '   ' })),
    'invalid-credentials',
  );
  assert.equal(
    validateLocalProxyServerConfig(configWith({ authEnabled: true, username: 'catty' })),
    null,
  );
});

test('resolveLocalProxyListenHost maps the scope to a bind address', () => {
  assert.equal(resolveLocalProxyListenHost(configWith({ scope: 'loopback' })), '127.0.0.1');
  assert.equal(resolveLocalProxyListenHost(configWith({ scope: 'lan' })), '0.0.0.0');
});

test('buildLocalProxyAuth returns credentials only when enabled and named', () => {
  assert.equal(buildLocalProxyAuth(configWith({})), null);
  assert.equal(buildLocalProxyAuth(configWith({ authEnabled: true, username: '' })), null);
  assert.deepEqual(
    buildLocalProxyAuth(configWith({ authEnabled: true, username: ' catty ', password: 'p' })),
    { username: 'catty', password: 'p' },
  );
});

test('resolveLocalProxyUpstream resolves saved HTTP and SOCKS5 profiles', () => {
  const profiles = [httpProfile, socksProfile, commandProfile];
  assert.deepEqual(resolveLocalProxyUpstream(configWith({}), profiles), { upstream: null });
  assert.deepEqual(
    resolveLocalProxyUpstream(configWith({ upstreamProfileId: 'http-1' }), profiles),
    {
      upstream: {
        type: 'http',
        host: '10.0.0.9',
        port: 3128,
        username: 'proxy-user',
        password: 'proxy-pass',
      },
    },
  );
  assert.deepEqual(
    resolveLocalProxyUpstream(configWith({ upstreamProfileId: 'socks-1' }), profiles),
    { upstream: { type: 'socks5', host: '127.0.0.1', port: 1080 } },
  );
});

test('resolveLocalProxyUpstream never silently falls back to a direct exit', () => {
  const profiles = [commandProfile];
  assert.deepEqual(
    resolveLocalProxyUpstream(configWith({ upstreamProfileId: 'missing' }), profiles),
    { upstream: null, error: 'missing-upstream' },
  );
  assert.deepEqual(
    resolveLocalProxyUpstream(configWith({ upstreamProfileId: 'cmd-1' }), profiles),
    { upstream: null, error: 'unsupported-upstream' },
  );
  const broken = [profile('broken', { type: 'http', host: '  ', port: 3128 })];
  assert.deepEqual(
    resolveLocalProxyUpstream(configWith({ upstreamProfileId: 'broken' }), broken),
    { upstream: null, error: 'missing-upstream' },
  );
});

test('formatLocalProxyEndpoint brackets IPv6 hosts', () => {
  assert.equal(formatLocalProxyEndpoint('192.168.1.28', 1080, 'socks5'), 'socks5://192.168.1.28:1080');
  assert.equal(formatLocalProxyEndpoint('[::1]', 8080, 'http'), 'http://[::1]:8080');
  assert.equal(formatLocalProxyEndpoint('::1', 8080, 'http'), 'http://[::1]:8080');
});

test('isLocalProxyOpenToNetwork flags an unauthenticated LAN listener', () => {
  assert.equal(isLocalProxyOpenToNetwork(configWith({ scope: 'loopback' })), false);
  assert.equal(isLocalProxyOpenToNetwork(configWith({ scope: 'lan' })), true);
  assert.equal(
    isLocalProxyOpenToNetwork(configWith({ scope: 'lan', authEnabled: true, username: 'catty' })),
    false,
  );
});
