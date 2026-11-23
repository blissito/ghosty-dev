// La nube (SPEC §5b) habla directo con la API de Ghosty Studio con la sesión de ghosty-dev: sin el CLI `ghosty`.
// Se prueba contra un gs falso, con ojo de atacante: base URL, redirecciones, permisos y nada de tokens en la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';

const TOKENS = /at_\d|rt_\d|dc_1/;

function saveSession(file, base, tok) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const data = { baseUrl: base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope, email: null };
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// Un repo con el pendiente #5, un gs falso y una sesión ya aprobada contra ese gs.
async function withCloud(opts, fn) {
  const gs = await fakeGs(opts);
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  const authFile = join(s.config, 'ghosty-dev', 'auth.json');
  saveSession(authFile, gs.base, gs.grant());
  const cli = (args, extra = {}) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1', ...extra } });
  try {
    await fn({ gs, s, cli, authFile });
  } finally {
    await gs.close();
  }
}

test('claim --cloud manda el pendiente por la API con la sesión de ghosty-dev, sin tocar etiquetas ni worktree', () =>
  withCloud({}, async ({ gs, s, cli }) => {
    const r = await cli(['claim', '5', '--cloud', '--yes', '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.cloud, true);
    assert.equal(out.number, 5);
    assert.equal(out.id, 'run1');
    assert.deepEqual(gs.devCalls[0], { method: 'POST', path: '/api/v2/me/dev-runs', query: '', body: { repo: 'acme/demo', issue: 5 } });
    assert.equal(gs.calls.find((c) => c.path === '/api/v2/me/dev-runs').auth, 'Bearer at_1');
    // El estado del issue lo mueve el escritor de la nube, no esta terminal.
    assert.deepEqual(s.read().issues[5].labels, ['ghosty-dev:por-hacer']);
    assert.deepEqual(s.read().issues[5].assignees, []);
    const again = await cli(['claim', '5', '--cloud', '--yes']);
    assert.match(again.out, /Ya iba en la nube: #5 Salud/);
    assert.doesNotMatch(r.out + r.err + again.out + again.err, TOKENS);
  }));

test('cloud lista, stop y teleport sólo actúan sobre un pendiente que va en la nube', () =>
  withCloud({}, async ({ gs, cli }) => {
    const none = await cli(['stop', '5']);
    assert.equal(none.code, 1);
    assert.match(none.err, /no va en la nube/);
    await cli(['claim', '5', '--cloud', '--yes']);
    const ls = await cli(['cloud']);
    assert.match(ls.out, /#5\ttrabajando\tSalud/);
    assert.equal(gs.devCalls.find((c) => c.method === 'GET').query, '?repo=acme%2Fdemo');
    const tp = await cli(['teleport', '5', '--json']);
    assert.equal(tp.code, 0, tp.err);
    assert.equal(JSON.parse(tp.out).branch, 'ghosty-dev/5-salud');
    assert.deepEqual(gs.devCalls.at(-1), { method: 'POST', path: '/api/v2/me/dev-runs/run1', query: '', body: { op: 'stop' } });
    assert.equal(gs.runs[0].phase, 'stopped');
    assert.equal((await cli(['stop', '5'])).code, 1);
  }));

test('stop detiene el pendiente en la nube', () =>
  withCloud({}, async ({ gs, cli }) => {
    await cli(['claim', '5', '--cloud', '--yes']);
    const r = await cli(['stop', '5']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#5 detenido en la nube/);
    assert.equal(gs.runs[0].phase, 'stopped');
  }));

test('claim --cloud --pr: gs responde servicios del PR sin id y no se inventa un pendiente', () =>
  withCloud({}, async ({ gs, cli }) => {
    const r = await cli(['claim', '--cloud', '--yes', '--pr', '9', '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.services, true);
    assert.equal(out.pr, 9);
    assert.equal(out.prUrl, 'https://github.com/acme/demo/pull/9');
    assert.equal(out.id, undefined);
    assert.deepEqual(gs.devCalls[0].body, { repo: 'acme/demo', pr: 9 });
    const human = await cli(['claim', '--cloud', '--yes', '--pr', '9']);
    assert.match(human.out, /PR #9: vista previa, revisión y checks/);
    assert.equal(gs.runs.length, 0);
  }));

test('403 insufficient_scope: dice qué permiso falta y cómo pedirlo, sin reintentar en bucle', () =>
  withCloud({ devScope: false }, async ({ gs, cli }) => {
    const r = await cli(['claim', '5', '--cloud', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Tu sesión no tiene el permiso dev: ghosty-dev login --force/);
    assert.equal(gs.devCalls.length, 1);
    // login --force pide una sesión nueva aunque ya haya una (y pide el permiso dev).
    const again = await cli(['login', '--force', '--no-wait', '--json']);
    assert.equal(again.code, 0, again.err);
    assert.equal(JSON.parse(again.out).status, 'pending');
    assert.equal(gs.calls.find((c) => c.path === '/oauth2/device').form.scope, 'profile repo:env dev');
    assert.doesNotMatch(r.out + r.err + again.out + again.err, TOKENS);
  }));

test('GHOSTY_DEV_BASE_URL sin https se rechaza antes de mandar nada (http sólo hacia 127.0.0.1/localhost)', () =>
  withCloud({}, async ({ gs, cli }) => {
    for (const bad of ['http://example.com', 'http://127.0.0.1.evil.test', 'ftp://127.0.0.1', 'https://u:p@example.com', 'no es url']) {
      const r = await cli(['cloud'], { GHOSTY_DEV_BASE_URL: bad });
      assert.equal(r.code, 1, bad);
      assert.match(r.err, /GHOSTY_DEV_BASE_URL/, bad);
      assert.doesNotMatch(r.err, /example\.com|evil/, bad);
      const w = await cli(['whoami'], { GHOSTY_DEV_BASE_URL: bad });
      assert.equal(w.code, 1, bad);
    }
    assert.equal(gs.calls.length, 0);
  }));

test('una redirección a otro host no se sigue: el token no sale del origen de gs', async () => {
  const other = await fakeGs();
  try {
    await withCloud({ redirectRunsTo: other.base }, async ({ gs, cli }) => {
      const r = await cli(['claim', '5', '--cloud', '--yes']);
      assert.equal(r.code, 1);
      assert.match(r.err, /redirección/);
      assert.equal(gs.devCalls.length, 1);
      assert.equal(other.calls.length, 0);
      assert.doesNotMatch(r.out + r.err, TOKENS);
    });
  } finally {
    await other.close();
  }
});

test('la sesión guardada no se manda a otro servidor aunque GHOSTY_DEV_BASE_URL cambie', async () => {
  const other = await fakeGs();
  try {
    await withCloud({}, async ({ cli }) => {
      const r = await cli(['cloud'], { GHOSTY_DEV_BASE_URL: other.base });
      assert.equal(r.code, 1);
      assert.match(r.err, /otro servidor/);
      const lo = await cli(['logout'], { GHOSTY_DEV_BASE_URL: other.base });
      assert.equal(lo.code, 0, lo.err);
      assert.ok(other.calls.every((c) => !c.auth && !c.form?.token && !c.form?.refresh_token), JSON.stringify(other.calls));
    });
  } finally {
    await other.close();
  }
});

test('un error del servidor llega limpio: sin el token que se mandó ni caracteres de control', async () => {
  await withCloud({ echoToken: true }, async ({ cli }) => {
    const r = await cli(['claim', '5', '--cloud', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /token recibido: Bearer \[oculto\]/);
    assert.doesNotMatch(r.out + r.err, TOKENS);
  });
  await withCloud({ runFail: 'Conecta tu GitHub\u001b[2J\u001b]0;pwned\u0007 a tu cuenta de Ghosty' }, async ({ cli }) => {
    const r = await cli(['claim', '5', '--cloud', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Conecta tu GitHub/);
    assert.doesNotMatch(r.err, /[\u0000-\u0009\u000b-\u001f]/);
  });
});

test('con GHOSTY_DEV_TOKEN (CI) también funciona y no se imprime', () =>
  withCloud({}, async ({ gs, cli, authFile }) => {
    writeFileSync(authFile, '{}');
    const tok = gs.grant().access_token;
    const r = await cli(['cloud', '--json'], { GHOSTY_DEV_TOKEN: tok });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), []);
    assert.doesNotMatch(r.out + r.err, TOKENS);
  }));

test('auth.json con permisos abiertos se cierra a 0600 (y su carpeta a 0700) y se avisa', { skip: process.platform === 'win32' }, () =>
  withCloud({}, async ({ cli, authFile }) => {
    chmodSync(authFile, 0o644);
    chmodSync(join(authFile, '..'), 0o755);
    const r = await cli(['cloud']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /permisos abiertos/);
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(authFile, '..')).mode & 0o777, 0o700);
  }));

test('una rama del servidor con forma de opción nunca llega a git', () =>
  withCloud({ runs: [{ id: 'run9', repo: 'acme/demo', issue: 5, title: 'X', phase: 'working', estado: 'trabajando', prUrl: null, issueUrl: 'u', branch: '--upload-pack=touch /tmp/pwned' }] }, async ({ cli }) => {
    const r = await cli(['teleport', '5', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).branch, null);
  }));

test('la nube ya no depende del CLI ghosty ni ejecuta procesos con datos del servidor', () => {
  const src = readFileSync(new URL('../src/cloud.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process|execFile|GHOSTY_DEV_GHOSTY|\beval\(/);
});

test('reopen retoma un pendiente detenido; uno vivo no se reabre', () =>
  withCloud({}, async ({ gs, cli }) => {
    await cli(['claim', '5', '--cloud', '--yes']);
    const vivo = await cli(['reopen', '5']);
    assert.equal(vivo.code, 1);
    assert.match(vivo.err, /no está detenido/);
    await cli(['stop', '5']);
    const r = await cli(['reopen', '5', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(gs.devCalls.at(-1), { method: 'POST', path: '/api/v2/me/dev-runs/run1', query: '', body: { op: 'reopen' } });
    assert.equal(gs.runs[0].phase, 'working');
  }));

test('release suelta «Esperando #N» sin cerrar nada, y stop ya ve los que esperan', () =>
  withCloud({}, async ({ gs, cli }) => {
    await cli(['claim', '5', '--cloud', '--yes']);
    const noEsperaba = await cli(['release', '5']);
    assert.equal(noEsperaba.code, 1);
    assert.match(noEsperaba.err, /no está esperando otro PR/);
    gs.runs[0].phase = 'blocked';
    const r = await cli(['release', '5']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(gs.devCalls.at(-1).body, { op: 'resume' });
    gs.runs[0].phase = 'blocked';
    assert.equal((await cli(['stop', '5'])).code, 0, 'un pendiente en «Esperando» también va en la nube');
  }));

test('recover lista los PRs cerrados sin merge y con --start los retoma; --reopen viaja en claim --cloud', () =>
  withCloud({}, async ({ gs, cli }) => {
    gs.closedPrs = [{ pr: 100, title: 'Seguridad', branch: 'ghosty-dev/92-api', issue: 92, url: 'https://github.com/acme/demo/pull/100' }];
    const ls = await cli(['recover']);
    assert.equal(ls.code, 0, ls.err);
    assert.match(ls.out, /PR #100\tghosty-dev\/92-api\t#92\tSeguridad/);
    assert.deepEqual(gs.devCalls.at(-1).body, { repo: 'acme/demo', start: false });
    const go = await cli(['recover', '--start', '--pr', '100']);
    assert.match(go.out, /PR #100: retomado/);
    assert.deepEqual(gs.devCalls.at(-1).body, { repo: 'acme/demo', start: true, prs: [100] });
    await cli(['claim', '5', '--cloud', '--reopen', '--yes']);
    assert.equal(gs.devCalls.filter((c) => c.method === 'POST' && c.path === '/api/v2/me/dev-runs').at(-1).body.reopen, true);
  }));

test('claim --cloud con trabajo local lo sube a ghosty-dev/<n>-traspaso (con un WIP) y la nube parte de ahí; sin trabajo local no manda rama', () =>
  withCloud({}, async ({ gs, s, cli }) => {
    const { execFileSync } = await import('node:child_process');
    const sh = (...a) => execFileSync('git', a, { cwd: s.repo, stdio: 'pipe' }).toString();
    // Sin remoto ni rama del pendiente: nada que heredar.
    const none = await cli(['claim', '5', '--cloud', '--yes', '--json']);
    assert.equal(none.code, 0, none.err);
    assert.deepEqual(gs.devCalls.at(-1).body, { repo: 'acme/demo', issue: 5 });
    // Con la rama del pendiente, un cambio sin commitear y un remoto.
    const bare = join(s.root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    sh('remote', 'add', 'origin', bare);
    sh('push', '-q', 'origin', 'main');
    sh('checkout', '-q', '-b', 'ghosty-dev/5-salud');
    writeFileSync(join(s.repo, 'nuevo.txt'), 'trabajo a medias\n');
    const again = await cli(['claim', '5', '--cloud', '--yes', '--json']);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /ghosty-dev\/5-traspaso/);
    const sent = gs.devCalls.filter((c) => c.method === 'POST').at(-1).body;
    assert.equal(sent.fromBranch, 'ghosty-dev/5-traspaso');
    assert.match(execFileSync('git', ['log', '--format=%s', '-1', 'ghosty-dev/5-traspaso'], { cwd: bare }).toString(), /WIP: traspaso a la nube/);
    assert.equal(sh('status', '--porcelain').trim(), '', 'el worktree queda limpio: el WIP quedó commiteado');
    // --no-handoff lo salta.
    writeFileSync(join(s.repo, 'otro.txt'), 'x\n');
    const skip = await cli(['claim', '5', '--cloud', '--yes', '--no-handoff', '--json']);
    assert.equal(skip.code, 0, skip.err);
    assert.equal(gs.devCalls.filter((c) => c.method === 'POST').at(-1).body.fromBranch, undefined);
  }));

test('claim local de un pendiente que va en la nube: detiene su caja y sigue aquí; sin sesión de nube, toma normal', () =>
  withCloud({}, async ({ gs, s, cli }) => {
    await cli(['claim', '5', '--cloud', '--yes']);
    const r = await cli(['claim', '5', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /iba en la nube: la detuve/);
    assert.deepEqual(gs.devCalls.at(-1), { method: 'POST', path: '/api/v2/me/dev-runs/run1', query: '', body: { op: 'stop' } });
    assert.deepEqual(s.read().issues[5].assignees, ['agente-a']);
  }));

test('cloud: un renglón por pendiente (el vivo manda) con sus intentos anteriores', async () => {
  const { groupByIssue } = await import('../src/cloud.mjs');
  const rows = [
    { number: 100, phase: 'stopped', id: 'a' },
    { number: 100, phase: 'working', id: 'b' },
    { number: 100, phase: 'stopped', id: 'c' },
    { number: 103, phase: 'stopped', id: 'd' },
  ];
  const g = groupByIssue(rows);
  assert.equal(g.length, 2);
  assert.deepEqual(g.find((r) => r.number === 100), { number: 100, phase: 'working', id: 'b', attempts: 2 });
  assert.equal(g.find((r) => r.number === 103).attempts, 0);
});
