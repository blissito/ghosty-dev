import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readinessOf, prepareBrief, installedGateVersion, MIN_GATE_VERSION, READINESS_PATHS as P } from '../src/readiness.mjs';

const gate = readFileSync(new URL('../src/gate.mjs', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../src/evidence.mjs', import.meta.url), 'utf8');
const good = () => ({
  [P.gate]: gate, [P.evidence]: evidence, [P.workflow]: 'name: ghosty-dev', [P.factory]: '# f',
  [P.config]: JSON.stringify({ reviewCheck: { name: 'Ghosty Review', app: 'ghosty-studio' } }),
  '.github/pull_request_template.md': '- Flujo principal probado con sesión: x',
});
const read = (over = {}) => readinessOf({ files: { ...good(), ...over }, requiredChecks: ['ghosty-dev/evidencia'], expected: { gate, evidence } });

test('todo en orden: listo y sin bloqueos', () => {
  const r = read();
  assert.equal(r.ready, true);
  assert.deepEqual(r.blocking, []);
});

test('sin config.json (Formmy, 23-nov): ya no bloquea (revisor por defecto), avisa y dice el arreglo', () => {
  const r = read({ [P.config]: null });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blocking, []);
  const w = r.checks.find((c) => c.id === 'review-check');
  assert.equal(w.ok, false);
  assert.equal(w.severity, 'warn');
  assert.match(w.fix, /ghosty-dev init/);
});

test('config sin reviewCheck cuenta como faltante (aviso); con otro check también', () => {
  const missing = (cfg) => read({ [P.config]: cfg }).checks.find((c) => c.id === 'review-check').ok;
  assert.equal(missing(JSON.stringify({ unlinked: 'warn' })), false);
  assert.equal(missing('{no es json'), false);
});

test('copia distinta pero >= mínima: ready con aviso gate-version (Formmy 0.9.39→0.9.40)', () => {
  const r = read({ [P.gate]: gate + '\n// otra versión', [P.evidence]: evidence.replace(/GATE_VERSION = '[\d.]+'/, `GATE_VERSION = '${MIN_GATE_VERSION}'`) });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blocking, []);
  const w = r.checks.find((c) => c.id === 'gate-version');
  assert.equal(w.ok, false);
  assert.equal(w.severity, 'warn');
  assert.match(w.fix, /init --force --no-checks --files-only/);
  // Sin marcador pero con GATE_CHECKS (0.9.38–0.9.40) también cuenta como compatible.
  assert.equal(installedGateVersion("export const GATE_CHECKS = [];"), '0.9.38');
  assert.equal(read({ [P.evidence]: "export const GATE_CHECKS = [];" }).ready, true);
});

test('puerta anterior a la mínima, o sin marcador ni GATE_CHECKS: bloquea', () => {
  const old = read({ [P.evidence]: "export const GATE_VERSION = '0.9.37';" });
  assert.equal(old.ready, false);
  assert.equal(old.blocking[0].id, 'gate');
  assert.equal(read({ [P.evidence]: '// viejísima' }).blocking[0].id, 'gate');
  assert.equal(read({ [P.evidence]: null }).blocking[0].id, 'gate');
});

test('gate viejo o ausente bloquea', () => {
  assert.equal(read({ [P.gate]: null }).blocking[0].id, 'gate');
  assert.equal(read({ [P.gate]: null }).blocking[0].id, 'gate');
  // Sin poder leer la protección no se inventa un bloqueo.
  assert.equal(readinessOf({ files: good(), requiredChecks: null, expected: { gate, evidence } }).ready, true);
});

test('repo sin protección + puerta instalada: ready con un aviso protection', () => {
  const r = readinessOf({ files: good(), requiredChecks: ['test'], expected: { gate, evidence } });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blocking, []);
  const w = r.checks.find((c) => c.id === 'protection');
  assert.equal(w.ok, false);
  assert.equal(w.severity, 'warn');
  assert.match(w.fix, /ghosty-dev protect/);
  assert.match(w.fix, /persona dueña/);
});

test('plantilla y factory.md sólo avisan: no bloquean', () => {
  const r = read({ '.github/pull_request_template.md': 'sin renglón', [P.factory]: null });
  assert.equal(r.ready, true);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['pr-template', 'factory-md']);
});

test('prepareBrief: un criterio por bloqueo, con su arreglo', () => {
  const b = prepareBrief(read({ [P.workflow]: null }).blocking);
  assert.equal(b.title, 'Preparar el repo para ghosty-dev');
  assert.equal(b.criteria.length, 1);
  assert.match(b.criteria[0], /ghosty-dev init --force --files-only/);
  assert.match(b.goal, /--files-only/);
  assert.doesNotMatch(b.goal, /--no-protect/);
});

test('prepareBrief: la protección de la rama no es criterio del escritor', () => {
  const b = prepareBrief([
    { id: 'protection', ok: false, severity: 'block', why: 'main no exige la puerta', fix: 'ghosty-dev protect' },
    { id: 'workflow', ok: false, severity: 'block', why: 'falta el workflow', fix: 'ghosty-dev init' },
  ]);
  assert.equal(b.criteria.length, 1);
  assert.match(b.criteria[0], /falta el workflow/);
  assert.match(b.goal, /ghosty-dev protect/);
});

import { setup, issue } from '../testkit/helpers.mjs';

test('claim con el repo sin preparar: abre «Preparar el repo» UNA vez, bloquea #n y sale 7; --skip-readiness lo deja pasar', async () => {
  const s = setup({ issues: { 5: issue(5, 'Agregar /health'), 7: issue(7, 'Otra cosa') } });
  const env = { GHOSTY_DEV_SKIP_READINESS: undefined };
  const r = await s.runAsync(['claim', '5', '--json'], { extra: env });
  assert.equal(r.code, 7, r.err + r.out);
  const out = JSON.parse(r.out);
  assert.equal(out.notReady, true);
  assert.equal(out.blocked, 5);
  const st = s.read();
  const preps = Object.values(st.issues).filter((i) => i.title === 'Preparar el repo para ghosty-dev');
  assert.equal(preps.length, 1);
  assert.match(preps[0].body, /ghosty-dev init/);
  // Segundo intento: reutiliza el pendiente de preparación, no abre otro.
  const again = await s.runAsync(['claim', '5', '--json'], { extra: env });
  assert.equal(again.code, 7);
  assert.equal(Object.values(s.read().issues).filter((i) => i.title === 'Preparar el repo para ghosty-dev').length, 1);
  // Tomar el propio pendiente de preparación no se bloquea a sí mismo.
  const own = await s.runAsync(['claim', String(out.prep), '--json'], { extra: env });
  assert.equal(own.code, 0, own.err);
  // --skip-readiness: pasa (con otro pendiente: #5 ya quedó bloqueado por la preparación).
  const skipped = await s.runAsync(['claim', '7', '--skip-readiness', '--json'], { extra: env });
  assert.equal(skipped.code, 0, skipped.err);
});

test('readiness.mjs lee reviewCheck igual que gate.mjs (copia autocontenida sin deriva)', async () => {
  const { reviewCheckConfig } = await import('../src/gate.mjs');
  const r = (cfg) => readinessOf({ files: { '.github/ghosty-dev/config.json': cfg } }).checks.find((c) => c.id === 'review-check').ok;
  for (const cfg of ['{"reviewCheck":{"name":"Ghosty Review","app":"ghosty-studio"}}', '{"reviewCheck":{"name":"x"}}', 'no json', '{}']) {
    assert.equal(r(cfg), Boolean(reviewCheckConfig(cfg)), cfg);
  }
});

test('prepareBrief: el escritor no mezcla; usa --no-checks y dice que mezclar es de la persona', () => {
  const b = prepareBrief(read({ [P.workflow]: null }).blocking);
  assert.doesNotMatch(b.criteria[0], /y mezclar ese PR/);
  assert.match(b.criteria[0], /--files-only --no-checks/);
  assert.match(b.criteria[0], /mezclarlo es de la persona/);
  assert.match(b.goal, /--no-checks/);
});

test('puerta-gate ausente dice que compara contra la rama base y que se corrige al mezclar el PR de preparación', () => {
  const r = read({ [P.gate]: null });
  assert.match(r.checks.find((c) => c.id === 'gate').why, /rama|main|la rama principal/);
  assert.match(r.checks.find((c) => c.id === 'gate').why, /se corrige al mezclar el PR de preparación/);
});

test('isPreparationIssue: por título o porque su objetivo son los chequeos de readiness', async () => {
  const { isPreparationIssue } = await import('../src/readiness.mjs');
  assert.equal(isPreparationIssue({ title: 'Preparar el repo para ghosty-dev', body: '' }), true);
  assert.equal(isPreparationIssue({ title: 'gate.mjs al día', body: '## Objetivo\nActualizar la puerta: ghosty-dev init --force' }), true);
  assert.equal(isPreparationIssue({ title: 'Endpoint /version', body: 'GET /version responde' }), false);
});

test('findPreparationIssue reutiliza el vivo (título o contenido) y ensurePreparation no bloquea al que ya es de preparación', async () => {
  const { findPreparationIssue } = await import('../src/commands.mjs');
  const open = [{ number: 3, title: 'Otra cosa', body: '' }, { number: 125, title: 'gate.mjs al día', body: 'Actualizar la puerta con ghosty-dev init --force' }];
  assert.equal(findPreparationIssue(open).number, 125);
  assert.equal(findPreparationIssue([...open, { number: 9, title: 'Preparar el repo para ghosty-dev', body: '' }]).number, 9);
  assert.equal(findPreparationIssue([{ number: 3, title: 'x', body: '' }]), null);
});

test('GATE_VERSION de evidence.mjs coincide con la versión del paquete', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(installedGateVersion(evidence), pkg.version);
});
