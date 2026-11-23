import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setup, issue, VALID_EVIDENCE, SHA, revisionMd } from '../testkit/helpers.mjs';
import { formatEvidence, formatRevision } from '../src/evidence.mjs';

const CRITERIA = '## Criterios de aceptación\n- [ ] /health responde 200\n';

test('--help corre', () => {
  const { run } = setup();
  const r = run('--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /ghosty-dev ready|ready \[--json\]/);
});

test('init --dry-run no escribe nada (en gh sólo lee)', () => {
  const { run, read, repo } = setup();
  const r = run('init', '--dry-run', '--json');
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.equal(plan.filter((p) => p.action === 'label').length, 4);
  assert.ok(plan.some((p) => p.action === 'gate'));
  assert.ok(read().calls.every((c) => c[0] === 'api' && c[2] === 'GET'), JSON.stringify(read().calls));
  assert.equal(existsSync(join(repo, '.github')), false);
});

test('init instala etiquetas, plantilla, Action, scripts de la puerta, skill y AGENTS.md', () => {
  const { run, read, repo } = setup();
  writeFileSync(join(repo, 'AGENTS.md'), '# Reglas del repo\n');
  const r = run('init', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Repo: acme\/demo · rama actual: main \(principal: main\)/);
  assert.deepEqual(read().labels.sort(), ['ghosty-dev:bloqueado', 'ghosty-dev:en-curso', 'ghosty-dev:esperando-ci', 'ghosty-dev:por-hacer']);
  for (const f of [
    '.github/ISSUE_TEMPLATE/pendiente.md',
    '.github/workflows/evidence-gate.yml',
    '.github/workflows/ghosty-checks.yml',
    '.github/ghosty-dev/gate.mjs',
    '.github/ghosty-dev/evidence.mjs',
    '.claude/skills/ghosty-dev/SKILL.md',
    '.claude/agents/ghosty-dev-revisor.md',
    '.github/pull_request_template.md',
  ]) {
    assert.ok(existsSync(join(repo, f)), f);
  }
  // Fila 46: el PR trae el renglón obligatorio del flujo principal.
  assert.match(readFileSync(join(repo, '.github/pull_request_template.md'), 'utf8'), /^Flujo principal probado con sesión: $/m);
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Reglas del repo/);
  assert.match(agents, /ghosty-dev:agents/);
  // Segunda vez: no duplica ni pisa.
  run('init');
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), agents);
});

test('la puerta instalada corre sola con el gh falso', () => {
  const s = setup({ issues: { 3: { ...issue(3, 'Salud', { body: CRITERIA }) } } });
  s.run('init');
  const db = s.read();
  db.issues[3].comments.push({ body: formatRevision(3, SHA, revisionMd()) }, { body: formatEvidence(3, VALID_EVIDENCE) });
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const event = s.write('event.json', JSON.stringify({ pull_request: { body: 'Closes #3', head: { sha: SHA } } }));
  const env = { ...process.env, GITHUB_EVENT_PATH: event, GHOSTY_DEV_GH: join(import.meta.dirname, '..', 'testkit', 'fake-gh.mjs'), FAKE_GH_STATE: join(s.root, 'gh.json') };
  const out = execFileSync(process.execPath, [join(s.repo, '.github/ghosty-dev/gate.mjs')], { env, encoding: 'utf8' });
  assert.match(out, /#3: evidencia válida/);
  assert.match(out, /#3: revisión del commit a1b2c3d sin hallazgos/);
});

test('ready ofrece los listos y oculta los bloqueados hasta que su bloqueo cierra', () => {
  const { run, read, root } = setup({ issues: { 1: issue(1, 'Base'), 2: issue(2, 'Encima') } });
  assert.equal(run('block', '2', '--by', '1').code, 0);
  assert.deepEqual(read().issues[2].blockedBy, [1]);
  // Con dependencias nativas GitHub ya muestra «Blocked»: la etiqueta se queda en por-hacer.
  assert.deepEqual(read().issues[2].labels, ['ghosty-dev:por-hacer']);
  let list = JSON.parse(run('ready', '--json').out);
  assert.deepEqual(list.map((i) => i.number), [1]);

  const db = read();
  db.issues[1].state = 'closed';
  writeFileSync(join(root, 'gh.json'), JSON.stringify(db));
  list = JSON.parse(run('ready', '--json').out);
  assert.deepEqual(list.map((i) => [i.number, i.reason]), [[2, 'por-hacer']]);
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
  assert.equal(out.branch, 'ghosty-dev/5-agregar-health');
  assert.ok(existsSync(out.worktree));
  const i = s.read().issues[5];
  assert.deepEqual(i.assignees, ['agente-a']);
  assert.deepEqual(i.labels, ['ghosty-dev:en-curso']);
});

test('un solo escritor: no se toma un pendiente de otro', () => {
  const s = setup({ issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-b'] }) } });
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
    headRefName: 'ghosty-dev/5-x',
    statusCheckRollup: [
      { name: 'test', status, conclusion },
      { name: 'ghosty-dev/evidencia', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  });
  const s = setup({ issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) }, prs: [pr('IN_PROGRESS', null)] });
  assert.equal(s.run('wait', '5').code, 0);
  assert.ok(s.read().issues[5].labels.includes('ghosty-dev:esperando-ci'));
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out), []);

  const db = s.read();
  db.prs = [pr('COMPLETED', 'SUCCESS')];
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const list = JSON.parse(s.run('ready', '--json').out);
  assert.deepEqual(list.map((i) => [i.number, i.reason]), [[5, 'ci-verde']]);
});

test('evidence rechaza lo inválido y publica lo válido con su marca', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { body: CRITERIA, labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) },
    prs: [{ number: 9, headRefName: 'ghosty-dev/5-x' }],
    runs: [{ databaseId: 77 }],
  });
  const bad = s.run('evidence', '5', '--file', s.write('mala.md', 'ya quedó'));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Evidencia inválida/);
  assert.equal(s.read().issues[5].comments.length, 0);

  const ok = s.run('evidence', '5', '--file', s.write('buena.md', VALID_EVIDENCE), '--json');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).rerun, 77);
  assert.match(s.read().issues[5].comments[0].body, /ghosty-dev:evidencia v0\.1/);
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

test('las copias de la puerta en .github/ghosty-dev están al día con src/', () => {
  const root = join(import.meta.dirname, '..');
  for (const f of ['evidence.mjs', 'gate.mjs']) {
    assert.equal(readFileSync(join(root, '.github/ghosty-dev', f), 'utf8'), readFileSync(join(root, 'src', f), 'utf8'), f);
  }
});

test('init deja ghosty-dev/evidencia obligatorio en main sin pisar los checks que ya había', () => {
  const { run, read, write } = setup({ protection: { required_status_checks: { strict: true, contexts: ['test'] } } });
  const r = run('init', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read().protection.required_status_checks.contexts, ['test', 'ghosty-dev/evidencia']);
  assert.equal(read().protection.required_status_checks.strict, true);
  const again = JSON.parse(run('init', '--json').out);
  assert.match(again.find((p) => p.action === 'gate').name, /ya estaba/);
});

test('init protege la rama aunque no tuviera protección', () => {
  const { run, read } = setup();
  assert.equal(run('init').code, 0);
  assert.deepEqual(read().protection.required_status_checks.contexts, ['ghosty-dev/evidencia']);
});

test('sin permisos de admin, init termina y dice cómo hacerlo a mano', () => {
  const { run, read } = setup({ noAdmin: true });
  const r = run('init', '--json');
  assert.equal(r.code, 0, r.err);
  const step = JSON.parse(r.out).find((p) => p.name?.includes('ghosty-dev/evidencia'));
  assert.equal(step.action, 'skip');
  assert.match(step.name, /Settings/);
});

test('--no-protect no toca la protección de la rama', () => {
  const { run, read } = setup();
  assert.equal(run('init', '--no-protect').code, 0);
  assert.equal(read().protection, undefined);
});

test('add abre un pendiente con la plantilla y, con --by, lo bloquea con la dependencia nativa', () => {
  const { run, read } = setup({ issues: { 1: issue(1, 'Servidor con /health') } });
  const r = run('add', 'Endpoint /version', '--goal', 'GET /version responde la versión', '--criteria', 'responde 200', '--criteria', 'hay un test', '--by', '1', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.number, 2);
  const i = read().issues[2];
  assert.match(i.body, /## Objetivo\nGET \/version responde la versión/);
  assert.match(i.body, /- \[ \] responde 200\n- \[ \] hay un test/);
  assert.deepEqual(i.blockedBy, [1]);
  assert.deepEqual(i.labels, ['ghosty-dev:por-hacer']);
});

test('add sin criterios se niega', () => {
  const { run } = setup();
  const r = run('add', 'X', '--goal', 'algo');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /criterio/);
});

test('si la puerta no está en main, init no protege la rama y protect lo hace después del push', () => {
  const { run, read, root } = setup({ gateOnBase: false });
  const r = run('init', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).find((p) => p.name?.includes('ghosty-dev/evidencia')).action, 'later');
  assert.equal(read().protection, undefined);
  assert.notEqual(run('protect').code, 0);
  writeFileSync(join(root, 'gh.json'), JSON.stringify({ ...read(), gateOnBase: true }));
  assert.equal(run('protect').code, 0);
  assert.deepEqual(read().protection.required_status_checks.contexts, ['ghosty-dev/evidencia']);
});

test('board da la liga de los pendientes abiertos del repo', () => {
  const { run } = setup();
  const r = run('board', '--json');
  assert.equal(r.code, 0, r.err);
  const url = decodeURIComponent(JSON.parse(r.out).url);
  assert.match(url, /^https:\/\/github\.com\/acme\/demo\/issues\?q=/);
  assert.match(url, /ghosty-dev:por-hacer,ghosty-dev:en-curso,ghosty-dev:esperando-ci/);
});

test('wait --watch espera al CI en una sola llamada y dice si quedó verde', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) },
    prs: [{ number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] }],
    ciResult: 'SUCCESS', // el CI termina mientras se espera
  });
  const r = s.run('wait', '5', '--watch', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.ci, 'verde');
  assert.equal(out.timedOut, false);
  // Todo por REST: ni `gh pr` ni `gh issue` (GraphQL).
  assert.ok(s.read().calls.every((c) => c[0] === 'api'));
  assert.ok(s.read().issues[5].labels.includes('ghosty-dev:esperando-ci'));
});

test('review sin --file da el encargo del revisor; con --file lo publica atado al commit del PR', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:esperando-ci'], assignees: ['agente-a'] }) },
    prs: [{ number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', headRefOid: SHA }],
  });
  const brief = s.run('review', '5');
  assert.equal(brief.code, 0, brief.err);
  assert.match(brief.out, /Revisa el pendiente #5/);
  assert.match(brief.out, /contexto limpio|No escribiste este código/);
  assert.doesNotMatch(brief.out, /^---/);

  const bad = s.run('review', '5', '--file', s.write('mal.md', '## Revisión\nTodo bien\n'));
  assert.notEqual(bad.code, 0);

  const ok = s.run('review', '5', '--file', s.write('rev.md', revisionMd(1)), '--json');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).open, 1);
  const body = s.read().issues[5].comments.at(-1).body;
  assert.match(body, new RegExp(`ghosty-dev:revision v0\\.1 sha=${SHA}`));
});

test('review se niega si el pendiente no tiene PR', () => {
  const s = setup({ issues: { 5: issue(5, 'X') } });
  const r = s.run('review', '5', '--file', s.write('rev.md', revisionMd()));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /no tiene PR/);
});

test('init --force actualiza sólo la sección de ghosty-dev en AGENTS.md', () => {
  const { run, repo } = setup();
  const old = '# Reglas del repo\n\n<!-- ghosty-dev:agents -->\n## Bitácora (ghosty-dev)\ntexto viejo\n\n## Otra cosa\nde la persona\n';
  writeFileSync(join(repo, 'AGENTS.md'), old);
  assert.equal(run('init').code, 0);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), old);
  assert.equal(run('init', '--force').code, 0);
  const now = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.match(now, /^# Reglas del repo/);
  assert.match(now, /## Otra cosa\nde la persona/);
  assert.doesNotMatch(now, /texto viejo/);
  assert.match(now, /ghosty-dev-revisor/);
  assert.equal(run('init', '--force').code, 0);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), now);
});

test('add abre el tablero una sola vez por tanda', () => {
  const { run } = setup({ repo: `acme/tanda-${Date.now()}` });
  const a = JSON.parse(run('add', 'A', '--goal', 'g', '--criteria', 'c', '--json').out);
  const b = JSON.parse(run('add', 'B', '--goal', 'g', '--criteria', 'c', '--json').out);
  assert.match(decodeURIComponent(a.board), /ghosty-dev:por-hacer/);
  assert.equal(b.board, null);
});

test('wait --watch no da verde si el commit nuevo todavía no tiene checks', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) },
    prs: [{ number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', statusCheckRollup: [{ name: 'ghosty-dev/evidencia', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
  });
  const r = s.run('wait', '5', '--watch', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).ci, 'sin-checks');
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out), []);
});

test('la evidencia y la revisión enlazan el PR', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:esperando-ci'], assignees: ['agente-a'], body: '## Objetivo\nSalud\n\n## Criterios de aceptación\n- [ ] /health responde 200\n' }) },
    prs: [{ number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', headRefOid: SHA }],
  });
  assert.equal(s.run('review', '5', '--file', s.write('r.md', revisionMd())).code, 0);
  assert.equal(s.run('evidence', '5', '--file', s.write('e.md', VALID_EVIDENCE)).code, 0);
  const [rev, ev] = s.read().issues[5].comments.slice(-2).map((c) => c.body);
  assert.match(rev, /PR: https:\/\/github\.com\/acme\/demo\/pull\/9/);
  assert.match(ev, /PR: https:\/\/github\.com\/acme\/demo\/pull\/9/);
});

test('evidence --check y review --check validan sin gh ni red y no publican', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud', { body: '## Criterios de aceptación\n- [ ] /health responde 200\n' }) } });
  const env = { ...process.env, GHOSTY_DEV_GH: '/no/existe/gh' };
  const bin = join(import.meta.dirname, '..', 'bin', 'ghosty-dev.mjs');
  const run = (...a) => spawnSync(process.execPath, [bin, ...a], { cwd: s.repo, encoding: 'utf8', env });
  const body = s.write('issue.md', '## Criterios de aceptación\n- [ ] /health responde 200\n');
  assert.equal(run('evidence', '--check', '--file', s.write('e.md', VALID_EVIDENCE), '--issue-file', body).status, 0);
  const bad = run('evidence', '--check', '--file', s.write('bad.md', VALID_EVIDENCE.replace('- [x] /health', '- [ ] /health')), '--issue-file', body);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Criterio sin cumplir/);
  assert.equal(run('review', '--check', '--file', s.write('r.md', revisionMd())).status, 0);
  assert.equal(run('review', '--check', '--file', s.write('r2.md', '## Revisión\nTodo bien.\n')).status, 1);
  assert.equal(s.read().issues[5].comments.length, 0);
});

test('un pedido de la persona despierta a su escritor: ready lo ofrece, wait lo trae y asks lo marca leído', () => {
  const s = setup({ issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) } });
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out), []);
  const db = s.read();
  db.issues[5].comments.push(
    { body: '<!-- ghosty-dev:evidencia v0.1 -->\n@ghosty esto es evidencia' },
    { body: '<!-- ghosty-dev:pedido -->\nusa la opción más barata\n\n<sub>Desde Teams, vía Ghosty</sub>', author: { login: 'bliss' } },
  );
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  assert.deepEqual(JSON.parse(s.run('ready', '--json').out).map((i) => [i.number, i.reason]), [[5, 'pedido']]);
  const shown = JSON.parse(s.run('show', '5', '--json').out);
  assert.equal(shown.asks.length, 1);
  const w = JSON.parse(s.run('wait', '5', '--watch', '--json').out);
  assert.match(w.asks[0].text, /^usa la opción más barata/);
  assert.deepEqual(JSON.parse(s.run('asks', '5', '--json').out).asks, []);
  // Ya leído: deja de ofrecerse como pedido (sin PR, sigue la regla de siempre: ci-sin-pr).
  assert.ok(!JSON.parse(s.run('ready', '--json').out).some((i) => i.reason === 'pedido'));
});

test('show trae la ficha del comentario fijo más reciente, sin el pie (C15)', async () => {
  const { fichaOf } = await import('../src/commands.mjs');
  const viejo = { body: '<!-- ghosty-dev:ficha -->\n**👻 Ficha del pendiente**\n\n| Estado | Viejo |' };
  const nuevo = { body: '<!-- ghosty-dev:ficha -->\n**👻 Ficha del pendiente**\n\n| Estado | Esperando el CI |\n\n<sub>La actualiza Ghosty</sub>' };
  const f = fichaOf([viejo, { body: 'otro' }, nuevo]);
  assert.ok(f.includes('Esperando el CI'));
  assert.ok(!f.includes('<sub>'));
  assert.equal(fichaOf([{ body: 'nada' }]), null);
});

test('init crea .ghosty/factory.md con 4gb en un repo sin señales de build pesado', () => {
  const { run, repo } = setup();
  const dry = JSON.parse(run('init', '--dry-run', '--json').out);
  const step = dry.find((p) => p.path === '.ghosty/factory.md');
  assert.equal(step.action, 'write');
  assert.equal(step.memory, '4gb');
  assert.equal(existsSync(join(repo, '.ghosty')), false);
  const r = run('init');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\.ghosty\/factory\.md \(memory: 4gb: no hay señales/);
  const md = readFileSync(join(repo, '.ghosty/factory.md'), 'utf8');
  assert.match(md, /^---\n(?:#.*\n)*memory: 4gb\n(?:#.*\n)*---\n/);
  // Fila 44: sugiere el smoke de la función principal (comentado: la ruta la elige la persona).
  assert.match(md, /^# smoke:\n#   - \/ruta-de-la-funcion-principal\n#   - POST /m);
  assert.doesNotMatch(md, /^## @/m); // el cuerpo no abre secciones de rol de Teams
});

test('init pide 8gb en un monorepo o con --max-old-space-size, y nunca pisa el manifiesto', () => {
  const mono = setup();
  writeFileSync(join(mono.repo, 'package.json'), JSON.stringify({ workspaces: ['app', 'sdk'] }));
  assert.equal(mono.run('init').code, 0);
  assert.match(readFileSync(join(mono.repo, '.ghosty/factory.md'), 'utf8'), /^memory: 8gb$/m);

  const heavy = setup();
  writeFileSync(join(heavy.repo, 'package.json'), JSON.stringify({ scripts: { build: 'NODE_OPTIONS=--max-old-space-size=6144 vite build' } }));
  const plan = JSON.parse(heavy.run('init', '--json').out);
  const step = plan.find((p) => p.path === '.ghosty/factory.md');
  assert.equal(step.memory, '8gb');
  assert.match(step.why, /«build».*max-old-space-size/);

  const own = '---\nmemory: 6gb\nbuild: { model: claude-opus-5 }\n---\nmío\n';
  writeFileSync(join(heavy.repo, '.ghosty/factory.md'), own);
  for (const args of [['init'], ['init', '--force']]) {
    const again = JSON.parse(heavy.run(...args, '--json').out).find((p) => p.path === '.ghosty/factory.md');
    assert.equal(again.action, 'skip');
    assert.equal(readFileSync(join(heavy.repo, '.ghosty/factory.md'), 'utf8'), own);
  }
});

test('el CI no cuenta Review, Preview, Revisiones del push ni la puerta; el Smoke sí (C17)', async () => {
  const { ciVerdict, NOT_CI_CHECKS } = await import('../src/commands.mjs');
  assert.deepEqual([...NOT_CI_CHECKS], ['Ghosty Review', 'ghosty-dev/evidencia', 'Ghosty · Preview', 'Ghosty · Revisiones del push']);
  const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  const running = (name) => ({ name, status: 'in_progress', conclusion: null });
  // Un Preview o una revisión en curso no dejan el CI en pendiente.
  assert.equal(ciVerdict({ runs: [done('test'), running('Ghosty · Preview'), running('Ghosty Review'), running('Ghosty · Revisiones del push')] }), 'verde');
  assert.equal(ciVerdict({ runs: [done('test'), done('Ghosty · Preview', 'failure')] }), 'verde');
  // Sólo checks de la plataforma: cero CI, no es verde.
  assert.equal(ciVerdict({ runs: [done('Ghosty Review'), done('ghosty-dev/evidencia', 'failure')] }), 'sin-checks');
  // El smoke contra la vista previa sí frena.
  assert.equal(ciVerdict({ runs: [done('test'), running('Ghosty · Smoke')] }), 'pendiente');
  assert.equal(ciVerdict({ runs: [done('test'), done('Ghosty · Smoke', 'failure')] }), 'rojo');
});

test('wait --watch no espera a la vista previa: el CI manda, y avisa cuando la revisión termina (C17)', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:en-curso'], assignees: ['agente-a'] }) },
    prs: [{
      number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', headRefOid: SHA,
      statusCheckRollup: [
        { id: 1, name: 'test', status: 'IN_PROGRESS' },
        { id: 2, name: 'Ghosty · Preview', status: 'IN_PROGRESS', title: 'La vista previa se está construyendo', then: { status: 'IN_PROGRESS' } },
        { id: 3, name: 'Ghosty Review', status: 'IN_PROGRESS', then: { conclusion: 'NEUTRAL', title: '2 hallazgos' } },
      ],
    }],
    ciResult: 'SUCCESS',
  });
  const r = s.run('wait', '5', '--watch', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.ci, 'verde');
  assert.equal(out.services.preview.status, 'pendiente');
  assert.equal(out.services.review.status, 'neutral');
  assert.equal(out.services.review.title, '2 hallazgos');
  assert.match(r.err, /Revisión: neutral \(2 hallazgos\)/);
  assert.doesNotMatch(r.err, /Vista previa/);
});

test('show lee la ficha del PR (antes que la del issue) y los servicios del commit del PR (C17)', () => {
  const s = setup({
    issues: { 5: issue(5, 'X', { labels: ['ghosty-dev:esperando-ci'], assignees: ['agente-a'] }) },
    prs: [{
      number: 9, url: 'https://github.com/acme/demo/pull/9', headRefName: 'ghosty-dev/5-x', headRefOid: SHA,
      comments: [{ body: '<!-- ghosty-dev:ficha -->\n**👻 Ficha del pendiente**\n\n| Estado | Del PR |' }],
      reviewComments: [
        { commit_id: SHA, user: { login: 'ghosty-studio[bot]', type: 'Bot' } },
        { commit_id: 'viejo', user: { login: 'ghosty-studio[bot]', type: 'Bot' } },
        { commit_id: SHA, user: { login: 'persona', type: 'User' } },
      ],
      statusCheckRollup: [
        { id: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { id: 2, name: 'Ghosty · Preview', status: 'IN_PROGRESS', title: 'La vista previa se está construyendo' },
        { id: 4, name: 'Ghosty · Preview', status: 'COMPLETED', conclusion: 'SUCCESS', title: 'Vista previa lista', detailsUrl: 'https://ghosty.studio/app/dev/r1' },
        { id: 3, name: 'Ghosty Review', status: 'COMPLETED', conclusion: 'NEUTRAL', title: '1 hallazgo' },
        { id: 5, name: 'Ghosty · Smoke', status: 'COMPLETED', conclusion: 'FAILURE', title: '/login responde 500' },
      ],
    }],
    deployments: [{ id: 77, sha: SHA, url: 'https://pr-9.preview.ghosty.studio' }],
  });
  const db = s.read();
  db.issues[5].comments.push({ body: '<!-- ghosty-dev:ficha -->\n| Estado | Del issue |' });
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const r = JSON.parse(s.run('show', '5', '--json').out);
  assert.match(r.ficha, /Del PR/);
  assert.equal(r.services.preview.status, 'listo');
  assert.equal(r.services.preview.deployment, 'https://pr-9.preview.ghosty.studio');
  assert.equal(r.services.review.comments, 1);
  assert.equal(r.services.smoke.status, 'fallo');
  assert.equal(r.services.ci, 'rojo');
  const human = s.run('show', '5').out;
  assert.match(human, /Servicios del PR \(commit a1b2c3d\):/);
  assert.match(human, /Vista previa: lista \(Vista previa lista\)\n {4}https:\/\/pr-9\.preview\.ghosty\.studio/);
  assert.match(human, /Revisión: neutral \(1 hallazgo · 1 comentario\(s\) de hallazgos\)/);
  assert.match(human, /Smoke: falló/);
  // Sin ficha en el PR, cae a la del issue.
  const db2 = s.read();
  db2.prs[0].comments = [];
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db2));
  assert.match(JSON.parse(s.run('show', '5', '--json').out).ficha, /Del issue/);
});
