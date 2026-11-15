# ghosty-bitacora

**No necesitas una fábrica: necesitas una bitácora que no se pierda y evidencia que no mienta.**

ghosty-bitacora es una forma de trabajar con agentes de código (Claude Code, Codex…) sobre GitHub Issues:

1. **El trabajo vive en la bitácora, no en la sesión.** Cada tarea es un *pendiente* (un issue). La sesión del
   agente se tira; el pendiente no.
2. **Se revisa la evidencia, no el código.** Un pendiente se cierra con un comentario de evidencia (qué se hizo,
   comandos y su salida, CI, preview). Sin evidencia, el check `bitacora/evidencia` no deja mergear.
3. **Se espera por evento, no se sondea.** El agente no vigila el CI: lo deja en `esperando` y termina.

## Por qué no es una fábrica

Una fábrica pone agentes en línea con roles fijos (planea → construye → revisa) que se pasan la estafeta. Aquí no
hay línea: **un solo escritor por pendiente**, paralelo sólo entre pendientes independientes (cada uno en su
worktree), y una persona —el **Clerk**— que lee la evidencia y decide el corte. Las piezas son de Beads, Symphony,
Cognition y Anthropic, y están citadas en [SPEC.md](SPEC.md#2-qué-copiamos-y-de-quién).

## Instalar (3 comandos)

Requiere Node 20+ y [`gh`](https://cli.github.com) autenticado.

```sh
git clone <este repo> ghosty-bitacora && (cd ghosty-bitacora && npm link)
cd ~/tu-repo && bitacora init        # etiquetas, plantilla, Action, skill y AGENTS.md
git add -A && git commit -m "Bitácora" && git push
```

Luego, en *Settings → Branches*, marca `bitacora/evidencia` como check obligatorio.

## Demo en 1 minuto

```sh
gh issue create --label bitacora:listo --title "Agregar /health" --body-file pendiente.md
bitacora ready                         # #1  listo  Agregar /health
bitacora claim 1                       # rama bitacora/1-agregar-health en ../tu-repo-1
# … el agente trabaja en ../tu-repo-1, abre el PR con «Closes #1» …
bitacora wait 1                        # esperando el CI; la sesión termina
bitacora ready                         # #1  ci-verde  Agregar /health
bitacora evidence 1 --file evidencia.md
# el check bitacora/evidencia pasa; el Clerk lee la evidencia y mergea
```

Al agente se le dice una sola cosa: «toma el siguiente pendiente». La skill (`.claude/skills/bitacora/`) y
`AGENTS.md` le explican el resto.

## Comandos

`init` · `ready [--json] [--claim]` · `claim <n>` · `wait <n>` · `evidence <n> --file f.md` · `block <n> --by <m>` ·
`show <n>` · `close <n>`. Detalle en `bitacora --help` y en [SPEC.md](SPEC.md).

## Tests

```sh
node --test      # sin red: usa un gh falso (testkit/fake-gh.mjs)
```

## Licencia

MIT © Ghosty Studio. En [ghosty.studio](https://ghosty.studio) la bitácora trabaja sin tu compu prendida.
