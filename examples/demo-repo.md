# Guion: repo de demo para el taller

Objetivo: en vivo, dos agentes toman pendientes de un repo real, uno espera a que se desbloquee, y todo se cierra
con evidencia, sin que la persona lea el código. Ensayo cronometrado: ~10 min.

## 1. Preparar el repo (una vez, antes del taller)

```sh
mkdir bitacora-demo && cd bitacora-demo && git init -b main
npm init -y && npm pkg set type=module scripts.test="node --test"
mkdir test && printf "import { test } from 'node:test';\ntest('arranca', () => {});\n" > test/smoke.test.js
mkdir -p .github/workflows && cat > .github/workflows/ci.yml <<'YML'
name: ci
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm test
YML
git add -A && git commit -m "Base del demo"
gh repo create bitacora-demo --public --source . --push
bitacora init && git add -A && git commit -m "Bitácora" && git push
```

En *Settings → Branches → main*: checks obligatorios `test` y `bitacora/evidencia`.

## 2. Los tres pendientes

Cada uno con `gh issue create --label bitacora:listo --title … --body-file …`. Cuerpos:

**#1 Servidor HTTP con /health**
```markdown
## Objetivo
`npm start` levanta un servidor en el puerto 3000 con `GET /health`.

## Criterios de aceptación
- [ ] GET /health responde 200 con {"ok":true}
- [ ] hay un test que lo comprueba
```

**#2 Endpoint /version** (bloqueado por #1)
```markdown
## Objetivo
`GET /version` responde la versión de package.json.

## Criterios de aceptación
- [ ] GET /version responde 200 con {"version":"<la de package.json>"}
- [ ] hay un test que lo comprueba
```

**#3 README con cómo correrlo** (independiente)
```markdown
## Objetivo
El README dice cómo instalar, correr y probar el proyecto.

## Criterios de aceptación
- [ ] el README trae los comandos de instalar, correr y probar
- [ ] los comandos del README corren tal cual
```

Y el bloqueo: `bitacora block 2 --by 1`.

## 3. El guion en vivo

| min | pantalla | qué se dice |
|---|---|---|
| 0 | `bitacora ready` → #1 y #3; #2 no aparece | «#2 no se ofrece: está bloqueado por #1.» |
| 1 | Terminal A (Claude Code): «toma el siguiente pendiente» → `claim 1` | «Un escritor por pendiente, cada uno en su worktree.» |
| 1 | Terminal B (Codex): «toma el siguiente pendiente» → `claim 3` | «Paralelo sólo entre pendientes independientes.» |
| 4 | Los dos abren PR y corren `bitacora wait` | «No se quedan vigilando el CI: terminan.» |
| 6 | El check `bitacora/evidencia` en rojo en el PR | «Sin evidencia no hay merge.» |
| 7 | `bitacora ready` → `ci-verde`; el agente publica la evidencia; el check pasa | «Fíjate en lo que NO hago: no leo el código. Leo la evidencia.» |
| 8 | Merge de #1 → `bitacora ready` ahora ofrece #2 como `desbloqueado` | «El bloqueo se resolvió solo, por evento.» |
| 9 | `bitacora close` sobre un issue sin evidencia → se niega | «Nadie cierra con un "ya quedó".» |

## 4. Plan B

Si el CI o la red fallan en vivo: tener grabado el recorrido completo y, en local, `node --test` del propio
ghosty-bitacora (corre sin red) para enseñar las pruebas de conformidad.
