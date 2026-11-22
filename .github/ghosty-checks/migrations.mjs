#!/usr/bin/env node
// Migraciones peligrosas (job `migrations` de checks.yml) con squawk.
// Uso: node migrations.mjs <repo-dir> <merge-base> <head>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMigrationSql, migrationDialect, squawkVerdict, SQUAWK_STYLE_RULES, notApplicable } from './lib.mjs';

const [repo, mergeBase, head] = process.argv.slice(2);
const TITLE = 'Migraciones';
const summary = (md) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n') : console.log(md));

const changed = execFileSync('git', ['-C', repo, 'diff', '--name-only', '--diff-filter=AMR', mergeBase, head], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(isMigrationSql);
if (!changed.length) {
  summary(notApplicable(TITLE, 'el PR no agrega ni cambia SQL de migraciones'));
  process.exit(0);
}

const postgres = [];
const skipped = [];
for (const f of changed) {
  const d = migrationDialect(repo, f);
  (d === 'postgres' ? postgres : skipped).push({ f, d });
}
if (!postgres.length) {
  summary(notApplicable(TITLE, `squawk sólo revisa Postgres y estas migraciones son ${[...new Set(skipped.map((s) => s.d))].join(', ')}`));
  process.exit(0);
}

const args = ['--reporter', 'json'];
// Con .squawk.toml manda el repo; sin él, fuera las reglas de estilo.
if (!existsSync(join(repo, '.squawk.toml'))) args.push(`--exclude=${SQUAWK_STYLE_RULES.join(',')}`);
// Prisma corre cada migración dentro de una transacción.
if (postgres.every((p) => p.f.includes('prisma/migrations/'))) args.push('--assume-in-transaction');
const r = spawnSync('squawk', [...args, ...postgres.map((p) => p.f)], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
let items;
try { items = JSON.parse(r.stdout || '[]'); } catch {
  summary(`### ${TITLE}\n\n⚠️ squawk no devolvió JSON (${(r.stderr || '').slice(-300)}).\n`);
  process.exit(0);
}
const { blocking, soft } = squawkVerdict(items);

let md = `### ${TITLE}\n\nRevisé ${postgres.length} archivo(s) con squawk.\n\n`;
if (!blocking.length && !soft.length) md += '✅ Sin operaciones peligrosas.\n';
const table = (rows) => rows.map((i) => `| \`${i.file}:${(i.line ?? 0) + 1}\` | \`${i.rule_name}\` | ${i.message}${i.help ? ` — ${i.help}` : ''} |`).join('\n');
if (blocking.length) md += `❌ **${blocking.length} operación(es) peligrosa(s):**\n\n| Dónde | Regla | Qué pasa |\n|---|---|---|\n${table(blocking)}\n\n`;
if (soft.length) md += `⚠️ Avisos que no bloquean:\n\n| Dónde | Regla | Qué pasa |\n|---|---|---|\n${table(soft)}\n\n`;
if (skipped.length) md += `No revisados (no son Postgres): ${skipped.map((s) => `\`${s.f}\``).join(', ')}\n`;
md += '\nReglas en https://squawkhq.com/docs/rules. Para ajustarlas, agrega un `.squawk.toml` al repo.\n';
summary(md);
for (const i of blocking) console.log(`::error file=${i.file},line=${(i.line ?? 0) + 1},title=${i.rule_name}::${i.message}`);
process.exit(blocking.length ? 1 : 0);
