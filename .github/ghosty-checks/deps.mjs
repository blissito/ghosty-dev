#!/usr/bin/env node
// Revisión de dependencias nuevas de un PR (job `deps` de checks.yml).
// Uso: node deps.mjs <repo-dir> <base-dir> <merge-base> <head>
//   repo-dir = checkout de head; base-dir = worktree del merge-base (para osv-scanner).
// Bloquea si un paquete nuevo no existe en su registro o si aparece una CVE HIGH/CRITICAL nueva.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isDepsFile, depsOf, addedDeps, typosquatOf, installScripts, newSevereVulns, notApplicable } from './lib.mjs';

const [repo, baseDir, mergeBase, head] = process.argv.slice(2);
const TITLE = 'Dependencias';
const summary = (md) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n') : console.log(md));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const show = (rev, path) => { try { return git('show', `${rev}:${path}`); } catch { return ''; } };
const DAY = 86400000;

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ghosty-checks' } });
      if (r.status === 404) return { missing: true };
      if (r.ok) return { data: await r.json() };
    } catch {}
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  return { error: true };
}

function lockVersion(path, name) {
  const lock = join(repo, dirname(path), 'package-lock.json');
  if (!existsSync(lock)) return null;
  try { return JSON.parse(readFileSync(lock, 'utf8')).packages?.[`node_modules/${name}`]?.version ?? null; } catch { return null; }
}

async function checkNpm(dep, path) {
  const res = { ...dep, ecosystem: 'npm', block: [], warn: [] };
  const doc = await getJson(`https://registry.npmjs.org/${dep.name.replace('/', '%2F')}`);
  if (doc.missing) { res.block.push('no existe en npm (¿nombre inventado o mal escrito?)'); return res; }
  if (doc.error) { res.warn.push('no pude consultar npm'); return res; }
  const d = doc.data;
  const created = Date.parse(d.time?.created ?? '');
  if (Number.isFinite(created)) {
    res.ageDays = Math.floor((Date.now() - created) / DAY);
    if (res.ageDays < 30) res.warn.push(`publicado hace ${res.ageDays} días`);
  }
  const version = lockVersion(path, dep.name) ?? d['dist-tags']?.latest;
  const manifest = d.versions?.[version];
  res.version = version;
  const scripts = installScripts(manifest);
  if (scripts.length) res.warn.push(`corre scripts al instalar: ${scripts.join(', ')}`);
  if (manifest?.deprecated) res.warn.push(`deprecado: ${String(manifest.deprecated).slice(0, 120)}`);
  const dl = await getJson(`https://api.npmjs.org/downloads/point/last-week/${dep.name}`);
  if (dl.data && typeof dl.data.downloads === 'number') {
    res.weekly = dl.data.downloads;
    if (res.weekly < 100) res.warn.push(`sólo ${res.weekly} descargas en la última semana`);
  }
  return res;
}

async function checkPypi(dep) {
  const res = { ...dep, ecosystem: 'pypi', block: [], warn: [] };
  const doc = await getJson(`https://pypi.org/pypi/${dep.name}/json`);
  if (doc.missing) { res.block.push('no existe en PyPI (¿nombre inventado o mal escrito?)'); return res; }
  if (doc.error) { res.warn.push('no pude consultar PyPI'); return res; }
  const d = doc.data;
  const times = Object.values(d.releases ?? {}).flat().map((f) => Date.parse(f.upload_time_iso_8601 ?? f.upload_time)).filter(Number.isFinite);
  if (times.length) {
    res.ageDays = Math.floor((Date.now() - Math.min(...times)) / DAY);
    if (res.ageDays < 30) res.warn.push(`publicado hace ${res.ageDays} días`);
  }
  res.version = d.info?.version;
  const files = d.urls ?? [];
  if (files.length && files.every((f) => f.packagetype === 'sdist')) res.warn.push('sólo trae sdist: ejecuta código (setup.py) al instalar');
  const st = await getJson(`https://pypistats.org/api/packages/${dep.name}/recent`);
  if (st.data?.data && typeof st.data.data.last_week === 'number') {
    res.weekly = st.data.data.last_week;
    if (res.weekly < 100) res.warn.push(`sólo ${res.weekly} descargas en la última semana`);
  }
  return res;
}

function osv(dir) {
  // osv-scanner sale con 1 si hay vulnerabilidades y con 128 si no encontró paquetes: sólo importa el JSON.
  const r = spawnSync('osv-scanner', ['scan', 'source', '-r', '--format', 'json', dir], { encoding: 'utf8', maxBuffer: 256 << 20 });
  try { return JSON.parse(r.stdout); } catch { return { results: [], failed: r.stderr?.slice(-500) || r.error?.message || 'sin salida' }; }
}

const changed = git('diff', '--name-only', mergeBase, head).split('\n').filter(Boolean).filter(isDepsFile);
if (!changed.length) {
  summary(notApplicable(TITLE, 'el PR no toca manifiestos ni lockfiles'));
  process.exit(0);
}

const fresh = [];
for (const path of changed) {
  const before = depsOf(path, show(mergeBase, path));
  const after = depsOf(path, show(head, path));
  if (!after) continue;
  for (const dep of addedDeps(before?.deps ?? [], after.deps)) fresh.push({ ...dep, path, ecosystem: after.ecosystem });
}

const results = [];
for (const dep of fresh) {
  if (!dep.registry) { results.push({ ...dep, block: [], warn: [`no viene del registro (${dep.spec})`] }); continue; }
  const r = dep.ecosystem === 'npm' ? await checkNpm(dep, dep.path) : await checkPypi(dep);
  const twin = typosquatOf(dep.name, dep.ecosystem);
  if (twin) r.warn.push(`se parece a «${twin}» (¿typosquat?)`);
  results.push(r);
}

const baseScan = osv(baseDir);
const headScan = osv(repo);
const vulns = newSevereVulns(baseScan, headScan);

const blocked = results.filter((r) => r.block.length);
let md = `### ${TITLE}\n\n`;
if (results.length) {
  md += `Paquetes nuevos: ${results.length}\n\n| Paquete | Registro | Versión | Edad | Descargas/semana | Resultado |\n|---|---|---|---|---|---|\n`;
  for (const r of results) {
    const verdict = r.block.length ? `❌ ${r.block.join('; ')}` : r.warn.length ? `⚠️ ${r.warn.join('; ')}` : '✅';
    md += `| \`${r.name}\` (${r.path}) | ${r.ecosystem} | ${r.version ?? '—'} | ${r.ageDays != null ? `${r.ageDays} d` : '—'} | ${r.weekly ?? '—'} | ${verdict} |\n`;
  }
} else md += 'Sin paquetes directos nuevos.\n';
md += '\n**Vulnerabilidades (OSV-Scanner):** ';
if (headScan.failed) md += `no se pudo escanear: ${headScan.failed}\n`;
else if (!vulns.length) md += 'ninguna HIGH/CRITICAL nueva.\n';
else {
  md += `${vulns.length} HIGH/CRITICAL nueva(s)\n\n| Paquete | Versión | Severidad | Ids |\n|---|---|---|---|\n`;
  for (const v of vulns) md += `| \`${v.pkg}\` | ${v.version} | ${v.level} | ${v.ids.join(', ')} |\n`;
}
summary(md);

for (const r of blocked) console.log(`::error title=Dependencia::${r.name}: ${r.block.join('; ')}`);
for (const r of results.filter((x) => !x.block.length && x.warn.length)) console.log(`::warning title=Dependencia::${r.name}: ${r.warn.join('; ')}`);
for (const v of vulns) console.log(`::error title=Vulnerabilidad ${v.level}::${v.pkg}@${v.version}: ${v.ids.join(', ')}`);
process.exit(blocked.length || vulns.length ? 1 : 0);
