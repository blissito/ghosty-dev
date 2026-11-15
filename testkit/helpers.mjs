// Arma un repo temporal con git real y un gh falso (sin red) para probar el CLI de punta a punta.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'ghosty-dev.mjs');
const FAKE = join(HERE, 'fake-gh.mjs');
chmodSync(FAKE, 0o755);

export const VALID_EVIDENCE = `## Qué se hizo
Agregué el endpoint /health.

## Verificación
\`\`\`
$ npm test
ok 3 - health responde 200
\`\`\`

## CI
✅ passed — https://github.com/acme/demo/actions/runs/1

## Preview
no aplica

## Criterios de aceptación
- [x] /health responde 200
`;

export function issue(number, title, { labels = ['ghosty-dev:listo'], body = '', assignees = [], state = 'open' } = {}) {
  return { number, id: 1000 + number, title, labels, body, assignees, state, comments: [], blockedBy: [] };
}

export function setup(state = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ghosty-dev-'));
  const repo = join(root, 'demo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const stateFile = join(root, 'gh.json');
  const db = { me: 'agente-a', repo: 'acme/demo', depsApi: true, labels: [], issues: {}, prs: [], runs: [], calls: [], ...state };
  writeFileSync(stateFile, JSON.stringify(db));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GHOSTY_DEV_GH: FAKE, FAKE_GH_STATE: stateFile, GHOSTY_DEV_NO_OPEN: '1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const write = (name, text) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };
  return { root, repo, run, read, write };
}
