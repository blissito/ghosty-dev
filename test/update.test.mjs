import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, versionCheck, update, updateText, INSTALL_LINE, currentVersion } from '../src/update.mjs';
import { BUILD_SENSITIVE } from '../src/commands.mjs';

test('update: una sola fuente, versión vieja → nueva; doctor avisa con la línea exacta (fila 57)', () => {
  assert.equal(INSTALL_LINE, 'npm install -g github:blissito/ghosty-dev');
  assert.equal(compareVersions('0.9.9', '0.9.17'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  const old = versionCheck('0.9.9', '0.9.17');
  assert.match(old.detail, /ya hay 0\.9\.17/);
  assert.match(old.fix, /ghosty-dev update \(o: npm install -g github:blissito\/ghosty-dev\)/);
  assert.equal(versionCheck('0.9.17', '0.9.17').ok, true);
  assert.equal(versionCheck('0.9.17', null).ok, null);
  const calls = [];
  const r = update({ run: (c, a) => (calls.push([c, ...a]), { status: 0 }), globalRoot: () => '/no/existe' });
  assert.deepEqual(calls, [['npm', 'install', '-g', 'github:blissito/ghosty-dev']]);
  assert.equal(r.before, currentVersion());
  assert.match(updateText({ ok: true, before: '0.9.9', after: '0.9.17' }), /ghosty-dev 0\.9\.9 → 0\.9\.17/);
  assert.match(updateText(update({ run: () => ({ status: 1 }) })), /Corre a mano: npm install -g github:blissito\/ghosty-dev/);
});

test('pre-push: rutas y módulos servidor/cliente piden build (fila 52)', () => {
  for (const f of ['app/routes/api.crear.agui.ts', 'app/lib/db.server.ts', 'app/entry.client.tsx', 'vite.config.ts', 'src/pages/index.tsx', 'app/routes.ts']) assert.ok(BUILD_SENSITIVE.test(f), f);
  for (const f of ['README.md', 'app/lib/util.ts', 'test/x.test.mjs']) assert.ok(!BUILD_SENSITIVE.test(f), f);
});
