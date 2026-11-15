# Instalar ghosty-dev (instrucciones para el agente)

Una persona te pidió algo como «Instala github.com/blissito/ghosty-dev aquí». Sigue estos pasos tú solo, en orden,
desde la raíz del repo donde estás trabajando. No le hagas preguntas a la persona salvo donde este archivo lo dice.

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
- `AGENTS.md`: las tres reglas para cualquier agente. Si ya existe, `init` agrega una sección al final.

Si un archivo ya existía, `init` no lo toca. Usa `--force` sólo si la persona te lo pide.

## 4. Guarda los cambios en una rama

```sh
git switch -c ghosty-dev-init
git add .github .claude AGENTS.md
git commit -m "ghosty-dev: pendientes en GitHub Issues que se cierran con evidencia"
```

**Pregunta a la persona antes de hacer push o de abrir el PR.** Enséñale la lista de archivos de `git show --stat`.

## 5. Haz obligatoria la puerta de evidencia

El check se llama `ghosty-dev/evidencia`. Dile a la persona que lo marque como obligatorio en
*Settings → Branches → Require status checks*. Si te pide que lo hagas tú, usa `gh api` sobre la protección de la
rama principal y enséñale el comando antes de correrlo.

## 6. Comprueba y avisa

```sh
ghosty-dev ready
```

Una lista vacía es correcta en un repo sin pendientes. Termina con un mensaje corto a la persona:
qué se instaló, en qué rama quedó y que, para empezar, basta con pedirte «toma el siguiente pendiente».
