// La skill de ghosty-dev a nivel usuario (~/.claude/skills/ghosty-dev/SKILL.md): así la ve cualquier sesión de Claude,
// también la que opera el repo desde otro directorio. Antes sólo vivía en `<repo>/.claude/skills/`, y una sesión
// abierta en otro repo trabajaba el pendiente con git/gh a mano porque nunca leyó cómo se trabaja aquí (Formmy #97).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SKILL_SOURCE = new URL('../skill/SKILL.md', import.meta.url);
export const userSkillPath = (home = process.env.GHOSTY_DEV_CLAUDE_HOME || join(homedir(), '.claude')) => join(home, 'skills', 'ghosty-dev', 'SKILL.md');

/** Escribe o actualiza la skill de usuario. Nunca lanza: devuelve qué pasó. */
export function installUserSkill({ path = userSkillPath(), source = SKILL_SOURCE } = {}) {
  try {
    const want = readFileSync(source, 'utf8');
    const have = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (have === want) return { action: 'same', path };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
    return { action: have === null ? 'installed' : 'updated', path };
  } catch (e) {
    return { action: 'failed', path, error: e.message };
  }
}

/** Para `doctor`: ¿la skill de usuario está y al día? */
export function userSkillCheck({ path = userSkillPath(), source = SKILL_SOURCE } = {}) {
  let want = null;
  try {
    want = readFileSync(source, 'utf8');
  } catch {}
  if (!existsSync(path)) return { name: 'skill', ok: null, detail: `la skill de ghosty-dev no está en ${path}: una sesión de Claude fuera de este repo no sabe usar el CLI`, fix: 'ghosty-dev update (o ghosty-dev login) la instala' };
  if (want !== null && readFileSync(path, 'utf8') !== want) return { name: 'skill', ok: null, detail: `la skill de ${path} es de otra versión`, fix: 'ghosty-dev update la pone al día' };
  return { name: 'skill', ok: true, detail: `skill de usuario al día (${path})`, fix: null };
}
