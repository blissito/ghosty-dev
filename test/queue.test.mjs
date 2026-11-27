// La fila desde la terminal (feedback del 26-nov en Formmy): dormidos que se despiertan, «Sigue» de gs en `cloud`
// y por qué no avanza la fábrica con el comando que lo destraba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';
import { queueOf } from '../src/cloud.mjs';

async function withCloud(opts, fn, issues = { 5: issue(5, 'Salud') }) {
  const gs = await fakeGs(opts);
  const s = setup({ issues });
  const file = join(s.config, 'ghosty-dev', 'auth.json');
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tok = gs.grant();
  writeFileSync(file, JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null }), { mode: 0o600 });
  const cli = (args) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } });
  try {
    await fn({ gs, cli, s });
  } finally {
    await gs.close();
  }
}

const sleepy = { id: 'run1', repo: 'acme/demo', issue: 5, title: 'Salud', phase: 'working', estado: 'Trabajando', sleepingAt: '2026-11-27T04:13:48.000Z', next: { line: 'Siguiente: escribir · le toca al agente', owner: 'agent', label: 'Escribir' } };

test('wake y sleep usan las ops del servidor', () =>
  withCloud({ runs: [{ ...sleepy }] }, async ({ gs, cli }) => {
    const w = await cli(['wake', '5']);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /#5 despierto/);
    assert.deepEqual(gs.devCalls.at(-1).body, { op: 'wake' });
    const s = await cli(['sleep', '5']);
    assert.equal(s.code, 0, s.err);
    assert.deepEqual(gs.devCalls.at(-1).body, { op: 'sleep' });
  }));

test('tell --again sobre un pendiente dormido lo despierta primero (nunca queda en fila mudo)', () =>
  withCloud({ runs: [{ ...sleepy }] }, async ({ gs, cli }) => {
    const r = await cli(['tell', '5', '--again']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Estaba dormido: lo desperté/);
    const ops = gs.devCalls.filter((c) => c.method === 'POST').map((c) => c.body.op);
    assert.deepEqual(ops, ['wake', 'resume']);
  }));

test('cloud pinta el «Sigue» de gs, los dormidos y la fila con el comando que destraba', () =>
  withCloud({ runs: [{ ...sleepy }], localRows: [{ issue: 96, title: 'Agente crear', notStarted: true, phase: 'queued' }, { issue: 77, title: 'Formmy Crear', phase: 'queued', blocked: { by: 96 } }] }, async ({ cli }) => {
    const r = await cli(['cloud']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#5\tDormido · Trabajando\tSalud/);
    assert.match(r.out, /Sigue: Siguiente: escribir · le toca al agente/);
    assert.match(r.out, /#96\tSin empezar\tAgente crear/);
    assert.match(r.out, /#77\tEn terminal · espera #96/);
    assert.match(r.out, /#5 está dormido: ghosty-dev wake 5/);
    assert.match(r.out, /#77 espera a #96, que nadie ha empezado: ghosty-dev claim 96 --cloud/);
  }));

test('queueOf: sin nada vivo y fábrica en pausa, la primera razón es la pausa', () => {
  const q = queueOf({ runs: [], local: [{ number: 9, notStarted: true, blocked: null }], prs: [], factory: { on: false, pausedUntil: null } });
  assert.equal(q.working, 0);
  assert.deepEqual(q.fixes.map((f) => f.cmd), ['ghosty-dev factory resume', 'ghosty-dev claim 9 --cloud']);
});

test('cloud --json conserva el arreglo de runs; --queue trae tablero y fila', () =>
  withCloud({ runs: [{ ...sleepy }], localRows: [{ issue: 96, title: 'Agente crear', notStarted: true, phase: 'queued' }] }, async ({ cli }) => {
    const plain = JSON.parse((await cli(['cloud', '--json'])).out);
    assert.ok(Array.isArray(plain));
    assert.equal(plain[0].sleeping, true);
    assert.equal(plain[0].next.owner, 'agent');
    const full = JSON.parse((await cli(['cloud', '--json', '--queue'])).out);
    assert.equal(full.local[0].number, 96);
    assert.ok(full.queue.fixes.some((f) => f.cmd === 'ghosty-dev claim 96 --cloud'));
  }));

test('env: riesgos en palabras, agrupados y sólo de lo que se subió', async () => {
  const { riskLines } = await import('../src/env.mjs');
  const risks = [{ key: 'SES_KEY', risk: 'real_email' }, { key: 'SES_SECRET', risk: 'real_email' }, { key: 'MONGO_ATLAS', risk: 'remote_db' }];
  assert.deepEqual(riskLines(risks, ['TURNSTILE_SITE_KEY']), []);
  const all = riskLines(risks);
  assert.equal(all.length, 2);
  assert.match(all[0], /SES_KEY, SES_SECRET manda correo real/);
  assert.match(all[1], /MONGO_ATLAS apunta a una base remota/);
});

test('confirm --image sube las capturas y confirma por la op del run', () =>
  withCloud({ runs: [{ ...sleepy, sleepingAt: null }] }, async ({ gs, cli }) => {
    const { mkdtempSync } = await import('node:fs');
    const d = mkdtempSync(join((await import('node:os')).tmpdir(), 'gd-img-'));
    const img = join(d, 'login.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await cli(['confirm', '5', '--criterion', '2', '--image', img]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /confirmado con 1 captura/);
    assert.equal(gs.uploads[0].name, 'login.png');
    assert.equal(gs.uploads[0].mime, 'image/png');
    const call = gs.devCalls.at(-1);
    assert.equal(call.body.op, 'confirm');
    assert.equal(call.body.criterion, 2);
    assert.equal(call.body.attachments[0].url, 'https://files.test/f1');
  }));

test('labels: «en la nube» sin run vivo se señala y --fix la regresa a su estado', () =>
  withCloud(
    { runs: [{ ...sleepy, issue: 5 }] },
    async ({ cli, s }) => {
      const r = await cli(['labels']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /sin nada corriendo: #8/);
      assert.doesNotMatch(r.out, /#5/);
      const f = await cli(['labels', '--fix']);
      assert.equal(f.code, 0, f.err);
      assert.match(f.out, /#8: quité «en la nube» → listo/);
      assert.ok(!s.read().issues[8].labels.includes('ghosty-dev:en-nube'));
    },
    { 5: issue(5, 'Salud', { labels: ['ghosty-dev:en-nube'] }), 8: issue(8, 'Viejo', { labels: ['ghosty-dev:en-nube'] }) },
  ));
