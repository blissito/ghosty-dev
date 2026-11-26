// Huecos del CLI (26-nov): unblock quita la dependencia nativa, close --duplicate-of, stop limpia la etiqueta
// «en-nube» colgada y show no ofrece la nube a un bloqueado. Todo contra el gh y el gs falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';
import { actionsWhenBlocked, actionCommand } from '../src/cloud.mjs';
import { removeBlockedBy } from '../src/commands.mjs';

async function withGs(state, gsOpts, fn) {
  const gs = await fakeGs(gsOpts);
  const s = setup(state);
  mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
  const tok = gs.grant();
  writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null }), { mode: 0o600 });
  try {
    await fn((args) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } }), s);
  } finally {
    await gs.close();
  }
}

const blocked = () => ({ ...issue(7, 'Pagos', { labels: ['ghosty-dev:bloqueado'] }), blockedBy: [3, 4] });

test('unblock: borra las dependencias nativas blocked_by (por id del bloqueador), la etiqueta y deja la marca', () => {
  const s = setup({ issues: { 3: issue(3, 'Base'), 4: issue(4, 'Otra'), 7: blocked() } });
  const r = s.run('unblock', '7', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).removed, [3, 4]);
  const i = s.read().issues[7];
  assert.deepEqual(i.blockedBy, []);
  assert.deepEqual(i.labels, ['ghosty-dev:por-hacer']);
  assert.match(i.comments.at(-1).body, /ghosty-dev:desbloqueo/);
  assert.ok(s.read().calls.some((c) => c.includes('DELETE') && c.some((a) => String(a).endsWith('/dependencies/blocked_by/1003'))), 'DELETE con el id, no el número');
});

test('unblock --by: quita sólo esa dependencia y, si queda otra, sigue bloqueado', () => {
  const s = setup({ issues: { 3: issue(3, 'Base'), 4: issue(4, 'Otra'), 7: blocked() } });
  const r = s.run('unblock', '7', '--by', '3');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sigue bloqueado por #4/);
  const i = s.read().issues[7];
  assert.deepEqual(i.blockedBy, [4]);
  assert.deepEqual(i.labels, ['ghosty-dev:bloqueado']);
});

test('unblock: si GitHub rechaza el DELETE, lo dice y no toca la etiqueta', () => {
  const s = setup({ depsDeleteFails: true, issues: { 3: issue(3, 'Base'), 4: issue(4, 'Otra'), 7: blocked() } });
  const r = s.run('unblock', '7');
  assert.equal(r.code, 1);
  assert.match(r.err, /GitHub no dejó quitar la dependencia de #7 con #3, #4/);
  assert.deepEqual(s.read().issues[7].labels, ['ghosty-dev:bloqueado']);
});

test('unblock: sin API de dependencias quita el #m de la lista del cuerpo', () => {
  const s = setup({ depsApi: false, issues: { 3: issue(3, 'Base'), 7: issue(7, 'Pagos', { labels: ['ghosty-dev:bloqueado'], body: 'Meta\n\n## Bloqueado por\n- #3\n' }) } });
  const r = s.run('unblock', '7');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(s.read().issues[7].body, /Bloqueado por/);
  assert.equal(removeBlockedBy('a\n\n## Bloqueado por\n- #3\n- #4\n', 3), 'a\n\n## Bloqueado por\n- #4\n');
});

test('close --duplicate-of: cierra «no planeado» con «Duplicado de #m», sin pedir evidencia', () => {
  const s = setup({ issues: { 2: issue(2, 'Original'), 9: issue(9, 'Copia') } });
  const r = s.run('close', '9', '--duplicate-of', '2');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /duplicado de #2/);
  const i = s.read().issues[9];
  assert.equal(i.state, 'closed');
  assert.equal(i.stateReason, 'not_planned');
  assert.equal(i.comments.at(-1).body, 'Duplicado de #2.');
  // Sin --duplicate-of sigue exigiendo evidencia.
  const s2 = setup({ issues: { 9: issue(9, 'Copia') } });
  assert.equal(s2.run('close', '9').code, 1);
});

test('close --duplicate-of: si iba en la nube, primero lo detiene', () =>
  withGs({ issues: { 2: issue(2, 'Original'), 9: issue(9, 'Copia', { labels: ['ghosty-dev:en-curso', 'ghosty-dev:en-nube'] }) } }, { runs: [{ id: 'run9', repo: 'acme/demo', issue: 9, title: 'Copia', phase: 'working', estado: 'trabajando' }] }, async (cli, s) => {
    const r = await cli(['close', '9', '--duplicate-of', '2']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /lo detuve en la nube/);
    const i = s.read().issues[9];
    assert.equal(i.state, 'closed');
    assert.ok(!i.labels.includes('ghosty-dev:en-nube'));
  }));

test('stop sin run vivo pero con la etiqueta en-nube: la quita y vuelve a por-hacer', () =>
  withGs({ issues: { 5: issue(5, 'Salud', { labels: ['ghosty-dev:por-hacer', 'ghosty-dev:en-nube'] }) } }, { runs: [] }, async (cli, s) => {
    const r = await cli(['stop', '5']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /la quité \(vuelve a ghosty-dev:por-hacer\)/);
    assert.deepEqual(s.read().issues[5].labels, ['ghosty-dev:por-hacer']);
    // Sin la etiqueta, sigue diciendo que no va en la nube.
    const again = await cli(['stop', '5']);
    assert.equal(again.code, 1);
    assert.match(again.err, /no va en la nube/);
  }));

test('show de un bloqueado: no ofrece «Mandar a la nube», ofrece unblock; «Editar criterio» con su comando', () => {
  const acts = actionsWhenBlocked([{ id: 'start', label: 'Mandar a la nube', kind: 'start', primary: true }, { id: 'edit_criterion', label: 'Editar criterio', kind: 'op' }]);
  assert.deepEqual(acts.map((a) => a.id), ['unblock', 'edit_criterion']);
  assert.equal(actionCommand(acts[0], { n: 7 }), 'ghosty-dev unblock 7');
  assert.match(actionCommand(acts[1], { n: 7 }), /^ghosty-dev criteria 7 --set <i> "texto nuevo" --reason/);
});

test('--help documenta GHOSTY_DEV_NO_OPEN, add --no-open, unblock --by y close --duplicate-of', () => {
  const r = setup().run('--help');
  assert.match(r.out, /GHOSTY_DEV_NO_OPEN=1/);
  assert.match(r.out, /--no-open/);
  assert.match(r.out, /unblock <n> \[--by <m>\]/);
  assert.match(r.out, /close <n> --duplicate-of <m>/);
});
