// Referencias a pendientes y PR con el patrón de GitHub: `n`, `#n` y `owner/repo#n` (también la URL del issue o PR).
// Sin repo explícito la referencia es la del directorio actual (compatibilidad con todo lo anterior).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export class UserError extends Error {}

const REPO_RE = '[A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+';
const FULL = new RegExp(`^(${REPO_RE})#(\\d+)$`);
const URL_REF = new RegExp(`^https?:\\/\\/github\\.com\\/(${REPO_RE})\\/(?:issues|pull)\\/(\\d+)\\/?$`);

/** `94` | `#94` | `owner/repo#94` | URL de GitHub → { repo: 'owner/repo' | null, n }. Inválido: UserError con `what`. */
export function parseRef(v, what = '<n>') {
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(FULL)) || (m = s.match(URL_REF))) return { repo: m[1], n: Number(m[2]) };
  if ((m = s.match(/^#?(\d+)$/)) && Number(m[1]) > 0) return { repo: null, n: Number(m[1]) };
  throw new UserError(`Falta el número del pendiente ${what} (acepto 94, #94 u owner/repo#94).`);
}

/** ¿Parece una referencia con repo explícito? (para decidir si hay que cambiar de repo antes de ejecutar). */
export const hasRepo = (v) => {
  const s = String(v ?? '').trim();
  return FULL.test(s) || URL_REF.test(s);
};

export const sameRepo = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
export const fmtRef = (repo, n) => (repo ? `${repo}#${n}` : `#${n}`);
/** Texto de una referencia vista desde `home`: local («#n») si es del mismo repo, completa si no. */
export const refText = (r, home = null) => {
  const x = typeof r === 'object' && r !== null ? r : { repo: null, n: r };
  return x.repo && !sameRepo(x.repo, home) ? `${x.repo}#${x.n}` : `#${x.n}`;
};

/** «owner/repo» de una URL de remoto (https o ssh), o null. */
export function repoOfRemote(url = '') {
  const m = String(url).trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
}

/** «owner/repo» del directorio, leído del remoto git (sin red); null si no es un clon de GitHub. */
export function repoOfDir(dir = process.cwd()) {
  for (const remote of ['origin', 'upstream']) {
    try {
      const url = execFileSync('git', ['config', '--get', `remote.${remote}.url`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const r = repoOfRemote(url);
      if (r) return r;
    } catch {}
  }
  return null;
}

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Downloads', 'Movies', 'Music', 'Pictures', 'Desktop', 'Public']);
const dirs = (d) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => join(d, e.name));
  } catch {
    return [];
  }
};
const isClone = (d) => {
  try {
    return statSync(join(d, '.git')).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Ubica el checkout local de `repo`: el directorio actual (o su raíz), y luego ~/ y las carpetas de GHOSTY_DEV_REPOS
 * (separadas por «:») a uno y dos niveles. Prefiere un clon con .git de verdad (no un worktree). null si no hay.
 */
export function findCheckout(repo, { cwd = process.cwd(), roots } = {}) {
  if (!repo) return null;
  if (sameRepo(repoOfDir(cwd), repo)) return cwd;
  const bases = roots ?? [...(process.env.GHOSTY_DEV_REPOS ?? '').split(delimiter).filter(Boolean), homedir()];
  const wanted = repo.split('/')[1].toLowerCase();
  const seen = new Set();
  const candidates = [];
  for (const base of bases) {
    for (const d1 of [base, ...dirs(base)]) {
      for (const d of d1 === base ? [] : [d1, ...dirs(d1)]) {
        if (seen.has(d)) continue;
        seen.add(d);
        candidates.push(d);
      }
    }
  }
  // Primero los nombres que se parecen al repo (barato), luego el resto.
  candidates.sort((a, b) => Number(b.toLowerCase().includes(wanted)) - Number(a.toLowerCase().includes(wanted)));
  for (const d of candidates) if (isClone(d) && sameRepo(repoOfDir(d), repo)) return d;
  return null;
}

export const cloneCommand = (repo) => `gh repo clone ${repo} ~/${repo.split('/')[1]}`;

// Prefijos «gs:», «formmy:»… que un título usa para decir de qué repo es. Los alias fijos cubren los repos de la casa;
// el resto se deduce del nombre de un repo hermano (mismo dueño) cuando coincide exacto.
const ALIASES = { gs: 'blissito/ghosty-studio', 'ghosty-studio': 'blissito/ghosty-studio', formmy: 'blissito/formmy', easybits: 'blissito/easybits', mailmask: 'blissito/mailmask', teams: 'blissito/ghosty-chat', 'ghosty-dev': 'blissito/ghosty-dev' };
const NOT_REPO = new Set(['feat', 'fix', 'docs', 'chore', 'test', 'tests', 'refactor', 'perf', 'build', 'ci', 'style', 'wip', 'bug', 'todo', 'nota', 'idea', 'ux', 'ui', 'api']);

/**
 * ¿El pendiente parece de OTRO repo? Mira el prefijo del título («gs: …») y las menciones `owner/repo` (o URL de GitHub)
 * del mismo dueño en el cuerpo. Devuelve el repo sospechoso o null. Nunca bloquea: sólo avisa.
 */
export function suspectRepo({ title = '', body = '' }, home) {
  if (!home) return null;
  const name = home.split('/')[1].toLowerCase();
  const owner = home.split('/')[0];
  const pm = String(title).match(/^\s*([A-Za-z][\w.-]*)\s*:\s/);
  if (pm) {
    const p = pm[1].toLowerCase();
    if (!NOT_REPO.has(p) && p !== name) {
      const target = ALIASES[p];
      if (target && !sameRepo(target, home)) return target;
      if (!target && p.length > 2 && ![...Object.keys(ALIASES)].includes(p)) {
        // Prefijo que no conocemos: sólo cuenta si el cuerpo también menciona un repo del mismo dueño con ese nombre.
        const m = String(body).match(new RegExp(`\\b(${owner}/${p}[\\w.-]*)`, 'i'));
        if (m && !sameRepo(m[1], home)) return m[1];
      }
    }
  }
  const mention = [...String(body).matchAll(new RegExp(`(?:github\\.com/|(?<![\\w/.-]))(${owner}/[A-Za-z0-9._-]+)`, 'gi'))].map((x) => x[1].replace(/\.$/, '')).find((r) => !sameRepo(r, home));
  return mention ?? null;
}

