# Detección de banner y elementos de consentimiento

Heurísticas genéricas de texto y DOM para localizar, sin depender de un CMP
concreto, las cuatro piezas del recorrido que necesita `audit.mjs`:

- El botón de aceptar del banner inicial (fase 1).
- El enlace a la política de cookies en el footer (fase 2).
- El botón que reabre el banner desde la página de cookies (fase 3).
- Las secciones/acordeones de categoría dentro del panel de configuración (fase 3).

Cobertura de idiomas: castellano e inglés únicamente, según el alcance de
[SPEC 01](../../../specs/01-auditoria-cookies-web.md).

`audit.mjs` lee el bloque JSON de más abajo en tiempo de ejecución (no copia
los patrones a mano), así que cualquier ajuste a una expresión regular se
hace aquí y no en el script.

## Botón de aceptar (fase 1)

Coincide con formas conjugadas de "aceptar" en vez de la palabra exacta,
porque los CMP usan indistintamente "Aceptar todas", "Acepto y continúo
gratis", "Aceptar cookies", etc. Se busca sobre elementos clicables
genéricos (`button`, `a`, `[role="button"]`, botones de formulario), no
sobre un selector fijo, porque cada CMP marca su botón con clases propias.

Algunos CMP difieren la carga del banner hasta la primera interacción del
usuario (ratón o scroll) para no penalizar métricas de rendimiento; por eso
`audit.mjs` dispara un movimiento de ratón y un scroll pequeño antes de
esperar a que el botón aparezca.

## Enlace de la política de cookies (fase 2)

Se busca en el footer un `<a>` cuyo texto contenga "cookie" (o su plural),
en vez de una URL fija tipo `/politica-de-cookies`, porque esa ruta varía
por sitio. El texto exacto del enlace también varía: "Política de cookies",
"Cookies", "Configuración de cookies" cuando el enlace hace ambas cosas a
la vez, "Cookie Policy", "Cookies Policy".

## Botón que reabre el banner (fase 3)

Desde la página de cookies, el botón para reabrir el banner suele llamarse
"Configurar cookies", "Configuración de cookies", "Preferencias de
cookies", "Cookie Settings", "Manage Cookies". Se distingue del enlace de
fase 2 en que aquí se busca dentro del contenido de la página de cookies ya
cargada, no en el footer.

## Secciones de categoría dentro del panel (fase 3)

Los acordeones de categoría suelen usar alguna de estas etiquetas, con
variantes de singular/plural y de mayúsculas:

- Necesarias / técnicas — "Necessary" / "Essential"
- Preferencias / funcionales — "Preferences" / "Functional"
- Estadísticas / analíticas — "Statistics" / "Analytics" / "Performance"
- Marketing / publicidad — "Marketing" / "Advertising" / "Targeting"

Cada sección se despliega con scroll antes de extraer sus cookies
declaradas, porque muchos paneles cargan el contenido de la sección al
hacerla visible.

Dentro de cada sección suele haber un acordeón adicional para ver el detalle
(cookies concretas o, cuando el CMP no baja a ese nivel, los terceros
asociados a esa categoría): "Ver terceros asociados", "Ver cookies",
"Mostrar detalles", "Show details", "View cookies", "View partners".

## Localización del panel abierto (fase 3)

El panel de configuración no siempre tiene un `id` o clase reconocible (cada
CMP lo nombra a su manera), así que `audit.mjs` no lo busca por selector.
En su lugar, parte del botón de aceptar del propio panel — que sigue
casando con el patrón `aceptar` de la fase 1 — y sube por sus ancestros
hasta encontrar uno cuyo texto acumulado sea sustancial (más de 200
caracteres): ese es el contenedor del panel, ni tan estrecho como el propio
botón ni tan amplio como toda la página. Buscar las secciones dentro de ese
contenedor, y no en todo el documento, evita confundir los títulos de
categoría del panel con títulos iguales que pueda tener la propia página de
cookies (p. ej. un apartado "Cookies técnicas" en el cuerpo del artículo).

## Patrones

```json
{
  "aceptar": {
    "patron": "acept\\w*|permitir\\s*todas?|estoy\\s*de\\s*acuerdo|accept\\s*(all)?|allow\\s*all|i\\s*agree|agree",
    "flags": "i",
    "selectorClicables": "button, a, [role=\"button\"], input[type=\"button\"], input[type=\"submit\"]"
  },
  "enlaceCookies": {
    "patron": "cookies?",
    "flags": "i",
    "notas": "Se aplica sobre enlaces <a> del footer, no sobre todo el DOM."
  },
  "reabrirBanner": {
    "patron": "configurar\\s*cookies|configuraci[oó]n\\s*de\\s*cookies|preferencias\\s*de\\s*cookies|cookie\\s*settings|manage\\s*cookies|gestionar\\s*cookies",
    "flags": "i"
  },
  "seccionCategoria": {
    "patron": "necesari[ao]s?|esencial(es)?|t[eé]cnic[ao]s?|preferencias?|funcional(es)?|estad[ií]sticas?|anal[ií]tica[s]?|analytics|performance|marketing|publicidad|advertising|targeting",
    "flags": "i",
    "notas": "Se aplica solo sobre encabezados (h1-h6): el nombre de un proveedor puede contener alguna de estas palabras (p. ej. \"Salesforce Marketing Cloud\") sin ser un título de categoría."
  },
  "expandirSeccion": {
    "patron": "ver\\s*terceros|ver\\s*(cookies|proveedores|detalles)|mostrar\\s*(m[aá]s|detalles|proveedores|cookies)|show\\s*(details|more)|view\\s*(cookies|partners|vendors)",
    "flags": "i"
  }
}
```
