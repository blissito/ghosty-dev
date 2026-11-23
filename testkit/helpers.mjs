// Arma un repo temporal con git real y un gh falso (sin red) para probar el CLI de punta a punta.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

## Flujo principal probado con sesión
Entré con la identidad de Ghosty y pedí /health con la cookie de sesión:
\`\`\`
$ curl -s -b sesion.txt https://preview.example/health
{"ok":true}
\`\`\`

## Criterios de aceptación
- [x] /health responde 200
`;

export function issue(number, title, { labels = ['ghosty-dev:por-hacer'], body = '', assignees = [], state = 'open' } = {}) {
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
  const env = { ...process.env, GHOSTY_DEV_GH: FAKE, FAKE_GH_STATE: stateFile, GHOSTY_DEV_NO_OPEN: '1', GHOSTY_DEV_SKIP_READINESS: '1', GHOSTY_DEV_REGISTER_WAIT_MS: '0', GHOSTY_DEV_WATCH_MS: '0', GHOSTY_DEV_MERGE_RETRY_MS: '0', XDG_CONFIG_HOME: join(root, 'config') };
  delete env.GHOSTY_DEV_TOKEN;
  delete env.GHOSTY_DEV_BASE_URL;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  // Igual que run, pero sin bloquear el proceso de la prueba (para hablar con un servidor falso en el mismo proceso).
  // `onLine` recibe cada renglón de stdout en cuanto llega; `extra` agrega o quita (undefined) variables de entorno.
  const runAsync = (args, { extra = {}, onLine } = {}) =>
    new Promise((done) => {
      const e = { ...env, ...extra };
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
      const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let pending = '';
      child.stdout.on('data', (c) => {
        out += c;
        pending += c;
        let i;
        while ((i = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          onLine?.(line);
        }
      });
      child.stderr.on('data', (c) => (err += c));
      child.stdin.end();
      child.on('close', (code) => done({ code, out, err }));
    });
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const write = (name, text) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };
  return { root, repo, run, runAsync, read, write, config: join(root, 'config') };
}

export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const revisionMd = (open = 0) => `## Revisión
Revisó: ghosty-dev-revisor, otra sesión con contexto limpio.

\`\`\`sh
$ node --test test/revision-3.test.js
ok 1 - URL mal formada responde 400
# pass 1
\`\`\`

- [x] URL mal formada no tumba el proceso
${open ? '- [ ] cuerpo enorme tumba el proceso (server.js:12)\n' : ''}
Hallazgos abiertos: ${open}
`;
