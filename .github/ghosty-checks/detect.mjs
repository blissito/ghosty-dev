#!/usr/bin/env node
// Detección y medidas para los jobs informativos (bundle y coverage) y el contrato OpenAPI.
// Uso:
//   node detect.mjs node <repo-dir> <input-version>      → node-version (input, .nvmrc o 22)
//   node detect.mjs bundle <repo-dir>                    → applies, install, build
//   node detect.mjs outdir <repo-dir>                    → dir (la carpeta de salida que exista)
//   node detect.mjs size <path>                          → bytes
//   node detect.mjs bundle-report <base> <head> <dir>    → resumen en el step summary
//   node detect.mjs coverage <repo-dir>                  → applies, install, cmd
//   node detect.mjs openapi <repo-dir> <merge-base> <head> → specs (lista separada por espacios)
// Las salidas van a $GITHUB_OUTPUT como clave=valor.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { packageManager, BUILD_DIRS, dirSize, bundleVerdict, humanBytes, coverageCommand, openapiCandidates } from './lib.mjs';

const [cmd, ...a] = process.argv.slice(2);
const out = (k, v) => (process.env.GITHUB_OUTPUT ? appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`) : console.log(`${k}=${v}`));
const summary = (md) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n') : console.log(md));
const readPkg = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return null; } };
const firstText = (dir, names) => { for (const n of names) if (existsSync(join(dir, n))) return readFileSync(join(dir, n), 'utf8'); return ''; };

if (cmd === 'node') {
  const [dir, input] = a;
  const nvmrc = existsSync(join(dir, '.nvmrc')) ? readFileSync(join(dir, '.nvmrc'), 'utf8').trim().replace(/^v/, '') : '';
  out('version', input || nvmrc || '22');
} else if (cmd === 'bundle') {
  const [dir] = a;
  const pkg = readPkg(dir);
  const pm = packageManager(dir);
  const ok = Boolean(pkg?.scripts?.build && pm);
  out('applies', ok ? 'true' : 'false');
  if (ok) { out('pm', pm.pm); out('install', pm.install); out('build', pm.run('build')); }
} else if (cmd === 'outdir') {
  const dir = BUILD_DIRS.find((d) => existsSync(join(a[0], d))) ?? '';
  out('dir', dir);
} else if (cmd === 'size') {
  console.log(dirSize(a[0]) ?? '');
} else if (cmd === 'bundle-report') {
  const [base, headSize, dir] = a;
  const b = base === '' ? null : Number(base);
  const h = headSize === '' ? null : Number(headSize);
  const v = bundleVerdict(b, h);
  let md = `### Tamaño del bundle\n\nCarpeta: \`${dir || '—'}\`\n\n| Base | PR | Cambio |\n|---|---|---|\n| ${humanBytes(b)} | ${humanBytes(h)} | ${v.delta == null ? '—' : `${v.delta >= 0 ? '+' : ''}${humanBytes(v.delta)}${v.pct != null ? ` (${v.pct >= 0 ? '+' : ''}${(v.pct * 100).toFixed(1)} %)` : ''}`} |\n`;
  if (h == null) md += '\n⚠️ No se pudo construir el PR (¿faltan variables de entorno para el build?).\n';
  else if (b == null) md += '\nNo se pudo construir la base: sin comparación.\n';
  if (v.warn) { md += '\n⚠️ El bundle crece más de 20 %.\n'; console.log(`::warning title=Bundle::crece ${(v.pct * 100).toFixed(1)} % (${humanBytes(v.delta)})`); }
  md += '\n_Informativo: este check nunca bloquea._\n';
  summary(md);
} else if (cmd === 'coverage') {
  const [dir] = a;
  const pkg = readPkg(dir);
  const pm = packageManager(dir);
  const c = pm && coverageCommand(pkg, {
    vitestConfig: firstText(dir, ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js', 'vite.config.mts']),
    jestConfig: firstText(dir, ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs']),
  });
  out('applies', c ? 'true' : 'false');
  if (c) { out('pm', pm.pm); out('install', pm.install); out('cmd', c.kind === 'script' ? pm.run(c.script) : c.cmd); }
} else if (cmd === 'openapi') {
  const [dir, mergeBase, head] = a;
  const changed = new Set(execFileSync('git', ['-C', dir, 'diff', '--name-only', mergeBase, head], { encoding: 'utf8' }).split('\n'));
  out('specs', openapiCandidates().filter((p) => changed.has(p) && existsSync(join(dir, p))).join(' '));
} else if (cmd === 'semgrep-report') {
  // Resumen del JSON de semgrep; sale con 1 si hay hallazgos ERROR nuevos.
  let d = {};
  try { d = JSON.parse(readFileSync(a[0], 'utf8')); } catch {}
  const errs = (d.results ?? []).filter((r) => r.extra?.severity === 'ERROR');
  let md = '### Análisis estático (Semgrep)\n\nReglas `p/default`, sólo lo que introduce este PR.\n\n';
  if (!d.results) md += `⚠️ Semgrep no terminó: ${(d.errors ?? []).map((e) => e.message).join('; ').slice(0, 300) || 'sin salida'}\n`;
  else if (!errs.length) md += '✅ Sin hallazgos ERROR nuevos.\n';
  else {
    md += `❌ **${errs.length} hallazgo(s) ERROR:**\n\n| Dónde | Regla | Qué pasa |\n|---|---|---|\n`;
    for (const r of errs) {
      md += `| \`${r.path}:${r.start?.line}\` | \`${r.check_id.split('.').slice(-1)[0]}\` | ${String(r.extra?.message ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 300)} |\n`;
      console.log(`::error file=${r.path},line=${r.start?.line},title=Semgrep ${r.check_id.split('.').slice(-1)[0]}::${String(r.extra?.message ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  summary(md);
  // Si semgrep no terminó se falla a la vista: un verde sin escanear sería mentira.
  process.exit(errs.length || !d.results ? 1 : 0);
} else {
  console.error(`comando desconocido: ${cmd}`);
  process.exit(2);
}
