// Piezas puras de las revisiones de Ghosty (workflow reutilizable checks.yml).
// Sin red ni git: todo lo que se prueba con node --test vive aquí.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// ---------- dependencias ----------

export const MANIFESTS = ['package.json', 'pyproject.toml'];
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock'];

/** ¿Este archivo cambiado es de dependencias? */
export function isDepsFile(path) {
  if (/(^|\/)node_modules\//.test(path)) return false;
  const name = basename(path);
  return MANIFESTS.includes(name) || LOCKFILES.includes(name) || /^requirements.*\.txt$/.test(name);
}

const NPM_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Especificaciones que no salen del registro: no hay nada que consultar. */
const NOT_REGISTRY = /^(workspace:|file:|link:|portal:|patch:|git(\+|:)|https?:|github:|gitlab:|bitbucket:)|^[\w.-]+\/[\w.-]+(#.*)?$/;

/** Dependencias de un package.json: [{ name, spec, registry }]. `npm:` resuelve el alias. */
export function npmDeps(text) {
  let pkg;
  try { pkg = JSON.parse(text || '{}'); } catch { return []; }
  const out = new Map();
  for (const field of NPM_FIELDS) {
    for (const [alias, spec] of Object.entries(pkg?.[field] ?? {})) {
      const s = String(spec);
      let name = alias;
      if (s.startsWith('npm:')) {
        const real = s.slice(4);
        const at = real.lastIndexOf('@');
        name = at > 0 ? real.slice(0, at) : real;
      }
      out.set(name, { name, spec: s, registry: !NOT_REGISTRY.test(s) });
    }
  }
  return [...out.values()];
}

/** Nombre normalizado de PyPI (PEP 503). */
export const pyName = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

/** Dependencias de un requirements.txt. */
export function requirementsDeps(text) {
  const out = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || /^[a-z+]+:\/\//i.test(line) || line.includes(' @ ')) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) out.set(pyName(m[1]), { name: pyName(m[1]), spec: line, registry: true });
  }
  return [...out.values()];
}

/** Dependencias de un pyproject.toml ([project] dependencies y [tool.poetry.*dependencies]). Lectura simple, sin parser TOML. */
export function pyprojectDeps(text) {
  const out = new Map();
  const add = (n, spec) => { const k = pyName(n); if (k !== 'python') out.set(k, { name: k, spec, registry: true }); };
  let section = '';
  let collecting = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header && !collecting) { section = header[1].trim(); continue; }
    // Arreglos de cadenas: [project] dependencies, [project.optional-dependencies] y [dependency-groups].
    const arraySection = section === 'project' ? /^\s*dependencies\s*=\s*\[/ : /^(project\.optional-dependencies|dependency-groups)$/.test(section) ? /^\s*[\w-]+\s*=\s*\[/ : null;
    let body = null;
    if (collecting) body = line;
    else if (arraySection && arraySection.test(line)) { collecting = true; body = line.slice(line.indexOf('[') + 1); }
    if (body != null) {
      for (const s of body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)[^"']*["']/g)) add(s[1], s[0].slice(1, -1));
      if (body.includes(']')) collecting = false;
      continue;
    }
    // Tablas de poetry: nombre = "versión" o nombre = { ... }
    if (/^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies$/.test(section)) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m) add(m[1], line.trim());
    }
  }
  return [...out.values()];
}

/** Lo que hay en `head` y no en `base` (por nombre). */
export function addedDeps(baseList, headList) {
  const before = new Set(baseList.map((d) => d.name));
  return headList.filter((d) => !before.has(d.name));
}

export function depsOf(path, text) {
  const name = basename(path);
  if (name === 'package.json') return { ecosystem: 'npm', deps: npmDeps(text) };
  if (name === 'pyproject.toml') return { ecosystem: 'pypi', deps: pyprojectDeps(text) };
  if (/^requirements.*\.txt$/.test(name)) return { ecosystem: 'pypi', deps: requirementsDeps(text) };
  return null;
}

/** Distancia de Levenshtein. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Paquetes muy descargados: un nombre a 1–2 letras de uno de estos es sospechoso.
export const POPULAR = {
  npm: `react react-dom next vue svelte angular express koa fastify hono lodash underscore axios node-fetch got request
chalk commander yargs debug dotenv uuid moment dayjs date-fns luxon zod yup joi ajv typescript ts-node tsx esbuild
vite webpack rollup parcel babel-core @babel/core eslint prettier jest vitest mocha chai sinon supertest playwright
puppeteer cypress tailwindcss postcss autoprefixer sass less styled-components @emotion/react classnames clsx
prisma @prisma/client mongoose sequelize typeorm knex pg mysql mysql2 sqlite3 better-sqlite3 redis ioredis
socket.io ws cors helmet morgan body-parser cookie-parser jsonwebtoken bcrypt bcryptjs passport nodemailer
multer sharp jimp cheerio jsdom marked markdown-it highlight.js rxjs immer redux @reduxjs/toolkit zustand
mobx jotai swr @tanstack/react-query react-router react-router-dom @remix-run/react framer-motion three
d3 chart.js recharts lodash-es ramda async bluebird glob minimatch rimraf mkdirp fs-extra cross-env
concurrently nodemon pm2 semver yaml js-yaml qs query-string form-data formidable busboy mime mime-types
colors kleur picocolors ora inquirer prompts boxen figlet node-cron cron uuidv4 nanoid shortid validator
xml2js fast-xml-parser csv-parse papaparse xlsx pdfkit jspdf openai @anthropic-ai/sdk ai langchain stripe
aws-sdk @aws-sdk/client-s3 firebase firebase-admin @supabase/supabase-js graphql apollo-server @apollo/client
left-pad is-odd is-even event-stream flatmap-stream coffee-script electron`.split(/\s+/),
  pypi: `requests urllib3 numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch keras flask django
fastapi uvicorn gunicorn starlette pydantic sqlalchemy alembic psycopg2 psycopg2-binary pymysql redis celery
boto3 botocore awscli pyyaml jinja2 click typer rich colorama tqdm pillow opencv-python beautifulsoup4 lxml
selenium playwright pytest pytest-cov coverage black flake8 pylint mypy isort ruff httpx aiohttp websockets
cryptography pyjwt bcrypt paramiko openai anthropic langchain transformers huggingface-hub python-dotenv
setuptools wheel pip six attrs certifi idna charset-normalizer packaging python-dateutil pytz simplejson
ujson orjson marshmallow werkzeug itsdangerous markupsafe docker kubernetes google-cloud-storage
google-api-python-client stripe twilio sentry-sdk loguru arrow pendulum networkx sympy jupyter notebook
ipython streamlit gradio dash plotly bokeh polars pyarrow`.split(/\s+/),
};

/** Si `name` se parece demasiado a un paquete popular (y no lo es), regresa a cuál. */
export function typosquatOf(name, ecosystem) {
  const list = POPULAR[ecosystem] ?? [];
  const norm = ecosystem === 'pypi' ? pyName(name) : name.toLowerCase();
  if (list.includes(norm)) return null;
  const bare = norm.replace(/^@[^/]+\//, '');
  for (const p of list) {
    const pb = p.replace(/^@[^/]+\//, '');
    const max = pb.length >= 6 ? 2 : 1;
    for (const [x, y] of [[norm, p], [bare, pb]]) {
      const d = levenshtein(x, y);
      if (d > 0 && d <= max) return p;
    }
    // Mismo nombre con separadores distintos: left_pad / leftpad contra left-pad.
    if (bare.replace(/[-_.]/g, '') === pb.replace(/[-_.]/g, '') && bare !== pb) return p;
  }
  return null;
}

/** Scripts que npm corre solo al instalar. */
export function installScripts(manifest) {
  const s = manifest?.scripts ?? {};
  const found = ['preinstall', 'install', 'postinstall'].filter((k) => typeof s[k] === 'string' && s[k].trim());
  if (manifest?.gypfile && !found.includes('install')) found.push('install (node-gyp)');
  return found;
}

/** Severidad CVSS (texto de osv-scanner) → nivel. */
export function severityLevel(score) {
  const n = Number.parseFloat(score);
  if (!Number.isFinite(n)) return 'UNKNOWN';
  if (n >= 9) return 'CRITICAL';
  if (n >= 7) return 'HIGH';
  if (n >= 4) return 'MEDIUM';
  return n > 0 ? 'LOW' : 'UNKNOWN';
}

/** Vulnerabilidades del JSON de osv-scanner: [{ pkg, version, ids, level, source }]. */
export function osvFindings(json) {
  const out = [];
  for (const r of json?.results ?? []) {
    for (const p of r.packages ?? []) {
      for (const g of p.groups ?? []) {
        out.push({
          pkg: p.package?.name,
          version: p.package?.version,
          ids: g.ids ?? [],
          aliases: g.aliases ?? g.ids ?? [],
          level: severityLevel(g.max_severity),
          source: r.source?.path,
        });
      }
    }
  }
  return out;
}

/** Las HIGH/CRITICAL de head que no estaban en base (se compara por cualquier id o alias). */
export function newSevereVulns(baseJson, headJson) {
  const seen = new Set(osvFindings(baseJson).flatMap((f) => [...f.ids, ...f.aliases].map((id) => `${f.pkg}|${id}`)));
  return osvFindings(headJson).filter(
    (f) => (f.level === 'HIGH' || f.level === 'CRITICAL') && ![...f.ids, ...f.aliases].some((id) => seen.has(`${f.pkg}|${id}`)),
  );
}

// ---------- migraciones ----------

export const MIGRATION_DIR = /(^|\/)(prisma\/migrations|migrations|migrate|db\/migrate|drizzle|supabase\/migrations)\//;

export function isMigrationSql(path) {
  return path.endsWith('.sql') && MIGRATION_DIR.test(path);
}

/** Reglas de estilo que no hacen peligrosa una migración: se excluyen salvo que el repo traiga su .squawk.toml. */
export const SQUAWK_STYLE_RULES = [
  'prefer-robust-stmts', 'prefer-bigint-over-int', 'prefer-bigint-over-smallint', 'prefer-identity',
  'prefer-text-field', 'prefer-timestamptz', 'require-lock-timeout', 'require-statement-timeout',
];
/** Se reportan pero no bloquean (Prisma y la mayoría de ORMs no crean índices CONCURRENTLY). */
export const SQUAWK_SOFT_RULES = ['require-concurrent-index-creation', 'syntax-error'];

/**
 * ¿En qué dialecto está esta migración? squawk sólo entiende Postgres.
 * Busca hacia arriba un migration_lock.toml de Prisma o el _journal.json de drizzle.
 */
export function migrationDialect(root, path) {
  let dir = dirname(path);
  while (dir && dir !== '.' && dir !== '/') {
    const lock = join(root, dir, 'migration_lock.toml');
    if (existsSync(lock)) {
      const m = readFileSync(lock, 'utf8').match(/provider\s*=\s*"([^"]+)"/);
      if (m) return m[1] === 'postgresql' || m[1] === 'postgres' ? 'postgres' : m[1];
    }
    const journal = join(root, dir, 'meta', '_journal.json');
    if (existsSync(journal)) {
      try {
        const d = JSON.parse(readFileSync(journal, 'utf8')).dialect;
        if (d) return /^postgres/.test(d) ? 'postgres' : d;
      } catch {}
    }
    dir = dirname(dir);
  }
  return 'postgres';
}

/** Hallazgos del reporter json de squawk → { blocking, soft }. */
export function squawkVerdict(items) {
  const blocking = [];
  const soft = [];
  for (const it of items ?? []) (SQUAWK_SOFT_RULES.includes(it.rule_name) ? soft : blocking).push(it);
  return { blocking, soft };
}

// ---------- contrato OpenAPI ----------

export const OPENAPI_DIRS = ['', 'public/', 'docs/', 'api/'];
export const OPENAPI_NAMES = ['openapi.yaml', 'openapi.yml', 'openapi.json'];
export const openapiCandidates = () => OPENAPI_DIRS.flatMap((d) => OPENAPI_NAMES.map((n) => d + n));

// ---------- bundle y cobertura ----------

export function packageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return { pm: 'pnpm', install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm run ${s}` };
  if (existsSync(join(root, 'yarn.lock'))) {
    const berry = existsSync(join(root, '.yarnrc.yml'));
    return { pm: 'yarn', install: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile', run: (s) => `yarn run ${s}` };
  }
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json'))) return { pm: 'npm', install: 'npm ci', run: (s) => `npm run ${s}` };
  if (existsSync(join(root, 'package.json'))) return { pm: 'npm', install: 'npm install --no-audit --no-fund', run: (s) => `npm run ${s}` };
  return null;
}

export const BUILD_DIRS = ['build', 'dist', '.next', 'out', 'public/build', '.output'];

/** Bytes de una carpeta, sin cachés de compilación. */
export function dirSize(path) {
  if (!existsSync(path)) return null;
  let total = 0;
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      const name = basename(p);
      if (name === 'node_modules' || (name === 'cache' && basename(dirname(p)) === '.next')) return;
      for (const e of readdirSync(p)) walk(join(p, e));
    } else total += st.size;
  };
  walk(path);
  return total;
}

export function bundleVerdict(baseBytes, headBytes, limit = 0.2) {
  if (baseBytes == null || headBytes == null) return { delta: null, pct: null, warn: false };
  const delta = headBytes - baseBytes;
  const pct = baseBytes > 0 ? delta / baseBytes : null;
  return { delta, pct, warn: pct != null && pct > limit };
}

export function humanBytes(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  const s = a >= 1048576 ? `${(a / 1048576).toFixed(2)} MB` : a >= 1024 ? `${(a / 1024).toFixed(1)} KB` : `${a} B`;
  return n < 0 ? `-${s}` : s;
}

/** ¿Cómo se saca la cobertura de este repo? null = no la genera (no aplica). */
export function coverageCommand(pkg, files = {}) {
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (scripts['test:coverage']) return { kind: 'script', script: 'test:coverage' };
  if (scripts.coverage) return { kind: 'script', script: 'coverage' };
  if (deps.vitest && /coverage/.test(files.vitestConfig ?? '')) return { kind: 'vitest', cmd: 'npx vitest run --coverage --coverage.reporter=lcov' };
  if (deps.jest && (/collectCoverage\s*:\s*true/.test(files.jestConfig ?? '') || pkg?.jest?.collectCoverage === true))
    return { kind: 'jest', cmd: 'npx jest --coverage --coverageReporters=lcov' };
  return null;
}

// ---------- resumen ----------

export function notApplicable(title, why) {
  return `### ${title}\n\nNo aplica: ${why}.\n`;
}
