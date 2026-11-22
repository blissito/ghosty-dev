// ¿Qué workflows del repo corren con un push a una rama? Para avisar antes del push de la instalación: en un repo de
// producción, un push a la rama principal suele disparar el deploy (Formmy, fila 3). Lectura de texto, sin
// dependencias: cubre `on: push`, `on: [push, …]` y el bloque `on:` con `push:` y sus `branches`/`branches-ignore`.
// Ante la duda (un YAML que no se entiende), se lista: es un aviso, mejor de más que de menos.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`);

const strip = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');

// Los valores de una llave: lista en línea ([a, b]), un valor suelto o renglones «- x» más indentados.
function listOf(lines, i, indent) {
  const inline = lines[i].replace(/^\s*[\w-]+:\s*/, '');
  if (inline.trim()) {
    const m = inline.match(/^\[(.*)\]/);
    return (m ? m[1].split(',') : [inline]).map(strip).filter(Boolean);
  }
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (l.search(/\S/) <= indent) break;
    const m = l.match(/^\s*-\s*(.+)$/);
    if (m) out.push(strip(m[1]));
  }
  return out;
}

// Puro: { push: bool, paths: bool } para el texto de un workflow y una rama.
export function triggersOnPush(text, branch) {
  const lines = String(text).split(/\r?\n/);
  const onIdx = lines.findIndex((l) => /^(?:on|"on"|'on'|true):/.test(l));
  if (onIdx === -1) return { push: false, paths: false };
  const inline = lines[onIdx].replace(/^[^:]+:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline) return { push: /^push$/.test(inline) || /^\[.*\bpush\b.*\]$/.test(inline), paths: false };
  // Bloque `on:`: busca `push:` en el primer nivel de indentación.
  let pushIdx = -1;
  let level = null;
  for (let j = onIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.search(/\S/);
    if (ind === 0) break;
    level ??= ind;
    if (ind === level && /^\s*push\s*:/.test(l)) {
      pushIdx = j;
      break;
    }
  }
  if (pushIdx === -1) return { push: false, paths: false };
  const pushIndent = lines[pushIdx].search(/\S/);
  const keys = {};
  for (let j = pushIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.search(/\S/);
    if (ind <= pushIndent) break;
    const m = l.match(/^\s*([\w-]+)\s*:/);
    if (m && !(m[1] in keys)) keys[m[1]] = listOf(lines, j, ind);
  }
  const paths = 'paths' in keys || 'paths-ignore' in keys;
  if (keys.branches) return { push: keys.branches.some((p) => !p.startsWith('!') && glob(p).test(branch)) && !keys.branches.some((p) => p.startsWith('!') && glob(p.slice(1)).test(branch)), paths };
  if (keys['branches-ignore']) return { push: !keys['branches-ignore'].some((p) => glob(p).test(branch)), paths };
  // Sólo tags: un push a una rama no lo dispara.
  if (keys.tags || keys['tags-ignore']) return { push: false, paths };
  return { push: true, paths };
}

// Los workflows de `dir` que corren con un push a `branch`: [{ file, name, paths }].
export function pushWorkflows(dir, branch) {
  const wf = join(dir, '.github', 'workflows');
  if (!existsSync(wf)) return [];
  const out = [];
  for (const file of readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    let text = '';
    try {
      text = readFileSync(join(wf, file), 'utf8');
    } catch {
      continue;
    }
    const t = triggersOnPush(text, branch);
    if (!t.push) continue;
    const name = text.match(/^name:\s*(.+)$/m);
    out.push({ file: `.github/workflows/${file}`, name: name ? strip(name[1]) : null, paths: t.paths });
  }
  return out;
}
