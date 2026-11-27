// Repos privados sin GitHub Actions (27-nov, Formmy): init sin workflows, la puerta la evalúa gs, el deploy sale del CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, issue, VALID_EVIDENCE } from '../testkit/helpers.mjs';
import { withPreview } from '../testkit/with-pr.mjs';
import { deployConfig, deployMarkers } from '../src/deploy-config.mjs';
import { privateWorkflowsCheck } from '../src/commands.mjs';

const PRIVATE = { repoInfo: { private: true, visibility: 'private' } };
const CRITERIA = '## Criterios de aceptación\n- [ ] /health responde 200\n';
const WORKFLOWS = ['.github/workflows/evidence-gate.yml', '.github/workflows/ghosty-checks.yml'];
const edit = (s, fn) => {
  const db = s.read();
  fn(db);
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
};

test('init en repo privado no escribe workflows de Actions y dice por qué; el resto sí', () => {
  const s = setup(PRIVATE);
  const r = s.run('init', '--yes', '--no-protect');
  assert.equal(r.code, 0, r.err);
  for (const f of WORKFLOWS) assert.ok(!existsSync(join(s.repo, f)), f);
  for (const f of ['.github/ghosty-dev/gate.mjs', '.claude/skills/ghosty-dev/SKILL.md', 'AGENTS.md', '.github/ghosty-dev/config.json']) assert.ok(existsSync(join(s.repo, f)), f);
  assert.match(r.out, /privado .*repo privado: la puerta la evalúa Ghosty Studio/);
});

test('init en repo público sigue igual: escribe los dos workflows', () => {
  const s = setup({ repoInfo: { private: false, visibility: 'public' } });
  const r = s.run('init', '--yes', '--no-protect');
  assert.equal(r.code, 0, r.err);
  for (const f of WORKFLOWS) assert.ok(existsSync(join(s.repo, f)), f);
  assert.doesNotMatch(r.out, /repo privado/);
});

test('doctor: repo privado con los workflows de ghosty-dev avisa y dice cómo borrarlos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-priv-'));
  const prev = process.env.GHOSTY_DEV_REPO_VISIBILITY;
  process.env.GHOSTY_DEV_REPO_VISIBILITY = 'private';
  try {
    assert.equal(privateWorkflowsCheck(dir).ok, true);
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, WORKFLOWS[0]), 'on: pull_request\n');
    const c = privateWorkflowsCheck(dir);
    assert.equal(c.ok, null);
    assert.match(c.detail, /nunca arrancan/);
    assert.match(c.fix, /git rm \.github\/workflows\/evidence-gate\.yml/);
    process.env.GHOSTY_DEV_REPO_VISIBILITY = 'public';
    assert.equal(privateWorkflowsCheck(dir), null);
  } finally {
    if (prev === undefined) delete process.env.GHOSTY_DEV_REPO_VISIBILITY;
    else process.env.GHOSTY_DEV_REPO_VISIBILITY = prev;
  }
});

test('evidence en repo privado pide la puerta a Ghosty Studio, no re-corre Actions', async () => {
  await withPreview([{ phase: 'none' }], async ({ gs, s, cli }) => {
    edit(s, (db) => {
      Object.assign(db, PRIVATE, { runs: [{ databaseId: 77 }] });
      db.issues[5] = issue(5, 'Salud', { body: CRITERIA, labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] });
    });
    const r = await cli(['evidence', '5', '--file', s.write('e.md', VALID_EVIDENCE), '--json']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.rerun, null);
    assert.equal(out.gate.conclusion, 'failure');
    assert.deepEqual(gs.gateCalls, [{ method: 'POST', repo: 'acme/demo', pr: 73 }]);
    assert.equal(s.read().reruns, undefined);
  });
});

test('gate <pr>: privado lo evalúa gs (sale 1 si roja, 0 si verde); público re-corre la Action', async () => {
  await withPreview([{ phase: 'none' }], async ({ gs, s, cli }) => {
    edit(s, (db) => Object.assign(db, PRIVATE));
    let r = await cli(['gate', '73']);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /Puerta ghosty-dev\/evidencia del PR #73 \(evaluada por Ghosty Studio\): ROJA/);
    assert.match(r.out, /#5: sin comentario de evidencia/);
    gs.gate = { conclusion: 'success', summary: 'todo en orden' };
    r = await cli(['gate', '73']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /verde — todo en orden/);
    edit(s, (db) => Object.assign(db, { repoInfo: { private: false }, runs: [{ databaseId: 77 }] }));
    r = await cli(['gate', '73', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).rerun, 77);
    assert.equal(gs.gateCalls.length, 2);
  });
});

test('deployConfig: dev.md manda y cae a factory.md por llave; los marcadores se leen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gd-cfg-'));
  mkdirSync(join(dir, '.ghosty'));
  assert.deepEqual(deployConfig(dir), { deploy: null, deployCheck: null, source: null });
  writeFileSync(join(dir, '.ghosty/factory.md'), '---\nmemory: 4gb\ndeploy: ./viejo.sh\ndeploy_check: https://ejemplo.com/salud\n---\n');
  writeFileSync(join(dir, '.ghosty/dev.md'), '---\ndeploy: "./scripts/deploy-fly.sh"  # producción\nci:\n  - npm test\n---\nnotas\n');
  assert.deepEqual(deployConfig(dir), { deploy: './scripts/deploy-fly.sh', deployCheck: 'https://ejemplo.com/salud', source: '.ghosty/dev.md' });
  assert.deepEqual(deployMarkers([{ body: 'hola' }, { body: 'x\n<!-- ghosty-dev:deploy fail sha=abc1234 -->' }, { body: '<!-- ghosty-dev:deploy ok sha=def5678 -->' }]).map((m) => [m.ok, m.sha]), [[false, 'abc1234'], [true, 'def5678']]);
});

// Un clon con remoto (bare) y .ghosty/dev.md subido: lo que necesita `deploy` (pull --ff-only con árbol limpio).
function withRemote(s, front) {
  const g = (...a) => execFileSync('git', a, { cwd: s.repo, stdio: 'pipe' }).toString().trim();
  const bare = join(s.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  g('remote', 'add', 'origin', bare);
  mkdirSync(join(s.repo, '.ghosty'), { recursive: true });
  writeFileSync(join(s.repo, '.ghosty/dev.md'), `---\n${front}\n---\n`);
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'dev.md');
  g('push', '-q', '-u', 'origin', 'main');
  return g('rev-parse', 'HEAD');
}

async function healthServer(statuses) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(statuses.length > 1 ? statuses.shift() : statuses[0]).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, seen, close: () => new Promise((r) => server.close(r)) };
}

const ok = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const mergeable = () => ({ number: 81, title: 'Chat', url: 'https://github.com/acme/demo/pull/81', headRefName: 'ghosty-dev/5-chat', headRefOid: 'abc1234def', body: 'Closes #5', comments: [], statusCheckRollup: [ok('test'), ok('Ghosty Review'), ok('ghosty-dev/evidencia')] });
const EXTRA = { GHOSTY_DEV_DEPLOY_CHECK_EVERY_MS: '20', GHOSTY_DEV_DEPLOY_CHECK_MS: '3000' };

test('merge en repo privado corre el deploy declarado, espera el 200 y deja el marcador; next/show ya no lo piden', async () => {
  const h = await healthServer([503, 200]);
  try {
    const s = setup({ ...PRIVATE, issues: { 5: issue(5, 'Chat', { labels: ['ghosty-dev:esperando-ci'] }) }, prs: [mergeable()], mergeSha: 'm0rg3', mergedAt: new Date().toISOString() });
    const head = withRemote(s, `deploy: echo desplegando-formmy\ndeploy_check: ${h.url}`);
    const r = await s.runAsync(['merge', '81'], { extra: EXTRA });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Merge del PR #81 hecho/);
    assert.match(r.out, /deploy \(echo desplegando-formmy\): en producción · http:\/\/127\.0\.0\.1:\d+\/ → 200/);
    assert.doesNotMatch(r.out, /workflow de deploy/);
    assert.match(r.err, /desplegando-formmy/); // la salida del comando se ve (stderr: el merge imprime su resumen aparte)
    assert.ok(h.seen.length >= 2);
    const db = s.read();
    const noteBody = db.issues[5].comments.at(-1).body;
    assert.match(noteBody, /📝 \*\*Nota\*\* \(ghosty-dev\)/);
    assert.ok(noteBody.includes(`<!-- ghosty-dev:deploy ok sha=${head} -->`), noteBody);
    assert.ok(!db.calls.some((c) => c.some((a) => String(a).includes('/actions/runs?'))), 'no lee runs de Actions');
    const n = s.run('next', '--json');
    assert.notEqual(JSON.parse(n.out).step, 'deploy', n.out);
    const sh = s.run('show', '--pr', '81');
    assert.match(sh.out, /deploy: En producción/);
  } finally {
    await h.close();
  }
});

test('merge --no-deploy en privado no despliega; next y show --pr sugieren ghosty-dev deploy', async () => {
  const s = setup({ ...PRIVATE, issues: { 5: issue(5, 'Chat', { labels: ['ghosty-dev:esperando-ci'] }) }, prs: [mergeable()], mergedAt: new Date().toISOString() });
  withRemote(s, 'deploy: touch NO-DEBIA-CORRER');
  const r = await s.runAsync(['merge', '81', '--no-deploy']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Sin deploy \(--no-deploy\)\. Cuando quieras: ghosty-dev deploy 81/);
  assert.ok(!existsSync(join(s.repo, 'NO-DEBIA-CORRER')));
  assert.equal(s.read().issues[5].comments.length, 0);
  const n = JSON.parse(s.run('next', '--json').out);
  assert.equal(n.step, 'deploy');
  assert.equal(n.command, 'ghosty-dev deploy 81');
  assert.match(s.run('show', '--pr', '81').out, /Sin deploy registrado.*→ ghosty-dev deploy 81/);
});

test('merge en privado sin deploy declarado dice cómo declararlo', async () => {
  const s = setup({ ...PRIVATE, issues: { 5: issue(5, 'Chat') }, prs: [mergeable()] });
  const r = await s.runAsync(['merge', '81']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Repo privado sin deploy declarado: declara el comando en el frontmatter de \.ghosty\/dev\.md/);
});

test('deploy <pr>: comando que falla deja el marcador fail y sale 1; árbol sucio o fuera de la base no corre', async () => {
  const s = setup({ ...PRIVATE, issues: { 5: issue(5, 'Chat') }, prs: [{ ...mergeable(), state: 'closed', mergedAt: '2026-11-27T10:00:00Z' }] });
  const head = withRemote(s, 'deploy: echo rompo && exit 3');
  let r = await s.runAsync(['deploy', '81']);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.out, /FALLÓ/);
  assert.match(r.out, /salió 3/);
  assert.ok(s.read().issues[5].comments.at(-1).body.includes(`<!-- ghosty-dev:deploy fail sha=${head} -->`));
  writeFileSync(join(s.repo, 'sucio.txt'), 'x');
  r = await s.runAsync(['deploy', '81']);
  assert.equal(r.code, 1);
  assert.match(r.err, /cambios sin commit/);
  execFileSync('git', ['checkout', '-q', '-b', 'otra'], { cwd: s.repo });
  r = await s.runAsync(['deploy', '81']);
  assert.match(r.err, /Estás en otra: el deploy sale de main/);
});
