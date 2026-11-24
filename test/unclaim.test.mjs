// `unclaim` (soltar un claim local), el latido del claim sin PR y las `actions` que manda gs en show/cloud.
// Todo contra el gh falso y un gs falso: jamás toca un repo real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';
import { claimBeat } from '../src/writer.mjs';
import { actionCommand, actionLines, cleanActions } from '../src/cloud.mjs';

const mine = (n = 7, extra = {}) => issue(n, 'Salud', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'], ...extra });

test('unclaim: quita tu assignee, restituye por-hacer y deja el comentario con el motivo', () => {
  const s = setup({ issues: { 7: mine() } });
  const r = s.run('unclaim', '7', '--reason', 'ya salió en producción', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.released, true);
  const i = s.read().issues[7];
  assert.deepEqual(i.assignees, []);
  assert.deepEqual(i.labels, ['ghosty-dev:por-hacer']);
  assert.match(i.comments.at(-1).body, /unclaim.*Motivo: ya salió en producción/);
  // Con repo explícito (misma repo del directorio) y sin nada que soltar es idempotente.
  const again = s.run('unclaim', 'acme/demo#7', '--json');
  assert.equal(again.code, 0, again.err);
  assert.equal(JSON.parse(again.out).released, false);
});

test('unclaim: rechaza si otra persona lo tiene, sin tocar nada', () => {
  const s = setup({ issues: { 7: mine(7, { assignees: ['otra-persona'] }) } });
  const r = s.run('unclaim', '7');
  assert.equal(r.code, 1);
  assert.match(r.err, /lo tiene @otra-persona/);
  assert.deepEqual(s.read().issues[7].assignees, ['otra-persona']);
  assert.ok(s.read().calls.every((c) => c[2] === 'GET'), 'sólo lecturas');
});

test('unclaim: rechaza con un run vivo en la nube y manda a stop o teleport', async () => {
  const gs = await fakeGs({ runs: [{ id: 'run1', repo: 'acme/demo', issue: 7, title: 'Salud', phase: 'working', estado: 'trabajando' }] });
  const s = setup({ issues: { 7: mine() } });
  mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
  const tok = gs.grant();
  writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null }), { mode: 0o600 });
  try {
    const r = await s.runAsync(['unclaim', '7'], { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /va en la nube/);
    assert.match(r.err, /stop 7/);
    assert.match(r.err, /teleport 7/);
    assert.deepEqual(s.read().issues[7].assignees, ['agente-a']);
  } finally {
    await gs.close();
  }
});

test('release: su ayuda dice que reanuda y manda a unclaim para soltar un claim', () => {
  const r = setup().run('--help');
  assert.match(r.out, /release <n>\s+REANUDA/);
  assert.match(r.out, /unclaim <n>/);
});

test('claimBeat: pega al endpoint del claim; si el endpoint cae o falla, devuelve false sin lanzar', async () => {
  const calls = [];
  assert.equal(await claimBeat(9, { force: true, repo: 'acme/demo', send: async (m, p, b, o) => calls.push([m, p, b, o]) }), true);
  assert.deepEqual(calls[0], ['POST', '/api/v2/me/repos/acme/demo/issues/9/claim-beat', {}, { scope: 'dev' }]);
  assert.equal(await claimBeat(9, { force: true, repo: 'acme/demo', send: async () => { throw new Error('500') } }), false);
});

test('claimBeat: con el gh falso o GHOSTY_DEV_NO_BEAT no sale nada a la red', async () => {
  process.env.GHOSTY_DEV_GH = '/no/existe';
  assert.equal(await claimBeat(9, { repo: 'acme/demo', send: async () => assert.fail('no debía llamar') }), false);
});


async function withShow(opts, fn) {
  const gs = await fakeGs(opts);
  const s = setup({ issues: { 5: mine(5) } });
  mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
  const tok = gs.grant();
  writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null }), { mode: 0o600 });
  try {
    await fn((args) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } }), gs);
  } finally {
    await gs.close();
  }
}

test('show imprime las actions de gs con su comando de CLI exacto (fila local, sin run)', () =>
  withShow(
    {
      localRows: [
        {
          issue: 5,
          actions: [
            { id: 'start', label: 'Mandar a la nube', kind: 'start', primary: true },
            { id: 'release_claim', label: 'Soltar', kind: 'op', destructive: true },
            { id: 'open', label: 'Abrir en GitHub', kind: 'link', href: 'https://github.com/acme/demo/issues/5' },
            { id: 'merge', label: 'Merge', kind: 'op', disabled: { why: 'falta la revisión' } },
          ],
        },
      ],
    },
    async (cli) => {
      const r = await cli(['show', '5']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /→ Mandar a la nube \*: ghosty-dev claim 5 --cloud/);
      assert.match(r.out, /→ Soltar: ghosty-dev unclaim 5/);
      assert.match(r.out, /→ Abrir en GitHub: https:\/\/github\.com\/acme\/demo\/issues\/5/);
      assert.match(r.out, /→ Merge: no disponible: falta la revisión/);
      assert.doesNotMatch(r.out, /para cambiarlo/);
      assert.equal(JSON.parse((await cli(['show', '5', '--json'])).out).actions.length, 4);
    },
  ));

test('show con el run de la nube: stop, resume y cloud listan sus actions', () =>
  withShow({ runs: [{ id: 'run1', repo: 'acme/demo', issue: 5, title: 'Salud', phase: 'working', estado: 'trabajando', actions: [{ id: 'stop', label: 'Detener', kind: 'op' }, { id: 'resume', label: 'Otra vuelta', kind: 'op' }] }] }, async (cli) => {
    const r = await cli(['show', '5']);
    assert.match(r.out, /→ Detener: ghosty-dev stop 5/);
    assert.match(r.out, /→ Otra vuelta: ghosty-dev tell 5 --again/);
    const c = await cli(['cloud']);
    assert.match(c.out, /→ Detener: ghosty-dev stop 5/);
  }));

test('show sin actions (gs viejo) conserva el «para cambiarlo» de writerOf', () =>
  withShow({ runs: [{ id: 'run1', repo: 'acme/demo', issue: 5, title: 'Salud', phase: 'working', estado: 'trabajando' }] }, async (cli) => {
    const r = await cli(['show', '5']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /para cambiarlo: ghosty-dev teleport 5/);
    assert.doesNotMatch(r.out, /acciones:/);
  }));

test('cleanActions / actionCommand: descartan lo malformado y mapean cada id', () => {
  assert.equal(cleanActions(undefined), null);
  const a = cleanActions([{ id: 'stop', label: 'x' }, { id: 'MAL ID' }, null, { id: 'open', href: 'javascript:alert(1)' }]);
  assert.deepEqual(a.map((x) => x.id), ['stop', 'open']);
  assert.equal(a[1].href, null);
  assert.equal(actionCommand({ id: 'merge' }, { n: 5, pr: 12 }), 'ghosty-dev merge 12');
  assert.equal(actionCommand({ id: 'reopen' }, { n: 5 }), 'ghosty-dev reopen 5');
  assert.equal(actionCommand({ id: 'cosa_nueva', href: null }, { n: 5 }), null);
  assert.match(actionLines([{ id: 'cosa_nueva', label: 'Algo', disabled: null }], { n: 5 }).join(), /sólo en Ghosty Studio/);
});
