// Lo que el repo declara para su deploy, en el frontmatter de `.ghosty/dev.md` (y si no, de `.ghosty/factory.md`):
//   deploy: ./scripts/deploy-fly.sh        el comando que despliega (corre en el clon local, en la rama base)
//   deploy_check: https://formmy.app/      opcional: URL que debe dar 200 después del deploy
// Y los marcadores que deja `ghosty-dev deploy` en la bitácora (gs los lee igual).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEPLOY_FILES = ['.ghosty/dev.md', '.ghosty/factory.md'];

function front(dir, file) {
  try {
    return readFileSync(join(dir, file), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  } catch {
    return '';
  }
}

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim();

function key(text, name) {
  const m = text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'));
  const v = m ? unquote(m[1].replace(/[ \t]+#.*$/, '')) : '';
  return v || null;
}

function httpUrl(v) {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// { deploy, deployCheck, source } (null si no se declaró). Cada llave cae a factory.md si dev.md no la tiene.
export function deployConfig(dir) {
  if (!dir) return { deploy: null, deployCheck: null, source: null };
  let deploy = null;
  let deployCheck = null;
  let source = null;
  for (const f of DEPLOY_FILES) {
    const t = front(dir, f);
    if (!deploy && key(t, 'deploy')) {
      deploy = key(t, 'deploy');
      source = f;
    }
    if (!deployCheck) deployCheck = httpUrl(key(t, 'deploy_check'));
  }
  return { deploy, deployCheck, source };
}

export const DEPLOY_HOWTO = 'declara el comando en el frontmatter de .ghosty/dev.md: «deploy: ./scripts/deploy.sh» (y, opcional, «deploy_check: https://tu-sitio/» que debe dar 200)';

// El marcador que lee gs: <!-- ghosty-dev:deploy ok sha=<sha> --> o … fail …
export const deployMarker = (ok, sha) => `<!-- ghosty-dev:deploy ${ok ? 'ok' : 'fail'} sha=${sha} -->`;
const MARKER = /<!-- ghosty-dev:deploy (ok|fail) sha=([0-9a-f]{7,64}) -->/;

// Puro: los marcadores en una lista de comentarios, del más viejo al más nuevo. [{ ok, sha, at }].
export function deployMarkers(comments = []) {
  const out = [];
  for (const c of comments) {
    const m = String(c?.body ?? '').match(MARKER);
    if (m) out.push({ ok: m[1] === 'ok', sha: m[2], at: c.created_at ?? c.createdAt ?? null });
  }
  return out;
}
