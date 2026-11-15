import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, issue, VALID_EVIDENCE } from '../testkit/helpers.mjs';
import { formatEvidence } from '../src/evidence.mjs';

const CRITERIA = '## Criterios de aceptación\n- [ ] /health responde 200\n';

test('--help corre', () => {
  const { run } = setup();
  const r = run('--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /bitacora ready|ready \[--json\]/);
});

test('init --dry-run no escribe ni llama a gh', () => {
  const { run, read, repo } = setup();
  const r = run('init', '--dry-run', '--json');
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.equal(plan.filter((p) => p.action === 'label').length, 4);
  assert.equal(read().calls.length, 0);
  assert.equal(existsSync(join(repo, '.github')), false);
});

test('init instala etiquetas, plantilla, Action, scripts de la puerta, skill y AGENTS.md', () => {
  const { run, read, repo } = setup();
  writeFileSync(join(repo, 'AGENTS.md'), '# Reglas del repo\n');
  const r = run('init');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read().labels.sort(), ['bitacora:bloqueado', 'bitacora:esperando', 'bitacora:listo', 'bitacora:tomado']);
  for (const f of [
    '.github/ISSUE_TEMPLATE/pendiente.md',
    '.github/workflows/evidence-gate.yml',
    '.github/bitacora/gate.mjs',
    '.github/bitacora/evidence.mjs',
    '.claude/skills/bitacora/SKILL.md',
  ]) {
    assert.ok(existsSync(join(repo, f)), f);
  }
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Reglas del repo/);
  assert.match(agents, /bitacora:agents/);
  // Segunda vez: no duplica ni pisa.
  run('init');
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), agents);
});

test('la puerta instalada corre sola con el gh falso', () => {
  const s = setup({ issues: { 3: { ...issue(3, 'Salud', { body: CRITERIA }) } } });
  s.run('init');
  const db = s.read();
  db.issues[3].comments.push({ body: formatEvidence(3, VALID_EVIDENCE) });
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const event = s.write('event.json', JSON.stringify({ pull_request: { body: 'Closes #3' } }));
  const env = { ...process.env, GITHUB_EVENT_PATH: event, BITACORA_GH: join(import.meta.dirname, '..', 'testkit', 'fake-gh.mjs'), FAKE_GH_STATE: join(s.root, 'gh.json') };
  const out = execFileSync(process.execPath, [join(s.repo, '.github/bitacora/gate.mjs')], { env, encoding: 'utf8' });
  assert.match(out, /#3: evidencia válida/);
});

test('ready ofrece los listos y oculta los bloqueados hasta que su bloqueo cierra', () => {
  const { run, read, root } = setup({ issues: { 1: issue(1, 'Base'), 2: issue(2, 'Encima') } });
  assert.equal(run('block', '2', '--by', '1').code, 0);
  assert.deepEqual(read().issues[2].blockedBy, [1]);
  assert.ok(read().issues[2].labels.includes('bitacora:bloqueado'));
  let list = JSON.parse(run('ready', '--json').out);
  assert.deepEqual(list.map((i) => i.number), [1]);

  const db = read();
  db.issues[1].state = 'closed';
  writeFileSync(join(root, 'gh.json'), JSON.stringify(db));
  list = JSON.parse(run('ready', '--json').out);
  assert.deepEqual(list.map((i) => [i.number, i.reason]), [[2, 'desbloqueado']]);
});

test('block sin API de dependencias escribe «Bloqueado por» en el cuerpo', () => {
  const s = setup({ depsApi: false, issues: { 1: issue(1, 'Base'), 2: issue(2, 'Encima', { body: '## Objetivo\nx\n' }) } });
  const r = s.run('block', '2', '--by', '1', '--json');
  assert.equal(JSON.parse(r.out).via, 'cuerpo');
  assert.match(s.read().issues[2].body, /## Bloqueado por\n- #1/);
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out).map((i) => i.number), [1]);
  assert.equal(s.run('claim', '2', '--no-worktree').code, 1);
});

test('claim asigna, marca tomado y crea rama + worktree', () => {
  const s = setup({ issues: { 5: issue(5, 'Agregar /health') } });
  const r = s.run('claim', '5', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.branch, 'bitacora/5-agregar-health');
  assert.ok(existsSync(out.worktree));
  const i = s.read().issues[5];
  assert.deepEqual(i.assignees, ['agente-a']);
  assert.deepEqual(i.labels, ['bitacora:tomado']);
});

test('un solo escritor: no se toma un pendiente de otro', () => {
  const s = setup({ issues: { 5: issue(5, 'X', { labels: ['bitacora:tomado'], assignees: ['agente-b'] }) } });
  const r = s.run('claim', '5', '--no-worktree');
  assert.equal(r.code, 1);
  assert.match(r.err, /Un solo escritor/);
});

test('si dos se asignan a la vez, el segundo se retira', () => {
  const s = setup({ raceWith: 'agente-b', issues: { 5: issue(5, 'X') } });
  const r = s.run('claim', '5', '--no-worktree');
  assert.equal(r.code, 1);
  assert.deepEqual(s.read().issues[5].assignees, ['agente-b']);
});

test('wait deja el pendiente esperando y ready lo devuelve sólo cuando el CI resolvió', () => {
  const pr = (status, conclusion) => ({
    number: 9,
    url: 'https://github.com/acme/demo/pull/9',
    headRefName: 'bitacora/5-x',
    statusCheckRollup: [
      { name: 'test', status, conclusion },
      { name: 'bitacora/evidencia', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  });
  const s = setup({ issues: { 5: issue(5, 'X', { labels: ['bitacora:tomado'], assignees: ['agente-a'] }) }, prs: [pr('IN_PROGRESS', null)] });
  assert.equal(s.run('wait', '5').code, 0);
  assert.ok(s.read().issues[5].labels.includes('bitacora:esperando'));
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out), []);

  const db = s.read();
  db.prs = [pr('COMPLETED', 'SUCCESS')];
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const list = JSON.parse(s.run('ready', '--json').out);
  assert.deepEqual(list.map((i) => [i.number, i.reason]), [[5, 'ci-verde']]);
});

test('evidence rechaza lo inválido y publica lo válido con su marca', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { body: CRITERIA, labels: ['bitacora:tomado'], assignees: ['agente-a'] }) },
    prs: [{ number: 9, headRefName: 'bitacora/5-x' }],
    runs: [{ databaseId: 77 }],
  });
  const bad = s.run('evidence', '5', '--file', s.write('mala.md', 'ya quedó'));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Evidencia inválida/);
  assert.equal(s.read().issues[5].comments.length, 0);

  const ok = s.run('evidence', '5', '--file', s.write('buena.md', VALID_EVIDENCE), '--json');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).rerun, 77);
  assert.match(s.read().issues[5].comments[0].body, /bitacora:evidencia v0\.1/);
});

test('close sin evidencia se niega; con evidencia cierra', () => {
  const s = setup({ issues: { 5: issue(5, 'X', { body: CRITERIA }) } });
  assert.equal(s.run('close', '5').code, 1);
  assert.equal(s.read().issues[5].state, 'open');
  s.run('evidence', '5', '--file', s.write('e.md', VALID_EVIDENCE));
  assert.equal(s.run('close', '5').code, 0);
  assert.equal(s.read().issues[5].state, 'closed');
  assert.equal(JSON.parse(s.run('show', '5', '--json').out).evidence, true);
});
