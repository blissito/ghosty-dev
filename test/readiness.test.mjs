import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readinessOf, prepareBrief, READINESS_PATHS as P } from '../src/readiness.mjs';

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

test('sin config.json (Formmy, 23-nov): bloquea con review-check y dice el arreglo', () => {
  const r = read({ [P.config]: null });
  assert.equal(r.ready, false);
  assert.deepEqual(r.blocking.map((c) => c.id), ['review-check']);
  assert.match(r.blocking[0].fix, /ghosty-dev init/);
});

test('config sin reviewCheck cuenta como faltante; con otro check también', () => {
  assert.equal(read({ [P.config]: JSON.stringify({ unlinked: 'warn' }) }).ready, false);
  assert.equal(read({ [P.config]: '{no es json' }).ready, false);
});

test('gate viejo o ausente bloquea; la rama sin la puerta obligatoria también', () => {
  assert.equal(read({ [P.gate]: '// viejo' }).blocking[0].id, 'gate');
  assert.equal(read({ [P.gate]: null }).blocking[0].id, 'gate');
  const r = readinessOf({ files: good(), requiredChecks: ['test'], expected: { gate, evidence } });
  assert.deepEqual(r.blocking.map((c) => c.id), ['protection']);
  // Sin poder leer la protección no se inventa un bloqueo.
  assert.equal(readinessOf({ files: good(), requiredChecks: null, expected: { gate, evidence } }).ready, true);
});

test('plantilla y factory.md sólo avisan: no bloquean', () => {
  const r = read({ '.github/pull_request_template.md': 'sin renglón', [P.factory]: null });
  assert.equal(r.ready, true);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['pr-template', 'factory-md']);
});

test('prepareBrief: un criterio por bloqueo, con su arreglo', () => {
  const b = prepareBrief(read({ [P.config]: null }).blocking);
  assert.equal(b.title, 'Preparar el repo para ghosty-dev');
  assert.equal(b.criteria.length, 1);
  assert.match(b.criteria[0], /ghosty-dev init/);
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
