# ghosty-dev

**No necesitas una fábrica: necesitas una bitácora que no se pierda y evidencia que no mienta.**

ghosty-dev es una forma de trabajar con agentes de código (Claude Code, Codex…) sobre GitHub Issues:

1. **El trabajo vive en la bitácora, no en la sesión.** Cada tarea es un *pendiente* (un issue). La sesión del
   agente se tira; el pendiente no.
2. **Se revisa la evidencia, no el código.** Un pendiente se cierra con un comentario de evidencia (qué se hizo,
   comandos y su salida, CI, preview). Sin evidencia, el check `ghosty-dev/evidencia` no deja mergear.
3. **Se espera por evento, no se sondea.** El agente no vigila el CI: lo deja en `esperando` y termina.

## Por qué no es una fábrica

Una fábrica pone agentes en línea con roles fijos (planea → construye → revisa) que se pasan la estafeta. Aquí no
hay línea: **un solo escritor por pendiente**, paralelo sólo entre pendientes independientes (cada uno en su
worktree), y una persona —el **Clerk**— que lee la evidencia y decide el corte. Las piezas son de Beads, Symphony,
Cognition y Anthropic, y están citadas en [SPEC.md](SPEC.md#2-qué-copiamos-y-de-quién).

## Instalar

No lo instalas tú: se lo pides a tu agente (Claude Code, Codex…) dentro de tu repo.

> Instala github.com/blissito/ghosty-dev aquí

El agente lee [INSTALL.md](INSTALL.md) y hace los pasos él solo. Te pregunta antes de hacer push.

**Si eres un agente:** sigue [INSTALL.md](INSTALL.md).

A mano, con Node 20+ y [`gh`](https://cli.github.com) autenticado:

```sh
npm install -g github:blissito/ghosty-dev
cd ~/tu-repo && ghosty-dev init        # etiquetas, plantilla, Action, skill y AGENTS.md
git add -A && git commit -m "ghosty-dev" && git push   # directo a main: la puerta corre desde ahí
ghosty-dev protect                     # ghosty-dev/evidencia obligatorio en main
```

`protect` usa tu propio `gh`: hace falta ser admin del repo (en repos privados, GitHub lo pide con plan de pago).

## Demo en 1 minuto

```sh
ghosty-dev add "Agregar /health" --goal "GET /health responde 200" --criteria "hay un test"
ghosty-dev ready                         # #1  listo  Agregar /health
ghosty-dev claim 1                       # rama ghosty-dev/1-agregar-health en ../tu-repo-1
# … el agente trabaja en ../tu-repo-1, abre el PR con «Closes #1» …
ghosty-dev wait 1 --watch                # espera al CI en una sola llamada, sin sondear (tope 5 min)
ghosty-dev ready                         # #1  ci-verde  Agregar /health
ghosty-dev evidence 1 --file evidencia.md
# el check ghosty-dev/evidencia pasa; el Clerk lee la evidencia y mergea
```

Al agente se le dice una sola cosa: «toma el siguiente pendiente». La skill (`.claude/skills/ghosty-dev/`) y
`AGENTS.md` le explican el resto.

## Comandos

`init` · `protect` · `add "título" --goal … --criteria …` · `ready [--json] [--claim]` · `claim <n>` · `wait <n>` · `evidence <n> --file f.md` · `block <n> --by <m>` ·
`show <n>` · `close <n>`. Detalle en `ghosty-dev --help` y en [SPEC.md](SPEC.md).

## Tests

```sh
node --test      # sin red: usa un gh falso (testkit/fake-gh.mjs)
```

## Licencia

MIT © Ghosty Studio. En [ghosty.studio](https://ghosty.studio) la bitácora trabaja sin tu compu prendida.
