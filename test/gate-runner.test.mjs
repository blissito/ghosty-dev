// La puerta ghosty-dev/evidencia (C22): en borrador no exige nada y lo dice; sin script en la base (repo sin instalar)
// pasa con aviso; con script que no carga o truena, falla CERRADA: rojo con el error limpio y el remedio.
// Se corre el mismo paso del workflow.
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

// Un gh mínimo que contesta `gh api repos/…/pulls/N` con las respuestas dadas, una por llamada (la última se repite).
function fakePullsGh(dir, replies) {
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ replies, calls: 0 }));
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs'); const f = ${JSON.stringify(join(dir, 'pulls.json'))};\nconst s = JSON.parse(fs.readFileSync(f, 'utf8')); const r = s.replies[Math.min(s.calls, s.replies.length - 1)]; s.calls++; fs.writeFileSync(f, JSON.stringify(s));\nprocess.stdout.write(JSON.stringify(r));\n`, { mode: 0o755 });
  return bin;
}

function runStep({ gate, pr = { number: 9, draft: false, body: '', head: { sha: 'abc' } }, ghPulls } = {}) {
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
    env: { ...process.env, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, GHOSTY_DEV_GH: ghPulls ? fakePullsGh(dir, ghPulls) : '/nonexistent-gh', GHOSTY_DEV_MERGE_RETRY_MS: '0' },
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
  // Listo y cerrando un pendiente sin evidencia: ahora sí exige, en rojo (gh falso inexistente → truena → rojo).
  const ready = runStep({ gate: 'real', pr: { number: 9, draft: false, body: 'Closes #5', head: { sha: 'abc' } } });
  assert.equal(ready.code, 1);
  // Listo y fuera de la bitácora: rojo (falla cerrada) con el comando exacto.
  const loose = runStep({ gate: 'real' });
  assert.equal(loose.code, 1, loose.out);
  assert.match(loose.summary, /no cierra ningún pendiente: ghosty-dev claim --pr 9 --issue <n>/);
});

test('sin script en la base pasa con aviso; con script que no carga o truena, ROJO con el remedio (C22)', () => {
  const none = runStep();
  assert.equal(none.code, 0, none.out);
  assert.match(none.summary, /main no tiene \.github\/ghosty-dev\/gate\.mjs/);
  assert.match(none.out, /::notice title=ghosty-dev\/evidencia::/);
  const broken = runStep({ gate: "import './evidence.mjs';\nexport function main() {}\n" });
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.summary, /La puerta no carga su script \(ERR_MODULE_NOT_FOUND\)\. Arregla \.github\/ghosty-dev\/gate\.mjs en main; una persona puede mezclar a mano el PR que lo arregla\./);
  assert.match(broken.out, /::error title=evidencia::La puerta no carga su script/);
  const throws = runStep({ gate: 'export function main() { throw new Error("boom\\x1b[31m rojo"); }\n' });
  assert.equal(throws.code, 1, throws.out);
  assert.match(throws.summary, /La puerta tronó \(boom /);
  assert.doesNotMatch(throws.summary, /\x1b/);
});

test('un gate.mjs viejo (sin main exportado) se corre como antes, con su código de salida (C22)', () => {
  const old = `import { realpathSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nconst me = process.argv[1] ? realpathSync(process.argv[1]) : '';\nif (import.meta.url === pathToFileURL(me).href) { console.log('puerta vieja'); process.exit(1); }\n`;
  const r = runStep({ gate: old });
  assert.equal(r.code, 1);
  assert.match(r.out, /puerta vieja/);
});

test('PR en conflicto: la puerta falla con esa causa y el comando, sin correr gate.mjs; en borrador sólo avisa (C28)', () => {
  const pr = { number: 9, draft: false, body: 'Closes #1', head: { sha: 'abc', ref: 'ghosty-dev/1-x' }, mergeable: null };
  const dirty = runStep({ gate: 'export function main() { throw new Error("no debió correr"); }\n', pr, ghPulls: [{ mergeable: null }, { mergeable: false, mergeable_state: 'dirty', head: { ref: 'ghosty-dev/1-x' } }] });
  assert.equal(dirty.code, 1, dirty.out);
  assert.match(dirty.summary, /El PR está en conflicto con main: resuélvelo antes que nada .* git fetch origin && git switch ghosty-dev\/1-x && git merge origin\/main → resuelve/);
  assert.match(dirty.out, /::error title=evidencia::El PR está en conflicto/);
  assert.doesNotMatch(dirty.out + dirty.summary, /no debió correr/);
  const draft = runStep({ pr: { ...pr, draft: true, mergeable: false, mergeable_state: 'dirty' } });
  assert.equal(draft.code, 0, draft.out);
  assert.match(draft.out, /::notice title=evidencia::El PR está en conflicto/);
  const clean = runStep({ pr, ghPulls: [{ mergeable: true, mergeable_state: 'clean' }] });
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.summary, /main no tiene \.github\/ghosty-dev\/gate\.mjs/);
});
