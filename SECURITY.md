# Seguridad

ghosty-dev es open source y corre en tu máquina con tus credenciales. Si encuentras una vulnerabilidad, **no abras un
issue público**: repórtala en privado con [GitHub Security Advisories](https://github.com/blissito/ghosty-dev/security/advisories/new)
o al correo de contacto de [ghosty.studio](https://www.ghosty.studio). Te contestamos en menos de 72 horas y te damos
crédito si quieres.

## Qué guarda y dónde

| Archivo | Qué tiene | Permisos |
|---|---|---|
| `${XDG_CONFIG_HOME:-~/.config}/ghosty-dev/auth.json` | access y refresh de Ghosty Studio, su vencimiento, el servidor que los emitió, scope y correo | 0600 en carpeta 0700 |
| `…/ghosty-dev/pending-login.json` | el `device_code` de un login a medias (`login --no-wait`); se borra al terminar | 0600 |

Si alguno quedó con permisos abiertos a otros usuarios, ghosty-dev los vuelve a cerrar y avisa por stderr.
`ghosty-dev logout` revoca el refresh en el servidor y borra `auth.json`. En CI, `GHOSTY_DEV_TOKEN` se usa tal cual y
no se escribe en disco. Nada de esto, ni los valores de tus variables, se imprime nunca: tampoco con `--json` ni en
errores (los mensajes del servidor se limpian de caracteres de control y de cualquier cosa con forma de token).

**GitHub no pasa por aquí**: todo lo de GitHub va con tu `gh` y su token nunca se manda a Ghosty ni a otro servidor.

## Permisos que pide

Cliente OAuth público `ghosty-dev`, scope `profile repo:env dev`:

- `profile`: tu correo, para `whoami`.
- `repo:env`: leer los nombres y guardar las variables (secretos) de la vista previa de tus repos (`env ls|push`).
- `dev`: mandar, seguir y detener tus pendientes de Desarrollo en la nube (`claim --cloud`, `cloud`, `stop`, `teleport`).

## Cómo se autentica

- **Sin secreto embebido.** Es un cliente público: con navegador, redirect loopback `http://127.0.0.1:<puerto>/cb`
  (RFC 8252) con PKCE S256 y `state`; sin navegador (SSH, CI, agentes), device flow (RFC 8628). El refresh rota en
  cada uso.
- **Sólo https.** `GHOSTY_DEV_BASE_URL` debe ser `https://` (`http://` sólo hacia `127.0.0.1`/`localhost`, para
  pruebas). Ninguna petición sigue redirecciones ni sale del origen de esa base, tampoco los endpoints que anuncie la
  metadata OAuth, y la sesión guardada sólo se manda al servidor que la emitió.
- **Los datos del servidor son datos.** Repos e ids se validan antes de entrar en una URL; una rama que llega del
  servidor se descarta si parece una opción de git; no hay `eval` ni comandos armados con respuestas del servidor.
