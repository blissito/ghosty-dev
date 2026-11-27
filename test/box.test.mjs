// La caja de la vista previa del PR la opera el agente de terminal (SPEC §5c, C20), y `wait --pr` espera por PR sin
// pendiente ni run (C21). Nada de tokens ni de la liga firmada en la salida; la salida de la caja llega limpia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPreview } from '../testkit/with-pr.mjs';

const KEY = 'pk_SECRETO0123456789abcdefghijklmnop';
const LINK = `https://pr-73.preview.ghosty.page/?k=${KEY}`;
const SECRET = /pk_SECRETO|at_\d|rt_\d|tok_vivo/;

test('box logs: cola del log limpia (sin ANSI, sin la llave de la liga, sin Bearer); --lines llega al servidor (C20)', () =>
  withPreview([], async ({ gs, cli }) => {
    gs.box.log = `\x1b[31merror\x1b[0m en build\r\nabre ${LINK}\n\x1b]0;titulo\x07Authorization: Bearer tok_vivo\n`;
    const r = await cli(['box', 'logs', '73']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^error en build\nabre https:\/\/pr-73\.preview\.ghosty\.page\/\?k=\[oculto\]\nAuthorization: Bearer \[oculto\]/);
    assert.doesNotMatch(r.out + r.err, /\x1b|\r/);
    assert.doesNotMatch(r.out + r.err, SECRET);
    assert.equal(gs.boxCalls[0].query, '?lines=200');
    const j = await cli(['box', 'logs', '73', '--lines', '50', '--json']);
    assert.equal(gs.boxCalls[1].query, '?lines=50');
    const out = JSON.parse(j.out);
    assert.equal(out.phase, 'failed');
    assert.equal(out.sha, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    assert.equal((await cli(['box', 'logs', '73', '--lines', '0'])).code, 1);
  }));

test('box exec -- <cmd…>: arma una línea de shell, sale con el código del comando y deduce el PR (C20)', () =>
  withPreview([], async ({ gs, cli }) => {
    gs.box.execCode = 7;
    const r = await cli(['box', 'exec', '73', '--', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'localhost:3000/dashboard/agentes']);
    assert.equal(r.code, 7);
    assert.deepEqual(gs.boxCalls[0].body, { op: 'exec', cmd: "curl -s -o /dev/null -w '%{http_code}' localhost:3000/dashboard/agentes" });
    assert.match(r.err, /el comando salió con 7/);
    gs.box.execCode = 0;
    const one = await cli(['box', 'exec', '--', 'ls -la | head']);
    assert.equal(one.code, 0, one.err);
    assert.deepEqual(gs.boxCalls[1], { method: 'POST', pr: 73, query: '', body: { op: 'exec', cmd: 'ls -la | head' } });
    // stdout y el código ≠ 0 llegan tal cual; un -1 del daemon (no corrió) sale como fallo, nunca como 0 (Formmy #120).
    gs.box.execCode = 3;
    gs.box.execText = 'hola\n';
    const three = await cli(['box', 'exec', '73', '--json', '--', 'echo hola; exit 3']);
    assert.equal(three.code, 3);
    assert.equal(JSON.parse(three.out).text, 'hola\n');
    assert.equal(JSON.parse(three.out).exitCode, 3);
    gs.box.execCode = -1;
    gs.box.execText = '';
    const lost = await cli(['box', 'exec', '73', '--json', '--', 'echo hola']);
    assert.notEqual(lost.code, 0);
    assert.equal(JSON.parse(lost.out).exitCode, 1);
    delete gs.box.execText;
    const none = await cli(['box', 'exec', '73']);
    assert.equal(none.code, 1);
    assert.match(none.err, /Falta el comando/);
  }));

test('box restart y rebuild (C20)', () =>
  withPreview([], async ({ gs, cli }) => {
    const r = await cli(['box', 'restart', '73']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /reiniciada\nApp de la caja del PR #73 reiniciada\./);
    const b = await cli(['box', 'rebuild', '73']);
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, /Rearmando la vista previa del PR #73 \(commit a1b2c3d\)\. Síguela: ghosty-dev preview 73 --wait/);
    assert.deepEqual(gs.boxCalls.map((c) => c.body.op), ['restart', 'rebuild']);
  }));

test('box: sin caja (404), sin asiento (403) y sin permiso dev, con el siguiente paso y sin tokens (C20)', async () => {
  await withPreview([], async ({ cli }) => {
    const r = await cli(['box', 'logs', '73']);
    assert.equal(r.code, 1);
    assert.match(r.err, /no tiene caja de preview/);
  }, { gsOpts: { box: null } });
  await withPreview([], async ({ cli }) => {
    assert.equal((await cli(['box', 'logs', '73'])).code, 0);
    const r = await cli(['box', 'exec', '73', '--', 'ls']);
    assert.equal(r.code, 1);
    assert.match(r.err, /No permitido: sólo el dueño o un miembro/);
  }, { gsOpts: { box: { log: '', seat: false } } });
  await withPreview([], async ({ cli }) => {
    const r = await cli(['box', 'restart', '73']);
    assert.equal(r.code, 1);
    assert.match(r.err, /no tiene el permiso dev: ghosty-dev login --force/);
    assert.doesNotMatch(r.out + r.err, SECRET);
  }, { gsOpts: { devScope: false } });
});

// ---------- wait --pr ----------

const lines = (out) => out.trim().split('\n').map((l) => JSON.parse(l));

test('wait --pr --until preview: un renglón JSON por cambio, sin la liga, hasta que queda lista (C21)', () =>
  withPreview([{ phase: 'building' }, { phase: 'building' }, { phase: 'ready', url: LINK }], async ({ gs, cli, head }) => {
    for (const p of gs.previews) p.sha = head;
    const r = await cli(['wait', '--pr', '73', '--until', 'preview', '--json']);
    assert.equal(r.code, 0, r.err);
    const ev = lines(r.out);
    assert.deepEqual(ev.map((e) => e.event), ['state', 'state', 'done']);
    assert.equal(ev[0].preview.phase, 'building');
    assert.equal(ev[1].preview.phase, 'ready');
    assert.equal(ev.at(-1).met, true);
    assert.doesNotMatch(r.out + r.err, SECRET);
  }));

test('wait --pr --until ci: verde sale 0, rojo sale 1; se acaba el tiempo → 75 (C21)', async () => {
  const prs = (head, ciResult) => [{ number: 73, url: 'https://github.com/acme/demo/pull/73', headRefName: 'feat/x', headRefOid: head, statusCheckRollup: [{ id: 1, name: 'test', status: 'IN_PROGRESS' }] }];
  for (const [result, code, verdict] of [['SUCCESS', 0, 'verde'], ['FAILURE', 1, 'rojo']]) {
    await withPreview([{ phase: 'building' }], async ({ s, cli, head }) => {
      const db = s.read();
      db.prs = prs(head);
      db.ciResult = result;
      writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
      const r = await cli(['wait', '--pr', '73', '--until', 'ci']);
      assert.equal(r.code, code, r.err);
      assert.match(r.out, new RegExp(`CI ${verdict}`));
    });
  }
  await withPreview([{ phase: 'building' }], async ({ cli }) => {
    const r = await cli(['wait', '--pr', '73', '--until', 'preview', '--minutes', '0']);
    assert.equal(r.code, 75);
    assert.match(r.out, /Se acabó el tiempo/);
    assert.equal((await cli(['wait', '--pr', '73', '--until', 'nada'])).code, 1);
  });
});

test('wait --pr --until any: regresa con el primer cambio; una vista previa de un commit viejo no cuenta como lista (C21)', () =>
  withPreview([{ phase: 'ready', sha: '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: LINK }, { phase: 'failed', error: 'build roto' }], async ({ gs, cli, head }) => {
    gs.previews[1].sha = head;
    const r = await cli(['wait', '--pr', '73', '--json']);
    assert.equal(r.code, 1, r.err);
    const ev = lines(r.out);
    assert.equal(ev[0].preview.phase, 'building');
    assert.equal(ev.at(-1).preview.phase, 'failed');
    assert.equal(ev.at(-1).until, 'any');
  }));

test('wait: checks de la plataforma en curso con la vista previa lista se dicen al acabarse el tiempo (C21, Formmy #81)', async () => {
  const { stuckChecks } = await import('../src/watch.mjs');
  const base = { pr: 81, preview: { phase: 'ready' }, previewCheck: 'pendiente', smoke: { status: 'pendiente' } };
  const s = stuckChecks(base);
  assert.deepEqual(s.checks, ['Ghosty · Preview', 'Ghosty · Smoke']);
  assert.match(s.hint, /Reintentar/);
  assert.match(s.hint, /box rebuild 81/);
  assert.equal(stuckChecks({ ...base, preview: { phase: 'building' } }), null);
  assert.equal(stuckChecks({ ...base, previewCheck: 'listo', smoke: { status: 'listo' } }), null);
  assert.deepEqual(stuckChecks({ ...base, previewCheck: 'listo' }).checks, ['Ghosty · Smoke']);
});

test('caja sin memoria: box logs/exec dicen la causa y el arreglo, no «respondió 503» (Formmy, fila 39)', () =>
  withPreview([], async ({ gs, cli }) => {
    gs.box.hung = 'la caja no responde, casi siempre porque se quedó sin memoria durante el build (tope 4 GB; sube a 8 GB con `.ghosty/factory.md` → `memory: 8gb`)';
    for (const args of [['box', 'logs', '73'], ['box', 'exec', '73', '--', 'ls']]) {
      const r = await cli(args);
      assert.equal(r.code, 1);
      assert.match(r.err, /se quedó sin memoria.*memory: 8gb/);
      assert.doesNotMatch(r.err, /respondió 503/);
    }
    gs.box.hung = null;
    gs.box.memory = { trouble: true, oomKills: 2, memoryMb: 4096, availableMb: 90, advice: 'La caja se quedó sin memoria (el kernel mató 2 procesos): tope 4 GB; sube a 8 GB' };
    const j = JSON.parse((await cli(['box', 'logs', '73', '--json'])).out);
    assert.deepEqual([j.memory.trouble, j.memory.oomKills, j.memory.memoryMb], [true, 2, 4096]);
    assert.match(j.memory.advice, /sube a 8 GB/);
  }));
