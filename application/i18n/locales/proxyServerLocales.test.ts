import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'proxyServer.action.open',
  'proxyServer.panel.title',
  'proxyServer.panel.subtitle',
  'proxyServer.status.running',
  'proxyServer.status.stopped',
  'proxyServer.toggle.label',
  'proxyServer.toggle.desc',
  'proxyServer.field.port',
  'proxyServer.field.scope',
  'proxyServer.scope.loopback',
  'proxyServer.scope.lan',
  'proxyServer.field.upstream',
  'proxyServer.upstream.direct',
  'proxyServer.field.auth',
  'proxyServer.field.username',
  'proxyServer.field.password',
  'proxyServer.endpoint.title',
  'proxyServer.endpoint.http',
  'proxyServer.endpoint.socks5',
  'proxyServer.stats.connections',
  'proxyServer.stats.requests',
  'proxyServer.stats.failures',
  'proxyServer.hint.both',
  'proxyServer.warning.openLan',
  'proxyServer.error.port',
  'proxyServer.error.credentials',
  'proxyServer.error.portInUse',
  'proxyServer.error.permissionDenied',
  'proxyServer.error.listenFailed',
  'proxyServer.error.missingUpstream',
  'proxyServer.error.unsupportedUpstream',
  'proxyServer.toast.started',
  'proxyServer.toast.stopped',
  'proxyServer.copy',
  'proxyServer.copied',
] as const;

test('local proxy server copy exists in every locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing local proxy server copy`);
  }
});

test('endpoint and port messages keep their placeholders', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    assert.match(messages['proxyServer.toast.started'] ?? '', /\{endpoint\}/, `${locale} started toast`);
    assert.match(messages['proxyServer.error.portInUse'] ?? '', /\{port\}/, `${locale} port-in-use copy`);
    assert.match(messages['proxyServer.error.permissionDenied'] ?? '', /\{port\}/, `${locale} permission copy`);
  }
});

test('the LAN warning tells the user the listener is unprotected', () => {
  assert.match(en['proxyServer.warning.openLan'] ?? '', /without a password/);
  assert.match(zhCN['proxyServer.warning.openLan'] ?? '', /未设置密码/);
  assert.match(zhTW['proxyServer.warning.openLan'] ?? '', /未設定密碼/);
  assert.match(es['proxyServer.warning.openLan'] ?? '', /sin contraseña/);
  assert.match(ru['proxyServer.warning.openLan'] ?? '', /без пароля/);
});
