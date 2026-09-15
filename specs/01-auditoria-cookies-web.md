# SPEC 01 — Skill de auditoría de cookies web

> **Estado:** Aprobado
> **Depende de:** ninguna
> **Fecha:** 2026-09-15
> **Objetivo:** Crear una skill de Claude Code que audite una o varias URLs comparando las cookies realmente presentes en el navegador con las declaradas en la página de cookies y en el panel de configuración del banner, y entregue dos CSV y un informe HTML de discrepancias.

---

## 1 — Por qué existe esta spec

La comprobación de cumplimiento de cookies se hace hoy a mano: abrir el sitio, aceptar el banner, mirar el inspector, abrir la página de política de cookies y comparar listas a ojo. Es lento, no deja trazabilidad y se escapan cookies.

Esta skill automatiza ese recorrido y deja artefactos auditables por URL: los datos crudos en CSV y un informe HTML presentable.

La decisión que condiciona todo el diseño es el motor de navegación. El inventario de cookies tiene que ser **exacto**, porque un falso «correcta, todo declarado» es peor que no auditar. Solo el Chrome DevTools Protocol devuelve el almacén completo: `Network.getAllCookies` es la misma fuente que alimenta el panel Application → Cookies de DevTools, e incluye HttpOnly, terceros y particionadas. Por eso el motor es Playwright sobre Node, ejecutado desde Claude Code, y no un MCP de navegador: ningún MCP estándar expone ese almacén.

---

## 2 — Alcance

**Dentro:**

- Skill de Claude Code que acepta una o varias URLs como argumento y, si no las recibe, las pide.
- Script Node con Playwright que conduce un Chromium visible con un perfil limpio por ejecución.
- Recorrido por URL: cargar, localizar y aceptar el banner (aceptar todas), esperar red inactiva, hacer scroll hasta el final e inventariar cookies.
- Inventario de cookies reales mediante `Network.getAllCookies` vía sesión CDP, equivalente al panel Application al completo.
- Localización de la página de política de cookies siguiendo el enlace del footer cuyo texto contenga «cookie».
- Extracción completa de las cookies declaradas en esa página, recorriendo la página entera y no solo la primera tabla.
- Reapertura del banner desde el botón presente en la página de cookies, entrada en «Configuración de cookies», despliegue de todas las secciones con scroll y extracción de sus cookies declaradas por categoría.
- Cotejo a tres bandas por nombre de cookie, con soporte de comodines en las declaraciones.
- Salidas por URL en `reports/<dominio>-<YYYYMMDD-HHmm>/`: un CSV con tres bloques, un CSV matriz de correspondencia y un informe HTML autocontenido.
- Detección de banner y secciones por heurística genérica de texto y DOM, sin depender de un CMP concreto.
- Protocolo de bloqueo: cuando una pieza del flujo no se encuentra, el script se detiene con una incidencia estructurada y la skill pregunta al usuario antes de relanzar.

**Fuera de alcance (para futuras specs):**

- Segunda pasada rechazando el consentimiento para detectar cookies previas al consentimiento.
- Comparación de duraciones y dominios declarados frente a los reales. Se vuelcan al CSV como información, no como criterio.
- Navegación por páginas internas para provocar cookies adicionales.
- Capturas de pantalla como evidencia embebida.
- Modo headless para lotes grandes.
- Variante ejecutable desde la app Claude Desktop conducida por un MCP de navegador.
- Inventario de `localStorage`, `sessionStorage` y técnicas de fingerprinting.
- Idiomas de banner más allá de castellano e inglés.
- Informe agregado de varias URLs en un único documento.

---

## 3 — Modelo de datos

La recolección produce `auditoria.json` dentro de la carpeta de salida de cada URL. Es la única entrada del generador de informes.

```js
const auditoria = {
  url: "https://ejemplo.com",
  dominio: "ejemplo.com",
  timestamp: "2026-09-15T10:32:00+02:00",
  urlPaginaCookies: "https://ejemplo.com/politica-de-cookies",
  cookiesReales: [
    // { nombre, valor, dominio, path, expira, httpOnly, secure, sameSite }
  ],
  cookiesPagina: [
    // { nombre, categoria, proveedor, duracion, finalidad, tablaOrigen }
  ],
  cookiesPanel: [
    // { nombre, categoria, proveedor, duracion, finalidad, seccion }
  ],
  incidencias: [
    // { fase, descripcion, resolucionUsuario }
  ],
};
```

Convenciones:

- `nombre` se guarda tal cual aparece. La comparación normaliza recortando espacios y respeta mayúsculas.
- Un nombre declarado que contenga `*` o un marcador tipo `<id>` se trata como patrón y casa por prefijo. Ejemplo: `_ga_*` casa con `_ga_ABC123`.
- `valor` se trunca a 40 caracteres en las salidas. Nunca se vuelca un valor completo.
- `expira` es ISO 8601, o la cadena `sesión` si la cookie no tiene caducidad.
- Cada fila de la matriz de correspondencia se calcula a partir de los tres listados y lleva este veredicto:

| Presente | En página | En panel | Veredicto                       | Severidad |
| -------- | --------- | -------- | ------------------------------- | --------- |
| sí       | no        | no       | No declarada                    | Crítica   |
| sí       | sí        | no       | Ausente en el panel del banner  | Alta      |
| sí       | no        | sí       | Ausente en la página de cookies | Alta      |
| sí       | sí        | sí       | Correcta                        | —         |
| no       | sí        | sí       | Declarada y no presente         | Media     |
| no       | sí        | no       | Declarada solo en la página     | Media     |
| no       | no        | sí       | Declarada solo en el panel      | Media     |

Cuando una cookie aparece en los dos listados declarados con categoría distinta, se añade el veredicto `Categoría incoherente` con severidad Alta, aunque el resto de la fila sea correcta.

Ficheros de salida por URL, en `reports/<dominio>-<YYYYMMDD-HHmm>/`:

- `auditoria.json` — datos crudos de la recolección.
- `cookies.csv` — tres bloques, cada uno precedido de una línea de título y su cabecera propia.
- `correspondencia.csv` — matriz limpia, una fila por nombre de cookie.
- `informe.html` — informe autocontenido.

Los CSV se escriben con punto y coma como separador y BOM UTF-8, para que Excel en castellano los abra en columnas sin pasar por el asistente de importación.

Cuando el script se detiene por un bloqueo, escribe la incidencia en stdout como JSON con esta forma y termina con código de salida 2:

```js
{ "bloqueo": "banner-no-encontrado", "fase": 1, "descripcion": "..." }
```

Bloqueos posibles: `banner-no-encontrado`, `pagina-cookies-no-encontrada`, `boton-reabrir-no-encontrado`, `panel-configuracion-no-encontrado`.

---

## 4 — Plan de implementación

1. Crear `package.json` en la raíz con `playwright` como dependencia y un script `audit`. Documentar en `README.md` que la primera vez hay que ejecutar `npm install` y `npx playwright install chromium`. Verificación: `npm install` termina sin errores.
2. Crear `.claude/skills/check-cookies/SKILL.md` con el frontmatter (`name`, `description`) y el esqueleto de fases. Verificación: la skill aparece listada en Claude Code.
3. Crear `.claude/skills/check-cookies/scripts/audit.mjs` con el arranque: parseo de argumentos (`--url`, `--salida`, `--cookies-url`, `--selector-aceptar`, `--selector-reabrir`), lanzamiento de Chromium visible con perfil limpio y volcado de un `auditoria.json` vacío. Prueba manual: `node audit.mjs --url https://ejemplo.com` abre el navegador y escribe el JSON.
4. Implementar en `audit.mjs` la fase 1: cargar la URL, localizar y pulsar el botón de aceptar del banner, esperar red inactiva y hacer scroll hasta el final. Prueba manual: ver el banner desaparecer en pantalla.
5. Implementar el inventario CDP: abrir sesión con `context.newCDPSession`, llamar a `Network.getAllCookies` y volcar `cookiesReales`. Prueba manual: comparar el listado con el panel Application del propio Chromium abierto.
6. Crear `.claude/skills/check-cookies/references/deteccion-banner.md` con las heurísticas de texto y DOM: patrones del botón de aceptar, del enlace del footer, del botón que reabre el banner y de los acordeones de categoría, en castellano e inglés. Refactorizar `audit.mjs` para leer de ahí sus patrones.
7. Implementar la fase 2: localizar el enlace de cookies en el footer, navegarlo y extraer todos los listados de la página completa a `cookiesPagina`.
8. Implementar la fase 3: pulsar el botón que reabre el banner, entrar en «Configuración de cookies», desplegar cada sección con scroll y extraer `cookiesPanel` con su categoría.
9. Añadir el protocolo de bloqueo: cada fase que no encuentre su pieza emite el JSON de bloqueo y sale con código 2, sin escribir salidas parciales corruptas.
10. Crear `.claude/skills/check-cookies/scripts/build_report.mjs`, que lee `auditoria.json`, calcula la matriz de correspondencia con soporte de comodines y escribe `cookies.csv` y `correspondencia.csv`. Prueba manual: ejecutarlo con un JSON de ejemplo y abrir los CSV en Excel.
11. Añadir a `build_report.mjs` la generación de `informe.html` a partir de `.claude/skills/check-cookies/scripts/plantilla_informe.html`: conteos por severidad, semáforo de estado, tabla de discrepancias y apartado de incidencias.
12. Escribir en `SKILL.md` el flujo completo: pedir URLs si faltan, ejecutar `audit.mjs` por URL, interpretar el código de salida 2 preguntando al usuario y relanzando con el parámetro que resuelva el bloqueo, ejecutar `build_report.mjs` y resumir los conteos en la conversación con la ruta de la carpeta de salida.
13. Documentar en `README.md` la instalación, el uso y el formato de las salidas.

---

## 5 — Criterios de aceptación

- [ ] `npm install` y `npx playwright install chromium` dejan el proyecto listo para ejecutar.
- [ ] La skill aparece en Claude Code y, invocada sin argumentos, pide las URLs antes de hacer nada.
- [ ] Invocada con dos URLs, genera dos carpetas en `reports/` con sufijos de dominio y fecha distintos.
- [ ] Durante la ejecución se ve una ventana de Chromium recorriendo el sitio.
- [ ] Cada ejecución arranca con perfil limpio: el inventario previo a aceptar el banner no contiene cookies de ejecuciones anteriores.
- [ ] Tras aceptar el banner, el inventario contiene más cookies que antes de aceptarlo.
- [ ] El inventario incluye al menos una cookie con `httpOnly` a `true` y al menos una de un dominio distinto al auditado, lo que demuestra que la lectura CDP funciona.
- [ ] El listado de `cookiesReales` coincide con el panel Application → Cookies del Chromium abierto, cookie a cookie.
- [ ] La skill llega a la página de cookies siguiendo el enlace del footer, sin que el usuario le dé la URL.
- [ ] `cookiesPanel` contiene cookies de más de una categoría tras desplegar las secciones.
- [ ] Una cookie declarada como `_ga_*` casa con `_ga_ABC123` presente en el navegador y sale con veredicto `Correcta`.
- [ ] `cookies.csv` contiene tres bloques con sus tres líneas de título.
- [ ] `correspondencia.csv` se abre en Excel en columnas separadas, sin pasar por el asistente de importación.
- [ ] Ninguna celda de los CSV contiene un valor de cookie de más de 40 caracteres.
- [ ] `informe.html` se abre offline con doble clic y muestra los conteos por severidad.
- [ ] Ante un sitio sin enlace de cookies en el footer, el script sale con código 2, la skill pregunta la URL al usuario y la ejecución continúa con la URL indicada.
- [ ] La incidencia resuelta por el usuario aparece registrada en el apartado de incidencias del informe.

---

## 6 — Decisiones tomadas y descartadas

- **Sí:** Playwright sobre Node ejecutado desde Claude Code. Es el único motor que da el almacén de cookies completo, y Claude Code tiene app de escritorio en Windows, así que no obliga a trabajar en terminal.
- **No:** app Claude Desktop conducida por un MCP de navegador. Era la preferencia inicial, pero sus skills corren en un sandbox sin acceso al Chrome local y ningún MCP estándar expone el almacén de cookies. Queda documentada como variante futura.
- **No:** inventario híbrido con `document.cookie` más cabeceras `Set-Cookie`. Alcanzaba buena cobertura, pero con un margen de error que no se puede medir: falsos «correcta» invisibles en una auditoría de cumplimiento.
- **No:** solo `document.cookie`. No ve HttpOnly ni terceros, justo lo más relevante.
- **No:** servidor MCP propio con acceso CDP al almacén. Cumpliría los requisitos, pero es un proyecto en sí mismo.
- **Sí:** `Network.getAllCookies` vía sesión CDP, en lugar de `context.cookies()` de Playwright. El primero devuelve el almacén entero; el segundo se limita al contexto.
- **Sí:** perfil limpio por ejecución. Sin él, las cookies de auditorías anteriores contaminarían el inventario.
- **Sí:** detección genérica del banner por texto y DOM. El objetivo es auditar sitios de clientes distintos, con CMP distintos.
- **No:** selectores atados a un CMP concreto. Más fiables, pero inservibles fuera de ese CMP.
- **Sí:** aceptar todas las cookies antes de inventariar. Provoca el escenario máximo, que es el que destapa más discrepancias.
- **No:** doble pasada rechazando y aceptando. Detecta incumplimientos reales, pero duplica el tiempo y complica el CSV. Queda para otra spec.
- **Sí:** cotejo por nombre con comodines. Es el único campo que casi todos los sitios declaran de forma fiable.
- **No:** cotejo por nombre más dominio y duración. Produciría mucho ruido, porque muchas páginas no declaran esos campos.
- **Sí:** esperar red inactiva y hacer scroll hasta el final antes de inventariar. Equilibrio razonable entre cobertura y tiempo.
- **Sí:** bloqueo con código de salida 2 y JSON estructurado, resuelto por la skill preguntando al usuario. Mantiene el script determinista y deja la interacción donde puede ocurrir.
- **Sí:** un CSV con tres bloques más un CSV matriz. El primero se lee, el segundo se filtra en Excel.
- **Sí:** punto y coma y BOM UTF-8 en los CSV. Excel en castellano los abre en columnas directamente.
- **Sí:** informe HTML único y autocontenido, sin CDN. Se abre con doble clic y se puede enviar por correo.
- **No:** informe markdown adicional. El HTML es el entregable presentable y los CSV cubren la trazabilidad.
- **Sí:** un informe por URL, en su propia carpeta con fecha. Aísla los fallos de una URL sin contaminar el resto.
- **Sí:** navegador visible. Algunos CMP se comportan distinto en headless y conviene poder mirar lo que hace.
- **Sí:** todo el código en Node. Evita arrastrar Python, que además está en la versión 3.14 y aún no lleva bien Playwright.

---

## 7 — Riesgos identificados

| Riesgo                                                                       | Mitigación                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Un sitio detecta la automatización y sirve un banner distinto o bloquea      | Chromium visible con perfil limpio y esperas realistas. Si se detecta, se registra la incidencia en el informe.    |
| La heurística genérica no encuentra el botón de aceptar en un CMP raro       | El script sale con bloqueo y la skill pregunta al usuario por el selector, que se pasa con `--selector-aceptar`.   |
| Un nombre declarado con comodín casa de más y oculta una cookie no declarada | El CSV matriz incluye la columna con el patrón que produjo la coincidencia, para poder revisarla.                  |
| Páginas de cookies que declaran las cookies en prosa y no en tabla           | La extracción recorre la página entera, no solo tablas. Si no encuentra estructura, emite bloqueo.                 |
| Cookies que solo aparecen en secciones internas del sitio                    | Asumido: esta spec audita la portada. Recorrer páginas internas queda fuera de alcance y se declara en el informe. |
| `npx playwright install` falla en un equipo sin permisos                     | El `README.md` documenta el requisito y el mensaje de error esperado.                                              |

---

## Lo que **no** entra en esta spec

- Segunda pasada rechazando el consentimiento.
- Comparación de duraciones y dominios como criterio de correspondencia.
- Navegación por páginas internas y capturas de evidencia.
- Modo headless para lotes grandes.
- Variante para la app Claude Desktop conducida por MCP.
- Inventario de `localStorage`, `sessionStorage` y fingerprinting.
- Informe agregado de varias URLs.

Cada uno de ellos, si entra alguna vez, va en su propia spec.
