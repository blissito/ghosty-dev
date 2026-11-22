// La puerta ghosty-dev/evidencia (C22): en borrador no exige nada y lo dice; si la rama base no trae su script o no
// carga, sale en verde con la explicación (nunca un MODULE_NOT_FOUND en rojo). Se corre el mismo paso del workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/evidence-gate.yml'), 'utf8');
// El JS del paso, tal cual está en el workflow (entre `node --input-type=module -e '` y la comilla de cierre).
const STEP = WORKFLOW.match(/node --input-type=module -e '\n([\s\S]*?)\n\s*'\n/)[1];

function runStep({ gate, pr = { number: 9, draft: false, body: '', head: { sha: 'abc' } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  if (gate) {
    mkdirSync(join(dir, '.github/ghosty-dev'), { recursive: true });
    if (gate === 'real') {
      copyFileSync(join(ROOT, 'src/gate.mjs'), join(dir, '.github/ghosty-dev/gate.mjs'));
      copyFileSync(join(ROOT, 'src/evidence.mjs'), join(dir, '.github/ghosty-dev/evidence.mjs'));
    } else writeFileSync(join(dir, '.github/ghosty-dev/gate.mjs'), gate);
  }
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: pr }));
  const summary = join(dir, 'summary.md');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', STEP], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, GHOSTY_DEV_GH: '/nonexistent-gh' },
  });
  let sum = '';
  try {
    sum = readFileSync(summary, 'utf8');
  } catch {}
  return { code: r.status, out: r.stdout + r.stderr, summary: sum };
}

test('el workflow corre también al marcar listo el PR (ready_for_review) (C22)', () => {
  assert.match(WORKFLOW, /types: \[[^\]]*ready_for_review[^\]]*\]/);
  // El script se sigue leyendo de la rama base.
  assert.match(WORKFLOW, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
});

test('en borrador la puerta sale en verde con «Borrador: la evidencia se exige al marcarlo listo» (C22)', () => {
  const r = runStep({ gate: 'real', pr: { number: 9, draft: true, body: '', head: { sha: 'abc' } } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.summary, /Borrador: la evidencia se exige al marcarlo listo\./);
  // Listo y sin «Closes #n»: ahora sí exige, en rojo.
  const ready = runStep({ gate: 'real' });
  assert.equal(ready.code, 1);
  assert.match(ready.summary, /no cierra ningún pendiente/);
});

test('sin script en la base, o con uno que no carga, la puerta no truena: verde con la explicación (C22)', () => {
  const none = runStep();
  assert.equal(none.code, 0, none.out);
  assert.match(none.summary, /la rama base no tiene \.github\/ghosty-dev\/gate\.mjs/);
  assert.match(none.out, /::notice title=ghosty-dev\/evidencia::/);
  const broken = runStep({ gate: "import './evidence.mjs';\n" });
  assert.equal(broken.code, 0, broken.out);
  assert.match(broken.summary, /el script de la base no carga \(ERR_MODULE_NOT_FOUND\)/);
});

test('un gate.mjs viejo (sin main exportado) se corre como antes, con su código de salida (C22)', () => {
  const old = `import { realpathSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nconst me = process.argv[1] ? realpathSync(process.argv[1]) : '';\nif (import.meta.url === pathToFileURL(me).href) { console.log('puerta vieja'); process.exit(1); }\n`;
  const r = runStep({ gate: old });
  assert.equal(r.code, 1);
  assert.match(r.out, /puerta vieja/);
});
