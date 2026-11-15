---
name: bitacora
description: Trabajar con la bitácora del repo (pendientes en GitHub Issues que se cierran con evidencia). Úsala al empezar cualquier tarea de código en un repo con etiquetas bitacora:*, cuando pidan «toma el siguiente pendiente», «cierra el #n» o cuando descubras trabajo nuevo.
---

# Bitácora: el trabajo vive en GitHub Issues, no en tu sesión

Tu sesión se puede tirar en cualquier momento. Lo que importa queda en el **pendiente** (un issue con etiqueta
`bitacora:*`). Tres leyes, sin excepción:

1. **El trabajo vive en la bitácora, no en la sesión.** Lo pendiente, lo decidido y lo descubierto se escribe en
   el issue, no en tu contexto ni en un TODO de markdown.
2. **Se revisa la evidencia, no el código.** Nunca digas «ya quedó» sin evidencia; nunca cierres sin el
   comentario de evidencia.
3. **Se espera por evento, no se sondea.** No te quedes vigilando el CI: deja el pendiente en `esperando` y
   termina.

## El ciclo

```sh
bitacora ready --json            # qué se puede tomar (listo, desbloqueado o CI ya resuelto)
bitacora claim <n>               # te lo asigna y crea su worktree y su rama bitacora/<n>-…
cd ../<repo>-<n>                 # trabaja SÓLO ahí: un pendiente, un worktree, un escritor
# … código y tests …
git push -u origin HEAD && gh pr create --fill --body "Closes #<n>"
bitacora wait <n>                # CI corriendo: termina tu sesión aquí
```

Cuando `bitacora ready` te devuelva el pendiente con `ci-verde` (o `ci-rojo`, entonces arréglalo y repite):

```sh
bitacora evidence <n> --file evidencia.md   # valida el formato y lo publica en el issue
```

El PR lo mergea el **Clerk** (la persona) después de leer la evidencia; `Closes #<n>` cierra el pendiente.
Si no hubo PR (tarea sin código), `bitacora close <n>`, que también exige evidencia.

## El archivo de evidencia

~~~markdown
## Qué se hizo
Una o dos frases concretas.

## Verificación
```sh
$ npm test
<salida real, copiada, no resumida>
```

## CI
✅ passed — <liga del run>

## Preview
<liga o video del recorrido, o «no aplica»>

## Criterios de aceptación
- [x] <cada criterio del pendiente, con el mismo texto>
~~~

Reglas: la salida es la real (si la recortas, dilo); un criterio que no se cumple se queda `[ ]` y no publicas;
CI rojo no se publica como evidencia.

## Lo que descubras

Si encuentras un bug, un test roto que no es tuyo o trabajo que falta: **abre un pendiente nuevo**, no una nota
ni un comentario perdido, y sigue con el tuyo.

```sh
gh issue create --label bitacora:listo --title "…" --body "Descubierto en #<n>. …"
# si tu pendiente no puede seguir sin él:
bitacora block <n> --by <nuevo>
```

## Prohibido

- Tomar un pendiente asignado a otro, o trabajar dos pendientes en el mismo worktree.
- Cerrar un issue con `gh issue close` directo, o publicar evidencia que no corriste.
- Dormir/sondear esperando CI (`sleep`, `gh run watch`, loops).
- Calificarte a ti mismo como revisión: la revisión la hace otra sesión o la persona, leyendo sólo el pendiente,
  la evidencia y el diff.
