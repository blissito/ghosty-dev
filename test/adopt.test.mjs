// Publicar evidencia re-dispara la puerta (C25) y el patrón adopta lo que ya existe (C26): claim --pr, review/evidence
// --pr, avisos de PR sin pendiente, next, y claim --cloud que dice antes qué ocupa y qué desalojaría.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, issue, VALID_EVIDENCE, SHA, revisionMd } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';
import { formatEvidence, formatRevision } from '../src/evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(ROOT, 'testkit', 'fake-gh.mjs');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/evidence-gate.yml'), 'utf8');
const REDISPARO = [...WORKFLOW.matchAll(/node --input-type=module -e '\n([\s\S]*?)\n\s*'\n/g)][1][1];

// Un PR abierto a mano desde una rama propia (fuera del patrón ghosty-dev/<n>-…).
const handPr = (over = {}) => ({ number: 76, title: 'Arreglo a mano', url: 'https://github.com/acme/demo/pull/76', headRefName: 'fix/puerta', headRefOid: SHA, body: 'Arreglo la puerta', ...over });
const edit = (s, fn) => {
  const db = s.read();
  fn(db);
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
};

test('evidence vuelve a correr la puerta del PR que cierra #n, aunque sea de una rama ajena (por head_sha) (C25)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ body: 'Closes #5' })], runs: [{ databaseId: 42, headSha: SHA }, { databaseId: 7, headSha: 'otro' }] });
  const f = s.write('e.md', VALID_EVIDENCE);
  const r = s.run('evidence', '5', '--file', f, '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).rerun, 42);
  assert.deepEqual(s.read().reruns, [42]);
});

function redisparo(s, event) {
  const ev = join(s.root, 'event.json');
  writeFileSync(ev, JSON.stringify(event));
  return spawnSync(process.execPath, ['--input-type=module', '-e', REDISPARO], {
    encoding: 'utf8',
    env: { ...process.env, GHOSTY_DEV_GH: FAKE, FAKE_GH_STATE: join(s.root, 'gh.json'), GITHUB_EVENT_PATH: ev, GITHUB_WORKFLOW_REF: 'acme/demo/.github/workflows/evidence-gate.yml@refs/heads/main' },
  });
}

test('el workflow re-dispara la puerta con issue_comment: sólo comentarios con marca, por el PR que cierra el issue (C25)', () => {
  assert.match(WORKFLOW, /issue_comment:\n\s+types: \[created, edited\]/);
  assert.match(WORKFLOW, /contains\(github\.event\.comment\.body, '<!-- ghosty-dev:evidencia'\)/);
  // El job que re-dispara no se llama como la puerta (no la sustituye) y la puerta sólo juzga en pull_request.
  assert.match(WORKFLOW, /name: ghosty-dev\/redisparo/);
  assert.match(WORKFLOW, /evidencia:\n\s+name: ghosty-dev\/evidencia\n\s+if: github\.event_name == 'pull_request'/);
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ body: 'Closes #5' }), handPr({ number: 77, headRefOid: 'zzz', body: 'Closes #6' })], runs: [{ databaseId: 42, headSha: SHA }] });
  const r = redisparo(s, { issue: { number: 5 }, comment: { body: '<!-- ghosty-dev:evidencia v0.1 -->' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PR #76: puerta vuelta a correr \(run 42\)/);
  assert.deepEqual(s.read().reruns, [42]);
  // Si la puerta sigue corriendo, no se toca (lee los comentarios en vivo).
  edit(s, (db) => (db.runs[0].status = 'in_progress'));
  assert.match(redisparo(s, { issue: { number: 5 } }).stdout, /sigue corriendo/);
  assert.match(redisparo(s, { issue: { number: 9 } }).stdout, /#9 no lo cierra ningún PR abierto/);
});

test('claim --pr <m> --issue <n> adopta el PR sin rama ni worktree y le agrega «Closes #n»; review lo encuentra (C26)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr()] });
  const r = s.run('claim', '--pr', '76', '--issue', '5', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.adopted, true);
  assert.equal(out.linked, true);
  assert.equal(out.branch, 'fix/puerta');
  const db = s.read();
  assert.equal(db.prs[0].body, 'Arreglo la puerta\n\nCloses #5\n');
  assert.deepEqual(db.issues[5].labels, ['ghosty-dev:en-curso']);
  assert.deepEqual(db.issues[5].assignees, ['agente-a']);
  assert.ok(!db.calls.some((c) => c[0] === 'worktree'));
  const rev = s.write('r.md', revisionMd(0));
  const posted = s.run('review', '5', '--file', rev, '--json');
  assert.equal(posted.code, 0, posted.err);
  assert.equal(JSON.parse(posted.out).pr, 76);
  // Otro escritor: no se adopta.
  const t = setup({ issues: { 5: issue(5, 'Salud', { assignees: ['agente-b'] }) }, prs: [handPr()] });
  assert.match(t.run('claim', '--pr', '76', '--issue', '5').err, /Un solo escritor/);
});

test('review <n> --pr <m> y evidence --pr publican sobre ese PR aunque no diga «Closes» (C26)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr()] });
  const sinPr = s.run('review', '5', '--file', s.write('r.md', revisionMd(0)));
  assert.equal(sinPr.code, 1);
  assert.match(sinPr.err, /ghosty-dev review 5 --pr <m>/);
  const r = s.run('review', '5', '--pr', '76', '--file', s.write('r2.md', revisionMd(0)), '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).sha, SHA);
});

test('ready y show avisan del PR que no está ligado a un pendiente, con el comando exacto (C26)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr(), handPr({ number: 80, draft: true, headRefOid: 'b' })] });
  const r = s.run('ready', '--json');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /el PR #76 no está ligado a un pendiente: ghosty-dev claim --pr 76 --issue <n>/);
  assert.doesNotMatch(r.err, /#80/);
  JSON.parse(r.out);
  assert.match(s.run('show', '--pr', '76').out, /cierra: — \(no está ligado a un pendiente: ghosty-dev claim --pr 76 --issue <n>/);
  assert.match(s.run('show', '5').out, /PR: — \(#5 no tiene PR que lo cierre; si el PR ya existe: ghosty-dev claim --pr <m> --issue 5\)/);
});

test('next dice el siguiente paso: ligar → CI → revisión → evidencia → listo (C26)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ statusCheckRollup: [{ id: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })] });
  spawnSync('git', ['checkout', '-q', '-b', 'fix/puerta'], { cwd: s.repo });
  const step = () => JSON.parse(s.run('next', '--json').out);
  assert.equal(step().step, 'ligar');
  assert.equal(step().command, 'ghosty-dev claim --pr 76 --issue <n>');
  s.run('claim', '--pr', '76', '--issue', '5');
  assert.deepEqual([step().step, step().command], ['revision', 'ghosty-dev review 5 --pr 76']);
  edit(s, (db) => db.issues[5].comments.push({ body: formatRevision(5, SHA, revisionMd(0)) }));
  assert.deepEqual([step().step, step().command], ['evidencia', 'ghosty-dev evidence 5 --pr 76 --file evidencia.md']);
  edit(s, (db) => db.issues[5].comments.push({ body: formatEvidence(5, VALID_EVIDENCE) }));
  assert.equal(step().step, 'listo');
  assert.match(s.run('status').out, /^Siguiente paso: listo\n {2}ghosty-dev merge 76\n {2}por qué: #5 tiene revisión y evidencia/);
  // En main sin nada en curso: tomar el siguiente pendiente.
  const t = setup({ issues: { 3: issue(3, 'Otro') } });
  assert.deepEqual([JSON.parse(t.run('next', '--json').out).step, JSON.parse(t.run('next', '--json').out).command], ['tomar', 'ghosty-dev claim 3']);
});

test('next reconoce la revisión externa del commit (check «Ghosty Review» de ghosty-studio) y pasa a evidencia', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ statusCheckRollup: [{ id: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })] });
  spawnSync('git', ['checkout', '-q', '-b', 'fix/puerta'], { cwd: s.repo });
  s.run('claim', '--pr', '76', '--issue', '5');
  const step = () => JSON.parse(s.run('next', '--json').out).step;
  assert.equal(step(), 'revision');
  edit(s, (db) => db.prs[0].statusCheckRollup.push({ id: 2, name: 'Ghosty Review', app: 'ghosty-studio', status: 'COMPLETED', conclusion: 'SUCCESS' }));
  assert.equal(step(), 'evidencia');
  // Con hallazgos del revisor externo no pasa a evidencia.
  edit(s, (db) => { db.prs[0].statusCheckRollup[1].conclusion = 'FAILURE'; });
  assert.equal(step(), 'hallazgos');
});

test('PR en conflicto con la base: next lo pone primero con el comando; show y ready lo dicen; reintenta si GitHub aún no sabe (C28)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ body: 'Closes #5', mergeable: false, mergeableState: 'dirty', mergeableNull: 1, statusCheckRollup: [{ id: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })] });
  spawnSync('git', ['checkout', '-q', '-b', 'fix/puerta'], { cwd: s.repo });
  const n = JSON.parse(s.run('next', '--json').out);
  assert.equal(n.step, 'conflicto');
  assert.equal(n.command, 'git fetch origin && git switch fix/puerta && git merge origin/main');
  assert.match(n.why, /^el PR #76 está en conflicto con main: git fetch origin .* → resuelve los archivos marcados, git add <archivo>, git commit y git push; va antes que revisión o evidencia/);
  assert.equal(s.read().prs[0].mergeableReads, 1); // la primera lectura llegó null y se reintentó
  assert.match(s.run('status').out, /^Siguiente paso: conflicto\n {2}git fetch origin && git switch fix\/puerta && git merge origin\/main/);
  assert.match(s.run('show', '--pr', '76').out, /^PR #76 Arreglo a mano\n {2}CONFLICTO, primero esto: el PR #76 está en conflicto con main/);
  assert.match(s.run('ready').err, /Aviso: el PR #76 está en conflicto con main/);
  // Resuelto: next sigue con lo de siempre y show no lo menciona.
  edit(s, (db) => Object.assign(db.prs[0], { mergeable: true, mergeableState: 'clean' }));
  assert.equal(JSON.parse(s.run('next', '--json').out).step, 'revision');
  assert.doesNotMatch(s.run('show', '--pr', '76').out, /CONFLICTO/);
});

test('claim --cloud con el repo en varios espacios pide --workspace con las opciones (409 choose_workspace) (C26)', async () => {
  const gs = await fakeGs({ capacity: { status: 409, body: { error: 'choose_workspace', message: 'varios', choices: [{ id: 'w1', slug: 'acme', name: 'Acme' }, { id: 'w2', slug: 'otro', name: 'Otro' }] } } });
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  const tok = gs.grant();
  mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope }), { mode: 0o600 });
  try {
    const r = await s.runAsync(['claim', '5', '--cloud'], { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /varios espacios: di con cuál va con --workspace <slug> \(acme «Acme», otro «Otro»\)/);
    const w = await s.runAsync(['claim', '5', '--cloud', '--workspace', 'acme', '--yes'], { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } });
    assert.equal(w.code, 0, w.err);
    assert.equal(gs.devCalls.find((c) => c.method === 'POST').body.workspace, 'acme');
  } finally {
    await gs.close();
  }
});

test('claim --cloud sin --yes dice antes qué ocupa la nube y qué desalojaría, y no manda nada (C26)', async () => {
  for (const capacity of [null, { repo: 'acme/demo', owner: 'el espacio acme', slots: 2, used: 2, fits: false, evicts: [{ repo: 'acme/demo', pr: 73 }], queued: false, estimate: { minutes: 18, tokens: 2400000, basedOn: 5 }, buyUrl: 'https://www.ghosty.studio/app/workspaces/acme/plan?lugar=1' }]) {
    const gs = await fakeGs({ capacity, boardPrs: [{ pr: 73, repo: 'acme/demo' }] });
    const s = setup({ issues: { 5: issue(5, 'Salud') } });
    const tok = gs.grant();
    mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
    writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope }), { mode: 0o600 });
    try {
      const r = await s.runAsync(['claim', '5', '--cloud'], { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1' } });
      assert.equal(r.code, 75, r.err);
      assert.match(r.out, /Vas a mandar #5 a la nube .*gasta tokens/);
      assert.match(r.out, /Si la persona está de acuerdo: ghosty-dev claim 5 --cloud --yes/);
      if (capacity) assert.match(r.out, /Ocupa 1 de 2 cajas \(2 en uso en el espacio acme\) · desaloja la preview del #73 · suele tardar ~18 min y ~2\.4M tokens \(mediana de 5\)\n {2}Comprar más cajas: https:\/\/www\.ghosty\.studio\/app\/workspaces\/acme\/plan\?lugar=1/);
      else assert.match(r.out, /no dijo cuántas cajas quedan/);
      assert.ok(!gs.devCalls.some((c) => c.method === 'POST'));
      assert.doesNotMatch(r.out + r.err, /at_\d|rt_\d/);
    } finally {
      await gs.close();
    }
  }
});

test('claim parte de la base aunque el clon esté en otra rama, y avisa antes; --base inexistente se rechaza (C29)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: s.repo, encoding: 'utf8' }).stdout.trim();
  const main = g('rev-parse', 'main');
  g('checkout', '-q', '-b', 'feat/x');
  g('commit', '-q', '--allow-empty', '-m', 'trabajo de otro PR');
  assert.equal(s.run('claim', '5', '--base', 'no-existe').code, 1);
  const r = s.run('claim', '5');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Aviso: Estás en feat\/x; la rama nueva parte de main, no de feat\/x\./);
  assert.match(r.out, /rama: ghosty-dev\/5-salud \(parte de main\)/);
  assert.equal(g('rev-parse', 'ghosty-dev/5-salud'), main);
});

test('show <n> con n PR dice que es PR y qué pendiente cierra, sin confundirlo con un issue cerrado (C29)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [handPr({ body: 'Closes #5' })] });
  const r = s.run('show', '76');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#76 es un PR, no un pendiente: cierra #5 \(ghosty-dev show 5\)\.\nPR #76 Arreglo a mano\n {2}estado: abierto/);
  assert.doesNotMatch(r.out, /cerrado/);
  assert.equal(JSON.parse(s.run('show', '76', '--json').out).kind, 'pr');
  assert.equal(JSON.parse(s.run('show', '5', '--json').out).kind, 'issue');
});

test('asks y next ignoran avisos del bot de otro commit o de un check que ya no existe; los de la persona sí cuentan (C29)', () => {
  const bot = { login: 'ghosty-studio[bot]', type: 'Bot' };
  const s = setup({
    issues: { 5: issue(5, 'Salud') },
    prs: [handPr({ body: 'Closes #5', statusCheckRollup: [{ id: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: [
      { author: bot, body: '<!-- ghosty-dev:pedido -->\nEl CI del PR #76 falló (claude-review). Arréglalo.' },
      { author: bot, body: '<!-- ghosty-dev:pedido -->\nEl CI del PR #76 pasó en el commit bfc298a. Publica la evidencia.' },
    ] })],
  });
  spawnSync('git', ['checkout', '-q', '-b', 'fix/puerta'], { cwd: s.repo });
  assert.equal(JSON.parse(s.run('next', '--json').out).step, 'revision');
  const a = JSON.parse(s.run('asks', '5', '--peek', '--json').out);
  assert.deepEqual(a.asks, []);
  assert.deepEqual(a.stale.map((x) => x.reason), ['el check «claude-review» ya no existe en ' + SHA.slice(0, 7), `habla del commit bfc298a; la cabeza del PR es ${SHA.slice(0, 7)}`]);
  assert.match(s.run('asks', '5').out, /sin pedidos nuevos\.\nObsoletos \(avisos del bot/);
  // Un aviso del bot sobre la cabeza actual y un pedido de la persona sí son pedidos.
  edit(s, (db) => db.prs[0].comments.push({ author: bot, body: `<!-- ghosty-dev:pedido -->\nEl CI pasó en el commit ${SHA.slice(0, 7)}. Publica la evidencia.` }, { author: { login: 'bliss' }, body: '<!-- ghosty-dev:pedido -->\nusa la opción barata' }));
  assert.deepEqual(JSON.parse(s.run('asks', '5', '--json').out).asks.map((x) => x.by), ['ghosty-studio[bot]', 'bliss']);
  // asks <m> con m un PR cerrado: sus avisos del bot ya no aplican.
  edit(s, (db) => { db.prs[0].state = 'closed'; });
  const closed = JSON.parse(s.run('asks', '76', '--peek', '--json').out);
  assert.deepEqual(closed.asks.map((x) => x.by), ['bliss']);
  assert.ok(closed.stale.every((x) => x.reason === 'el PR #76 ya está cerrado'));
});
