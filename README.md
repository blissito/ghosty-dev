# ghosty-dev

**No necesitas una fábrica: necesitas una bitácora que no se pierda y evidencia que no mienta.**

## Cómo se usa (3 pasos)

1. **Le dices a tu agente qué hay que hacer.** Él lo apunta como pendientes (issues de GitHub).
2. **Le dices «toma el siguiente pendiente».** Lo hace, abre el PR, espera las pruebas, **otro agente con
   contexto limpio lo revisa** y deja la evidencia en el issue.
3. **Tú lees la evidencia y la revisión, y das merge.** Sin las dos, GitHub no te deja.

Sólo necesitas Claude Code (o Codex) y GitHub. Todo lo demás lo hace el agente.

## Las tres leyes

ghosty-dev es una forma de trabajar con agentes de código (Claude Code, Codex…) sobre GitHub Issues:

1. **El trabajo vive en la bitácora, no en la sesión.** Cada tarea es un *pendiente* (un issue). La sesión del
   agente se tira; el pendiente no.
2. **Se revisa la evidencia, no el código.** Un pendiente se cierra con un comentario de evidencia (qué se hizo,
   comandos y su salida, CI) y una revisión de otro agente que no vio cómo se escribió, atada al commit exacto.
   Sin las dos, el check `ghosty-dev/evidencia` no deja mergear.
3. **Se espera por evento, no se sondea.** El agente espera al CI con una sola llamada que no gasta tokens; si
   tarda, toma otro pendiente.

## Por qué no es una fábrica

Una fábrica pone agentes en línea con roles fijos (planea → construye → revisa) que se pasan la estafeta. Aquí no
hay línea: **un solo escritor por pendiente**, **un revisor con contexto limpio** que intenta romperlo (quien
escribe se califica de más), paralelo sólo entre pendientes independientes (cada uno en su worktree), y una
persona —el **Clerk**— que lee la evidencia y decide el corte. Las piezas son de Beads, Symphony,
Cognition y Anthropic, y están citadas en [SPEC.md](SPEC.md#2-qué-copiamos-y-de-quién).

## Instalar

No lo instalas tú: se lo pides a tu agente (Claude Code, Codex…) dentro de tu repo.

> Instala github.com/blissito/ghosty-dev aquí

El agente lee [INSTALL.md](INSTALL.md) y hace los pasos él solo. Te pregunta antes de hacer push.

**Si eres un agente:** sigue [INSTALL.md](INSTALL.md).

A mano, con Node 20+ y [`gh`](https://cli.github.com) autenticado:

```sh
npm install -g github:blissito/ghosty-dev
cd ~/tu-repo && ghosty-dev init        # etiquetas, plantilla, Actions (puerta y revisiones), skill, AGENTS.md y .ghosty/factory.md
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
ghosty-dev show 1                        # ficha y servicios del PR: vista previa, revisión, smoke y CI
# el subagente ghosty-dev-revisor (contexto limpio) intenta romperlo y publica:
ghosty-dev review 1 --file revision.md   # atada al commit del PR; con hallazgos, se arregla y se repite
ghosty-dev evidence 1 --file evidencia.md
# el check ghosty-dev/evidencia pasa; el Clerk lee la evidencia y mergea
```

Al agente se le dice una sola cosa: «toma el siguiente pendiente». La skill (`.claude/skills/ghosty-dev/`) y
`AGENTS.md` le explican el resto.

## Revisiones de Ghosty (workflow reutilizable)

`init` también deja `.github/workflows/ghosty-checks.yml`, que llama a
[`checks.yml`](.github/workflows/checks.yml) de este repo. Todo es OSS y gratis, y cada job dice «no aplica» si tu
repo no lo necesita:

| Job | Qué revisa | ¿Bloquea? |
|---|---|---|
| `deps` | Paquetes nuevos (npm/PyPI): que existan, edad, descargas, typosquat, scripts al instalar; y CVE nuevas con OSV-Scanner | Sí: paquete inexistente o CVE HIGH/CRITICAL nueva |
| `sast` | Semgrep CE `p/default`, sólo lo que introduce el PR (`--baseline-commit`) | Sí, en hallazgos ERROR |
| `migrations` | squawk sobre el SQL nuevo de migraciones (Postgres) | Sí |
| `api-contract` | oasdiff `breaking` entre el `openapi.*` de la base y el del PR | Sí |
| `bundle` | Build de base contra PR y tamaño de la carpeta de salida | No: aviso si crece más de 20 % |
| `coverage` | Cobertura de las líneas cambiadas con diff-cover (sólo si el repo ya genera lcov) | No |

```yaml
jobs:
  ghosty-checks:
    uses: blissito/ghosty-dev/.github/workflows/checks.yml@v1
    with:
      runs-on: '"ubuntu-latest"'   # privado con caja de CI de Ghosty: '["self-hosted","ws-<espacio>"]'
```

Las actions van fijadas por SHA y los binarios por versión con su sha256. Funciona igual desde repos privados.

## Comandos

`init` · `protect` · `add "título" --goal … --criteria …` · `ready [--json] [--claim]` · `claim <n>` · `wait <n> [--watch]` · `review <n> [--file f.md]` · `evidence <n> --file f.md` · `board` · `block <n> --by <m>` ·
`show <n>` · `close <n>` · `login` · `whoami` · `logout` · `env ls` · `env push <archivo>`.

Con el repo conectado a [Ghosty Studio](https://www.ghosty.studio), todo PR no borrador recibe solo su vista previa,
la revisión de Ghosty Review, el smoke y la ficha, lo escriba quien lo escriba. `wait --watch` avisa cuando la vista
previa y la revisión terminan (el CI decide el verde) y `show <n>` imprime su estado en «Servicios del PR», con la liga
de la vista previa. Los checks de la plataforma que no cuentan como CI están en [SPEC.md §5c](SPEC.md).

En la nube (opcional, con una cuenta de [Ghosty Studio](https://www.ghosty.studio) y `ghosty login`): `claim <n> --cloud` · `cloud` · `stop <n>` · `teleport <n>`. Un agente construye el pendiente en una caja de trabajo con el mismo contrato y te avisa. Detalle en `ghosty-dev --help` y en [SPEC.md](SPEC.md).

### Variables de la vista previa

La vista previa de la nube necesita los secretos del repo (`DATABASE_URL`, llaves de API…). Se suben desde tu compu
con una sesión propia de Ghosty Studio, separada de GitHub (GitHub sigue siendo `gh` y su token nunca sale de tu
máquina):

```sh
ghosty-dev login                       # navegador (OAuth con PKCE); por SSH o con --device: liga + código
ghosty-dev env ls                      # sólo nombres: guardadas, faltantes, riesgos
ghosty-dev env push .env.preview       # el archivo siempre se nombra; muestra los nombres y pide confirmación
ghosty-dev whoami · ghosty-dev logout  # logout revoca la sesión en Ghosty
```

Por defecto `env push` fusiona con lo guardado (`--replace` reemplaza todo). Ningún valor se imprime. En CI,
`GHOSTY_DEV_TOKEN` manda sobre la sesión guardada. Detalle normativo en [SPEC.md §8](SPEC.md).

## Tests

```sh
node --test      # sin red: usa un gh falso (testkit/fake-gh.mjs)
```

## Licencia

MIT © Ghosty Studio. En [ghosty.studio](https://ghosty.studio) la bitácora trabaja sin tu compu prendida.
