// La vista previa de un PR (SPEC §5c, C19): se pide por PR con la sesión de ghosty-dev, sin depender de un run.
// La liga firmada lleva la llave de la vista previa: sólo sale por stdout como resultado de `preview`, nunca en
// errores, en stderr ni en `show`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPreview } from '../testkit/with-pr.mjs';

const KEY = 'pk_SECRETO0123456789abcdefghijklmnop';
const LINK = `https://pr-73.preview.ghosty.page/?k=${KEY}`;
const SECRET = /pk_SECRETO|at_\d|rt_\d/;
const OLD = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('preview <pr>: lista → la liga firmada sale sólo en stdout y sale 0 (C19)', () =>
  withPreview([{ phase: 'ready', sha: null, url: LINK }], async ({ gs, cli, head }) => {
    gs.previews[0].sha = head;
    const r = await cli(['preview', '73', '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.phase, 'ready');
    assert.equal(out.url, LINK);
    assert.equal(out.sha, head);
    assert.equal(out.stale, false);
    assert.deepEqual(gs.previewCalls[0], { repo: 'acme/demo', pr: 73 });
    assert.equal(gs.calls.find((c) => c.path.endsWith('/preview')).auth, 'Bearer at_1');
    assert.doesNotMatch(r.err, SECRET);
    const human = await cli(['preview', '73']);
    assert.match(human.out, new RegExp(`Vista previa del PR #73 \\(commit ${head.slice(0, 7)}\\): lista\\n  https://pr-73`));
    // --open la abre y no la imprime.
    const opened = await cli(['preview', '73', '--open'], { GHOSTY_DEV_NO_OPEN: '1' });
    assert.equal(opened.code, 0);
    assert.match(opened.out, /Abierta en tu navegador/);
    assert.doesNotMatch(opened.out + opened.err, SECRET);
  }));

test('preview <pr>: con variables faltantes las dice por nombre (stdout y --json), nunca valores', () =>
  withPreview([{ phase: 'ready', sha: null, url: LINK, missingEnv: ['FORMMY_MCP_TOKEN_SECRET', 'mal valor', 'GHOSTY_PARTNER_KEY'], missingEnvTouched: ['FORMMY_MCP_TOKEN_SECRET'], missingEnvPriority: ['FORMMY_MCP_TOKEN_SECRET'] }], async ({ gs, cli, head }) => {
    gs.previews[0].sha = head;
    const out = JSON.parse((await cli(['preview', '73', '--json'])).out);
    assert.deepEqual(out.missingEnv, ['FORMMY_MCP_TOKEN_SECRET', 'GHOSTY_PARTNER_KEY']);
    assert.deepEqual(out.missingEnvTouched, ['FORMMY_MCP_TOKEN_SECRET']);
    assert.match((await cli(['preview', '73'])).out, /Faltan 1 que usa este PR o el arranque: FORMMY_MCP_TOKEN_SECRET\. Súbelas con ghosty-dev env push[\s\S]*Y 1 más del resto de la app/);
  }));

test('preview --wait: armándose → lista, con backoff; sin --wait sale 75 y sin liga (C19)', () =>
  withPreview([{ phase: 'building' }, { phase: 'building' }, { phase: 'ready', url: LINK }], async ({ gs, cli, head }) => {
    for (const p of gs.previews) p.sha = head;
    const r = await cli(['preview', '73', '--wait', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).url, LINK);
    assert.equal(gs.previewCalls.length, 3);
    // Sin --wait, una que sigue armándose sale con 75 y sin liga.
    gs.previews.splice(0, gs.previews.length, { phase: 'building', sha: head, url: LINK });
    const once = await cli(['preview', '73', '--json']);
    assert.equal(once.code, 75);
    assert.equal(JSON.parse(once.out).url, null);
    assert.match((await cli(['preview', '73'])).out, /armándose\. Espérala: ghosty-dev preview 73 --wait/);
  }));

test('preview --wait no se conforma con la vista previa de un commit viejo, y avisa sin la liga (C19)', () =>
  withPreview([{ phase: 'ready', sha: OLD, url: LINK }, { phase: 'building' }, { phase: 'ready', url: LINK }], async ({ gs, cli, head }) => {
    gs.previews[1].sha = head;
    gs.previews[2].sha = head;
    const r = await cli(['preview', '73', '--wait', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).sha, head);
    assert.equal(gs.previewCalls.length, 3);
  }));

test('preview avisa en stderr si la vista previa es de otro commit; el aviso no lleva la liga (C19)', () =>
  withPreview([{ phase: 'ready', sha: OLD, url: LINK }], async ({ cli }) => {
    const r = await cli(['preview', '73', '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).stale, true);
    assert.match(r.err, /La vista previa es del commit 0000000/);
    assert.doesNotMatch(r.err, SECRET);
  }));

test('preview avisa si falta git push sólo en la rama del PR (C19)', () =>
  withPreview([{ phase: 'ready', url: LINK }], async ({ gs, s, cli, head }) => {
    gs.previews[0].sha = head;
    const db = s.read();
    db.prs[0].headRefOid = OLD; // GitHub tiene otro commit: el HEAD local no está empujado
    gs.previews[0].sha = OLD;
    writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
    const r = await cli(['preview', '73']);
    assert.match(r.err, /Tu HEAD local \(.{7}\) no es el del PR en GitHub \(0000000\): ¿falta git push\?/);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: s.repo });
    const fromMain = await cli(['preview', '73', '--json']);
    assert.equal(fromMain.err, '');
    assert.equal(JSON.parse(fromMain.out).stale, false);
  }));

test('preview --wait con tope: sigue armándose → 75 (C19)', () =>
  withPreview([{ phase: 'building' }], async ({ cli }) => {
    const r = await cli(['preview', '73', '--wait'], { GHOSTY_DEV_PREVIEW_MAX_MS: '20' });
    assert.equal(r.code, 75);
    assert.match(r.out, /armándose/);
  }));

test('preview falló: sale 1 con el error recortado y limpio (C19)', () =>
  withPreview([{ phase: 'failed', error: `npm run build falló \x1b[31m${'x'.repeat(900)} ${KEY}` }], async ({ cli }) => {
    const r = await cli(['preview', '73', '--json']);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.out);
    assert.equal(out.phase, 'failed');
    assert.equal(out.url, null);
    assert.ok(out.error.length <= 300);
    assert.doesNotMatch(out.error, /\x1b|pk_SECRETO/);
    const human = await cli(['preview', '73']);
    assert.match(human.out, /: falló\n  npm run build falló/);
    assert.doesNotMatch(human.out + human.err, SECRET);
  }));

test('preview con sesión sin permiso: 403 insufficient_scope pide login --force, sin tokens (C19)', () =>
  withPreview([], async ({ cli }) => {
    const r = await cli(['preview', '73']);
    assert.equal(r.code, 1);
    assert.match(r.err, /no tiene el permiso dev: ghosty-dev login --force/);
    assert.doesNotMatch(r.out + r.err, SECRET);
  }, { gsOpts: { devScope: false } }));

test('preview sin número deduce el PR de la rama actual; sin PR, dice qué hacer (C19)', () =>
  withPreview([{ phase: 'none', message: 'Este PR no tiene vista previa.' }], async ({ gs, s, cli }) => {
    const r = await cli(['preview', '--json']);
    assert.equal(r.code, 75, r.err);
    assert.equal(gs.previewCalls[0].pr, 73);
    execFileSync('git', ['checkout', '-q', '-b', 'otra'], { cwd: s.repo });
    const none = await cli(['preview']);
    assert.equal(none.code, 1);
    assert.match(none.err, /La rama otra no tiene un PR abierto/);
  }));

test('show --pr: estado del PR, ficha, servicios y vista previa {phase, sha} sin la liga (C19)', () =>
  withPreview([{ phase: 'ready', url: LINK }], async ({ gs, s, cli, head }) => {
    gs.previews[0].sha = head;
    const r = await cli(['show', '--pr', '73', '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.pr, 73);
    assert.equal(out.state, 'abierto');
    assert.deepEqual(out.closes, [5]);
    assert.deepEqual(out.preview, { phase: 'ready', sha: head });
    assert.equal(out.services.ci, 'sin-checks');
    const human = await cli(['show', '--pr', '73']);
    assert.match(human.out, /vista previa \(Ghosty Studio\): lista · commit .{7} — la liga: ghosty-dev preview/);
    assert.doesNotMatch(r.out + r.err + human.out + human.err, SECRET);
    // Sin sesión de ghosty-dev, show sigue con lo de GitHub.
    const bare = await cli(['show', '--pr', '73', '--json'], { GHOSTY_DEV_BASE_URL: undefined, XDG_CONFIG_HOME: join(s.root, 'sin-sesion') });
    assert.equal(bare.code, 0, bare.err);
    assert.equal(JSON.parse(bare.out).preview, null);
  }));

test('preview --wait sin caja: a los 30 s sugiere box rebuild; sin --wait, también (fila 48)', () =>
  withPreview([{ phase: 'none' }, { phase: 'none' }, { phase: 'none' }, { phase: 'none' }, { phase: 'none' }, { phase: 'ready', url: LINK }], async ({ gs, cli, head }) => {
    for (const p of gs.previews) p.sha = head;
    const r = await cli(['preview', '73', '--wait', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Después de 30 s el PR #73 sigue sin vista previa\. Ármala sin push: ghosty-dev box rebuild 73/);
    assert.doesNotMatch(r.err, SECRET);
    gs.previews.splice(0, gs.previews.length, { phase: 'none', sha: null });
    assert.match((await cli(['preview', '73'])).out, /sin vista previa\. .*\n  Para armarla sin push: ghosty-dev box rebuild 73/);
  }));

test('preview <pr> --login: liga de un solo uso con la identidad de servicio, sólo en stdout (filas 53–54)', () =>
  withPreview([{ phase: 'ready', sha: null, url: LINK }], async ({ gs, cli }) => {
    const r = await cli(['preview', '73', '--login', '--path', '/dashboard', '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.match(out.url, /^https:\/\/www\.ghosty\.studio\/preview\/login\//);
    assert.equal(out.path, '/dashboard');
    assert.equal(out.oneTime, true);
    assert.equal(out.identity.email, 'smoke@ghosty.studio');
    assert.deepEqual(gs.loginCalls[0], { method: 'POST', pr: 73, query: '', body: { path: '/dashboard' } });
    assert.doesNotMatch(r.err, /nonce_SECRETO/);
    const human = await cli(['preview', '73', '--login']);
    assert.match(human.out, /Login de prueba en la vista previa del PR #73 como smoke@ghosty\.studio \(un solo uso, 10 min, aterriza en \/\)/);
  }));

test('preview <pr> --login --check: prueba de punta a punta; sale 0 con sesión y 1 sin ella', () =>
  withPreview([{ phase: 'ready', sha: null, url: LINK }], async ({ gs, cli }) => {
    const ok = await cli(['preview', '73', '--login', '--check', '--path', '/dashboard/chat']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Login en la vista previa del PR #73 \(\/dashboard\/chat\): ok: entra con sesión\n  con identidad 200 · sin identidad 302 → \//);
    assert.equal(gs.loginCalls[0].method, 'GET');
    assert.equal(gs.loginCalls[0].query, '?path=%2Fdashboard%2Fchat');
    gs.loginProbe = { verdict: 'no_session', path: '/dashboard', message: 'la app no aceptó X-Ghosty-Identity', withIdentity: { status: 302, location: '/' }, withoutIdentity: { status: 302, location: '/' } };
    const bad = await cli(['preview', '73', '--login', '--check', '--json']);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).verdict, 'no_session');
  }));
