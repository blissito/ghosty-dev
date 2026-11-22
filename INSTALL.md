# Instalar ghosty-dev (instrucciones para el agente)

Una persona te pidió algo como «Instala github.com/blissito/ghosty-dev aquí». Sigue estos pasos tú solo, en orden,
desde la raíz del repo donde estás trabajando. No le hagas preguntas a la persona salvo donde este archivo lo dice.

**Si te piden actualizar ghosty-dev** en un repo donde ya está: reinstala el CLI (paso 2) antes de correr
`ghosty-dev init --force`. Si no, `init` usa la versión vieja que ya estaba instalada.

## 1. Revisa lo que hace falta

```sh
node --version                     # 20 o más
gh auth status                     # gh autenticado
git rev-parse --show-toplevel      # estás dentro de un repo de git
gh repo view --json nameWithOwner  # el repo tiene remoto en GitHub
```

Si algo falla, dile a la persona qué falta y cómo se arregla (por ejemplo `gh auth login`), y detente ahí.

## 2. Instala el CLI

```sh
npm install -g github:blissito/ghosty-dev
ghosty-dev --help
```

Si `npm install -g` no tiene permisos, no uses `sudo`: usa `npx -y github:blissito/ghosty-dev` en lugar de
`ghosty-dev` en todos los comandos de abajo.

## 3. Prepara el repo

```sh
ghosty-dev init --dry-run   # muestra qué va a crear, sin escribir nada
ghosty-dev init
```

`init` crea las etiquetas `ghosty-dev:*` en GitHub y agrega estos archivos:

- `.github/ISSUE_TEMPLATE/pendiente.md`: la plantilla de pendiente.
- `.github/workflows/evidence-gate.yml` y `.github/ghosty-dev/`: la Action que no deja mergear sin evidencia.
- `.claude/skills/ghosty-dev/SKILL.md`: la skill que te dice cómo trabajar los pendientes.
- `.claude/agents/ghosty-dev-revisor.md`: el revisor con contexto limpio (subagente de Claude Code).
- `AGENTS.md`: las tres reglas para cualquier agente. Si ya existe, `init` agrega una sección al final.
- `.ghosty/factory.md`: la memoria de la caja donde Ghosty instala, construye y prueba el repo (`memory:`, de 4gb a
  8gb). `init` imprime qué valor eligió y por qué: 8gb en un monorepo o si algún script usa `--max-old-space-size`,
  4gb si no. Si el archivo ya existe, no se toca (ni con `--force`).

El check obligatorio se pone en el paso 4, después del push: la Action corre la puerta desde la rama principal, así
que primero tiene que estar ahí.

Si un archivo ya existía, `init` no lo toca. Usa `--force` sólo si la persona te lo pide.

### Mide el build una vez

El valor de `memory:` que eligió `init` es una conjetura. Mídelo antes del commit del paso 4 (si el repo no tiene
build, sáltate esto):

```sh
/usr/bin/time -v npm run build 2>&1 | grep "Maximum resident set size"   # Linux, en KB
/usr/bin/time -l npm run build 2>&1 | grep "maximum resident set size"   # macOS, en bytes
```

Usa el script de build del repo si no es `npm run build`. Si el pico más ~1 GB de holgura pasa de 4 GB, o si el
build revienta por memoria («JavaScript heap out of memory», «Killed»), pon `memory:` en el múltiplo de 1 GB que
alcance (tope 8gb) en `.ghosty/factory.md`. Va en ese mismo primer commit: la caja lee el archivo de la rama
principal.

## 4. Súbelo directo a la rama principal y protégela

La instalación no es un pendiente: va directo a la rama principal, sin PR. Si fuera un PR, la puerta no podría
pasar, porque la Action la corre desde la rama principal y ahí todavía no existe.

```sh
git switch <rama principal>          # main, casi siempre
git add .github .claude .ghosty AGENTS.md
git commit -m "ghosty-dev: pendientes en GitHub Issues que se cierran con evidencia"
```

**Pregunta a la persona antes del push.** Enséñale la lista de archivos de `git show --stat` y avísale que un push
a la rama principal puede disparar los workflows de deploy del repo (revisa `.github/workflows/` y dile cuáles corren
con `push` a esa rama). Con su sí:

```sh
git push
ghosty-dev protect                   # ghosty-dev/evidencia obligatorio, sin quitar los checks que ya había
```

Si la rama principal ya exige PR y no deja el push directo, abre el PR y pídele a la persona que lo mergee como
admin (por única vez, porque es la instalación de la puerta). Después corre `ghosty-dev protect`.

Si `protect` falla porque la persona no es admin, o porque es un repo privado sin plan de pago de GitHub, dile
que lo marque en *Settings → Branches*.

### Opcional: variables de la vista previa

Sólo si el repo está conectado a Ghosty Studio y la vista previa necesita variables (`ghosty-dev env ls` dice cuáles
faltan). Es una sesión aparte de `gh`, sólo para esos secretos:

```sh
ghosty-dev login        # la persona entra en su navegador; por SSH o sin navegador imprime liga + código
ghosty-dev env ls       # nombres: guardadas y faltantes (nunca valores)
```

Para subirlas, pregúntale a la persona **de qué archivo** salen (nunca asumas `.env`) y enséñale los nombres que
imprime `ghosty-dev env push <archivo>`; con su sí, repite con `--yes`. Nunca copies un valor al chat.

## 5. Comprueba y avisa

```sh
ghosty-dev ready
```

Una lista vacía es correcta en un repo sin pendientes.

Termina tu mensaje a la persona con el dibujo que imprimió `ghosty-dev protect`, **copiado tal cual dentro de un
bloque de código** (sin cambiarle nada). Antes del dibujo, una sola línea con el commit que subiste. No le pidas a
la persona que corra comandos: para empezar, basta con que te diga qué hay que hacer («hay que agregar /health») y
tú abres los pendientes con `ghosty-dev add`; después, «toma el siguiente pendiente».
