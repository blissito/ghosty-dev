// La fábrica del repo (gs «Pausar la fábrica», 22-nov): `factory status|pause|resume|schedule` y que next, claim y asks
// se detengan con la línea de la pausa y el código 6 (distinto de 1 = error y de 75 = sigue pendiente).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';

async function withGs(opts, fn) {
  const gs = await fakeGs(opts);
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  const file = join(s.config, 'ghosty-dev', 'auth.json');
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tok = gs.grant();
  writeFileSync(file, JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null }), { mode: 0o600 });
  const cli = (args) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1', GHOSTY_DEV_NO_LIVE: '1' } });
  try {
    await fn({ gs, s, cli });
  } finally {
    await gs.close();
  }
}

test('factory pause/resume/schedule/status hablan con /api/v2/me/repos/:o/:n/factory', () =>
  withGs({ factory: {} }, async ({ gs, cli }) => {
    const p = await cli(['factory', 'pause', '--until', '2026-11-23T08:00:00-06:00', '--reason', 'vacaciones']);
    assert.equal(p.code, 0, p.err);
    assert.match(p.out, /acme\/demo: Fábrica en pausa hasta las 8:00 \(vacaciones\)/);
    assert.deepEqual(gs.factoryCalls.at(-1).body, { action: 'pause', until: '2026-11-23T14:00:00.000Z', reason: 'vacaciones' });
    await cli(['factory', 'schedule', 'night', '--all']);
    assert.deepEqual(gs.factoryCalls.at(-1).body, { action: 'schedule', all: true, preset: 'night' });
    await cli(['factory', 'schedule', '* 9-17 * * 1-5']);
    assert.deepEqual(gs.factoryCalls.at(-1).body, { action: 'schedule', schedule: '* 9-17 * * 1-5' });
    const r = await cli(['factory', 'resume']);
    assert.match(r.out, /Fábrica encendida/);
    const st = await cli(['factory', '--json']);
    assert.equal(JSON.parse(st.out).active, true);
    assert.equal((await cli(['factory', 'pause', '--until', 'mañana'])).code, 1);
  }));

test('en pausa, next / claim / asks se detienen con su línea y salen 6; asks --peek sí lee', () =>
  withGs({ factory: { active: false, mode: 'paused', line: 'Fábrica en pausa hasta las 8:00' } }, async ({ s, cli }) => {
    for (const args of [['next'], ['claim', '5', '--no-worktree'], ['asks', '5']]) {
      const r = await cli(args);
      assert.equal(r.code, 6, `${args.join(' ')}: ${r.err}`);
      assert.match(r.err, /Fábrica en pausa hasta las 8:00\. No tomes trabajo nuevo; termina lo que traes y detente\./);
    }
    const j = await cli(['next', '--json']);
    assert.equal(j.code, 6);
    assert.equal(JSON.parse(j.out).factory.active, false);
    // El claim no tocó el issue.
    assert.deepEqual(s.read().issues[5].assignees, []);
    assert.equal((await cli(['asks', '5', '--peek'])).code, 0);
  }));

test('un gs que no conoce la fábrica (404) no estorba', () =>
  withGs({}, async ({ cli }) => {
    const r = await cli(['asks', '5']);
    assert.equal(r.code, 0, r.err);
  }));
