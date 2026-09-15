#!/usr/bin/env node
// Recolector de la auditoría de cookies. Conduce Chromium con Playwright y
// vuelca los tres listados en auditoria.json. Ver SPEC 01.

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const DIR_SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(DIR_SCRIPTS, '../../../..');
const RUTA_DETECCION_BANNER = path.join(DIR_SCRIPTS, '../references/deteccion-banner.md');

// Las heurísticas de texto viven en references/deteccion-banner.md, no aquí:
// ese fichero documenta cada patrón y lleva el bloque JSON que se lee abajo.
async function cargarPatrones() {
  const contenido = await readFile(RUTA_DETECCION_BANNER, 'utf8');
  const bloque = contenido.match(/```json\s*([\s\S]*?)```/);
  if (!bloque) {
    throw new Error(`No se encontró el bloque de patrones JSON en ${RUTA_DETECCION_BANNER}`);
  }
  return JSON.parse(bloque[1]);
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

// Sello para el nombre de la carpeta de salida: YYYYMMDD-HHmm en hora local.
function sello(fecha) {
  return (
    `${fecha.getFullYear()}${dosDigitos(fecha.getMonth() + 1)}${dosDigitos(fecha.getDate())}` +
    `-${dosDigitos(fecha.getHours())}${dosDigitos(fecha.getMinutes())}`
  );
}

// ISO 8601 con el desfase local, no en UTC: 2026-09-15T10:32:00+02:00.
function isoLocal(fecha) {
  const desfase = -fecha.getTimezoneOffset();
  const signo = desfase >= 0 ? '+' : '-';
  const absoluto = Math.abs(desfase);
  return (
    `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}` +
    `T${dosDigitos(fecha.getHours())}:${dosDigitos(fecha.getMinutes())}:${dosDigitos(fecha.getSeconds())}` +
    `${signo}${dosDigitos(Math.floor(absoluto / 60))}:${dosDigitos(absoluto % 60)}`
  );
}

function leerArgumentos() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      salida: { type: 'string' },
      'cookies-url': { type: 'string' },
      'selector-aceptar': { type: 'string' },
      'selector-reabrir': { type: 'string' },
      'texto-reabrir': { type: 'string' },
    },
  });

  if (!values.url) {
    console.error('Falta --url. Uso: node audit.mjs --url https://ejemplo.com');
    process.exit(1);
  }

  // Aceptamos "ejemplo.com" sin protocolo para no obligar a escribirlo.
  const bruta = /^https?:\/\//i.test(values.url) ? values.url : `https://${values.url}`;

  let url;
  try {
    url = new URL(bruta);
  } catch {
    console.error(`La URL no es válida: ${values.url}`);
    process.exit(1);
  }

  return {
    url: url.href,
    dominio: url.hostname,
    salida: values.salida ?? null,
    cookiesUrl: values['cookies-url'] ?? null,
    selectorAceptar: values['selector-aceptar'] ?? null,
    selectorReabrir: values['selector-reabrir'] ?? null,
    textoReabrir: values['texto-reabrir'] ?? null,
  };
}

function escaparRegExp(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Algunos CMP difieren la carga del banner hasta la primera interacción del
// usuario (ratón o scroll), para no penalizar métricas de rendimiento. Sin
// esto el banner puede tardar más de 20 s en aparecer o no llegar a cargarse.
async function dispararInteraccion(pagina) {
  await pagina.mouse.move(400, 300);
  await pagina.mouse.move(600, 400);
  await pagina.mouse.wheel(0, 200);
}

// Localiza y pulsa el botón de aceptar del banner de cookies.
// Devuelve true si lo encontró y pulsó, false si no apareció ninguno.
async function aceptarBanner(pagina, selectorAceptar, patrones) {
  await dispararInteraccion(pagina);

  const candidato = selectorAceptar
    ? pagina.locator(selectorAceptar).first()
    : pagina
        .locator(patrones.aceptar.selectorClicables)
        .filter({ hasText: new RegExp(patrones.aceptar.patron, patrones.aceptar.flags) })
        .first();

  try {
    await candidato.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return false;
  }

  await candidato.click();
  return true;
}

// Recorre la página con scroll hasta el final, dando tiempo a que el contenido
// perezoso se cargue, en vez de saltar directo a scrollHeight.
async function scrollHastaElFinal(pagina) {
  await pagina.evaluate(async () => {
    const paso = Math.max(window.innerHeight, 400);
    let posicionAnterior = -1;
    while (window.scrollY !== posicionAnterior) {
      posicionAnterior = window.scrollY;
      window.scrollBy(0, paso);
      await new Promise((resuelve) => setTimeout(resuelve, 200));
    }
  });
}

// Best-effort: sitios con publicidad o telemetría continua no llegan nunca a
// red inactiva real, así que un timeout aquí no debe tumbar la auditoría.
async function esperarRedInactiva(pagina, timeout = 15000) {
  try {
    await pagina.waitForLoadState('networkidle', { timeout });
  } catch {
    console.warn(`La red no llegó a quedar inactiva en ${timeout} ms; se continúa igualmente.`);
  }
}

// Busca en el footer (o en algún contenedor con pinta de footer) el enlace
// cuyo texto contenga "cookie" y lo sigue con un clic, en vez de leer su
// atributo href: algunos sitios navegan por JS sin href (visto en 35mm.es,
// donde el enlace real del footer es un <a> sin href y solo el clic lleva a
// la página de cookies). `[class*="footer"]` también casa con elementos
// ajenos al footer real, y dentro del footer real puede haber más de un
// elemento con ese texto, así que se prueban todos hasta que uno navegue de
// verdad. Devuelve la URL de destino o null si ninguno navega.
async function localizarEnlaceCookies(pagina, patrones) {
  const patron = new RegExp(patrones.enlaceCookies.patron, patrones.enlaceCookies.flags);
  const contenedores = await pagina.locator('footer, [class*="footer" i], [id*="footer" i]').all();
  const urlOriginal = pagina.url();

  for (const contenedor of contenedores) {
    const candidatos = await contenedor.locator('a').filter({ hasText: patron }).all();
    for (const candidato of candidatos) {
      try {
        await candidato.click({ force: true, timeout: 5000 });
      } catch {
        continue;
      }
      await pagina.waitForTimeout(800);
      if (pagina.url() !== urlOriginal) return pagina.url();
    }
  }

  return null;
}

// Rutas habituales de la página de cookies en sitios en castellano/inglés.
// Respaldo cuando no se encuentra (o no navega) el enlace del footer, antes
// de bloquear y preguntar la URL al usuario.
const RUTAS_COOKIES_COMUNES = [
  'politica-de-cookies',
  'politica-cookies',
  'cookie-policy',
  'cookies-policy',
  'cookies',
];

async function intentarRutasComunes(pagina, urlBase) {
  for (const ruta of RUTAS_COOKIES_COMUNES) {
    const candidata = new URL(`/${ruta}/`, urlBase).href;
    try {
      const respuesta = await pagina.goto(candidata, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Muchos WordPress redirigen una ruta inexistente a la portada con 200:
      // si el resultado es la raíz del sitio, no es una página de cookies real.
      if (respuesta?.ok() && new URL(pagina.url()).pathname !== '/') {
        return pagina.url();
      }
    } catch {
      // Ruta no navegable; probar la siguiente.
    }
  }

  return null;
}

// Extrae de la página de cookies todas las tablas reconocibles como listados
// de cookies, recorriendo la página entera y no solo la primera tabla.
async function extraerCookiesPagina(pagina) {
  return pagina.evaluate(() => {
    const textoLimpio = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const mapaCampos = {
      // "nombre": una cookie por fila. "lista": una fila por proveedor con
      // varios nombres separados por comas (patrón habitual en CMP genéricos).
      nombre: /^(cookie|nombre|name)$/i,
      lista: /^(listado|lista|cookies)$/i,
      categoria: /^(categor[ií]a|tipo|type|category)$/i,
      proveedor: /^(proveedor|provider|responsable|dominio|domain)$/i,
      duracion: /^(duraci[oó]n|caducidad|expiraci[oó]n|expiry|duration|retention|per[ií]odo)$/i,
      finalidad: /^(finalidad|prop[oó]sito|descripci[oó]n|purpose|description)$/i,
    };

    const resultado = [];

    Array.from(document.querySelectorAll('table')).forEach((tabla, indice) => {
      const filas = Array.from(tabla.querySelectorAll('tr'));
      if (filas.length < 2) return;

      const encabezados = Array.from(filas[0].querySelectorAll('th, td')).map(textoLimpio);
      const indices = {};
      encabezados.forEach((encabezado, i) => {
        for (const [campo, patron] of Object.entries(mapaCampos)) {
          if (patron.test(encabezado)) indices[campo] = i;
        }
      });

      if (indices.nombre === undefined && indices.lista === undefined) return; // tabla no reconocible

      let tablaOrigen = null;
      let nodo = tabla.previousElementSibling;
      for (let saltos = 0; nodo && saltos < 6 && !tablaOrigen; saltos++, nodo = nodo.previousElementSibling) {
        if (/^H[1-6]$/.test(nodo.tagName)) tablaOrigen = textoLimpio(nodo);
      }
      tablaOrigen ??= `Tabla ${indice + 1}`;

      filas.slice(1).forEach((fila) => {
        const celdas = Array.from(fila.querySelectorAll('td, th')).map(textoLimpio);

        const comunes = {
          categoria: indices.categoria !== undefined ? celdas[indices.categoria] || null : null,
          proveedor: indices.proveedor !== undefined ? celdas[indices.proveedor] || null : null,
          duracion: indices.duracion !== undefined ? celdas[indices.duracion] || null : null,
          finalidad: indices.finalidad !== undefined ? celdas[indices.finalidad] || null : null,
          tablaOrigen,
        };

        if (indices.lista !== undefined) {
          const nombres = (celdas[indices.lista] || '')
            .split(/[,;]/)
            .map((n) => n.trim())
            .filter(Boolean);
          nombres.forEach((nombre) => resultado.push({ nombre, ...comunes }));
        } else {
          const nombre = celdas[indices.nombre];
          if (nombre) resultado.push({ nombre, ...comunes });
        }
      });
    });

    return resultado;
  });
}

// Pulsa el botón que reabre el banner (o, dentro de él, el enlace que entra
// en la configuración). Reutiliza el mismo patrón para ambos clics: el
// primero encuentra "Configurar cookies" en la página de cookies, el
// segundo "Configuración de cookies" ya dentro del banner reabierto.
async function pulsarSegunPatron(pagina, patron, { selector = null, texto = null, timeout = 8000 } = {}) {
  const patronEfectivo = texto ? new RegExp(escaparRegExp(texto), 'i') : patron;
  const candidato = selector
    ? pagina.locator(selector).first()
    : pagina.locator('button, a, [role="button"]').filter({ hasText: patronEfectivo }).first();

  try {
    await candidato.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }

  // force: la propia web deja a veces una capa (p. ej. un overlay de cookies
  // en transición) por encima del botón aunque este ya sea visible; la
  // comprobación de visibilidad de arriba es suficiente garantía.
  await candidato.click({ force: true });
  return true;
}

// Hace scroll hasta el final de cualquier contenedor interno desplazable
// (no solo la ventana), porque el panel de configuración suele vivir en un
// div con su propio scroll y algunos CMP cargan secciones al alcanzar el
// final.
async function scrollContenedoresInternos(pagina) {
  await pagina.evaluate(async () => {
    const contenedores = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.scrollHeight > el.clientHeight + 20
    );
    for (const contenedor of contenedores) {
      let anterior = -1;
      for (let intentos = 0; contenedor.scrollTop !== anterior && intentos < 20; intentos++) {
        anterior = contenedor.scrollTop;
        contenedor.scrollTop = contenedor.scrollHeight;
        await new Promise((resuelve) => setTimeout(resuelve, 150));
      }
    }
  });
}

// Extrae las cookies (o, a falta de detalle, los terceros) declarados por
// categoría en el panel de configuración ya abierto.
async function extraerCookiesPanel(pagina, patrones) {
  const patronAceptar = new RegExp(patrones.aceptar.patron, patrones.aceptar.flags);
  const patronExpandir = new RegExp(patrones.expandirSeccion.patron, patrones.expandirSeccion.flags);

  // Desplegar los acordeones de detalle de cada sección antes de leer nada.
  const expansores = await pagina.getByText(patronExpandir).all();
  for (const expansor of expansores) {
    try {
      await expansor.click({ timeout: 3000 });
    } catch {
      // Ya desplegado, o el texto pertenece a un nodo no clicable directamente.
    }
  }

  await scrollContenedoresInternos(pagina);

  return pagina.evaluate(
    ({ fuentePatronAceptar, flagsAceptar, fuentePatronSeccion, flagsSeccion }) => {
      const textoLimpio = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const patronAceptar = new RegExp(fuentePatronAceptar, flagsAceptar);
      const patronSeccion = new RegExp(fuentePatronSeccion, flagsSeccion);

      // El panel no tiene un selector fijo: se localiza subiendo desde el
      // botón de aceptar del propio panel hasta un ancestro con texto
      // sustancial, para no confundirlo ni con el botón ni con la página
      // entera. Ver references/deteccion-banner.md.
      const clicables = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const botonAceptar = clicables.find(
        (el) => patronAceptar.test(textoLimpio(el)) && el.offsetParent !== null
      );
      if (!botonAceptar) return [];

      let raizPanel = botonAceptar;
      while (raizPanel.parentElement && textoLimpio(raizPanel).length < 200) {
        raizPanel = raizPanel.parentElement;
      }

      const nodos = Array.from(raizPanel.querySelectorAll('*'));

      const vistos = new Set();
      const secciones = [];
      nodos.forEach((el) => {
        // Solo encabezados: el nombre de un proveedor puede contener una
        // palabra de categoría (p. ej. "Salesforce Marketing Cloud") sin
        // ser un título de sección.
        if (!/^H[1-6]$/.test(el.tagName)) return;
        const texto = textoLimpio(el);
        if (!texto || texto.length > 60 || vistos.has(texto)) return;
        if (!patronSeccion.test(texto)) return;
        vistos.add(texto);
        secciones.push({ texto, indice: nodos.indexOf(el) });
      });

      const mapaCampos = {
        nombre: /^(cookie|nombre|name)$/i,
        lista: /^(listado|lista|cookies)$/i,
        proveedor: /^(proveedor|provider|responsable|dominio|domain)$/i,
        duracion: /^(duraci[oó]n|caducidad|expiraci[oó]n|expiry|duration|retention|per[ií]odo)$/i,
        finalidad: /^(finalidad|prop[oó]sito|descripci[oó]n|purpose|description)$/i,
      };

      const resultado = [];

      secciones.forEach(({ texto: seccion, indice }, i) => {
        const finRango = i + 1 < secciones.length ? secciones[i + 1].indice : nodos.length;
        const nodosSeccion = nodos.slice(indice, finRango);

        const entradas = [];

        nodosSeccion
          .filter((n) => n.tagName === 'TABLE')
          .forEach((tabla) => {
            const filas = Array.from(tabla.querySelectorAll('tr'));
            if (filas.length < 2) return;
            const encabezados = Array.from(filas[0].querySelectorAll('th, td')).map(textoLimpio);
            const indices = {};
            encabezados.forEach((encabezado, idx) => {
              for (const [campo, patron] of Object.entries(mapaCampos)) {
                if (patron.test(encabezado)) indices[campo] = idx;
              }
            });
            if (indices.nombre === undefined && indices.lista === undefined) return;

            filas.slice(1).forEach((fila) => {
              const celdas = Array.from(fila.querySelectorAll('td, th')).map(textoLimpio);
              const comunes = {
                proveedor: indices.proveedor !== undefined ? celdas[indices.proveedor] || null : null,
                duracion: indices.duracion !== undefined ? celdas[indices.duracion] || null : null,
                finalidad: indices.finalidad !== undefined ? celdas[indices.finalidad] || null : null,
              };
              if (indices.lista !== undefined) {
                (celdas[indices.lista] || '')
                  .split(/[,;]/)
                  .map((n) => n.trim())
                  .filter(Boolean)
                  .forEach((nombre) => entradas.push({ nombre, ...comunes }));
              } else if (celdas[indices.nombre]) {
                entradas.push({ nombre: celdas[indices.nombre], ...comunes });
              }
            });
          });

        // Sin tabla: el CMP solo declara los terceros de la categoría, no
        // cookies individuales. Es la mejor aproximación disponible y, si
        // el sitio debería declarar más detalle, la propia falta de
        // granularidad queda reflejada como discrepancia en el informe.
        if (entradas.length === 0) {
          nodosSeccion
            .filter((n) => n.tagName === 'LI')
            .forEach((li) => {
              const nombre = textoLimpio(li);
              if (nombre) entradas.push({ nombre, proveedor: nombre, duracion: null, finalidad: null });
            });
        }

        entradas.forEach((entrada) => {
          resultado.push({
            nombre: entrada.nombre,
            categoria: seccion,
            proveedor: entrada.proveedor,
            duracion: entrada.duracion,
            finalidad: entrada.finalidad,
            seccion,
          });
        });
      });

      return resultado;
    },
    {
      fuentePatronAceptar: patronAceptar.source,
      flagsAceptar: patronAceptar.flags,
      fuentePatronSeccion: patrones.seccionCategoria.patron,
      flagsSeccion: patrones.seccionCategoria.flags,
    }
  );
}

// ISO 8601 en hora local a partir de un timestamp CDP en segundos.
function isoDesdeEpochSegundos(segundos) {
  return isoLocal(new Date(segundos * 1000));
}

// Lee el almacén de cookies completo vía CDP (Network.getAllCookies), la
// misma fuente que alimenta el panel Application → Cookies de DevTools.
// context.cookies() de Playwright no sirve: se limita a las del contexto y
// no ve HttpOnly de terceros con el mismo detalle.
async function inventariarCookiesReales(contexto, pagina) {
  const sesionCdp = await contexto.newCDPSession(pagina);
  const { cookies } = await sesionCdp.send('Network.getAllCookies');
  await sesionCdp.detach();

  return cookies.map((cookie) => ({
    nombre: cookie.name,
    valor: cookie.value,
    dominio: cookie.domain,
    path: cookie.path,
    expira: cookie.session || !cookie.expires || cookie.expires <= 0
      ? 'sesión'
      : isoDesdeEpochSegundos(cookie.expires),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? null,
  }));
}

// Señal de bloqueo: una fase no encontró su pieza y hace falta que el
// usuario resuelva la incidencia (skill) antes de relanzar el script.
class Bloqueo extends Error {
  constructor(bloqueo, fase, descripcion) {
    super(descripcion);
    this.bloqueo = bloqueo;
    this.fase = fase;
    this.descripcion = descripcion;
  }
}

function auditoriaVacia(opciones, fecha) {
  return {
    url: opciones.url,
    dominio: opciones.dominio,
    timestamp: isoLocal(fecha),
    urlPaginaCookies: null,
    cookiesReales: [],
    cookiesPagina: [],
    cookiesPanel: [],
    incidencias: [],
  };
}

async function main() {
  const opciones = leerArgumentos();
  const patrones = await cargarPatrones();
  const fecha = new Date();
  const auditoria = auditoriaVacia(opciones, fecha);

  // Perfil limpio: un contexto efímero por ejecución, nunca launchPersistentContext.
  // Sin esto, las cookies de auditorías anteriores contaminarían el inventario.
  const navegador = await chromium.launch({ headless: false });
  const contexto = await navegador.newContext();

  try {
    const pagina = await contexto.newPage();
    await pagina.setViewportSize({ width: 1440, height: 900 });

    // Fase 1: cargar la URL, aceptar el banner y asentar la página antes de
    // inventariar cookies (el inventario CDP llega en el paso 5).
    await pagina.goto(opciones.url, { waitUntil: 'domcontentloaded' });

    const bannerAceptado = await aceptarBanner(pagina, opciones.selectorAceptar, patrones);
    if (!bannerAceptado) {
      throw new Bloqueo(
        'banner-no-encontrado',
        1,
        'No se encontró el botón de aceptar del banner de cookies. Resuélvelo indicando el selector con --selector-aceptar.'
      );
    }
    console.log('Banner de cookies aceptado.');

    await esperarRedInactiva(pagina);
    await scrollHastaElFinal(pagina);

    // Paso 5: inventario CDP del almacén completo de cookies.
    auditoria.cookiesReales = await inventariarCookiesReales(contexto, pagina);
    console.log(`Cookies reales inventariadas: ${auditoria.cookiesReales.length}`);

    // Fase 2: localizar la página de cookies y extraer sus listados. Si no
    // se encuentra (o no navega) el enlace del footer, probar rutas
    // habituales antes de bloquear y preguntar la URL al usuario.
    const urlCookies =
      opciones.cookiesUrl ??
      (await localizarEnlaceCookies(pagina, patrones)) ??
      (await intentarRutasComunes(pagina, opciones.url));
    if (!urlCookies) {
      throw new Bloqueo(
        'pagina-cookies-no-encontrada',
        2,
        'No se encontró el enlace a la política de cookies en el footer ni en rutas habituales. Indica la URL con --cookies-url.'
      );
    }

    auditoria.urlPaginaCookies = urlCookies;
    await pagina.goto(urlCookies, { waitUntil: 'domcontentloaded' });
    await esperarRedInactiva(pagina);
    await scrollHastaElFinal(pagina);

    auditoria.cookiesPagina = await extraerCookiesPagina(pagina);
    console.log(`Cookies declaradas en la página de cookies: ${auditoria.cookiesPagina.length}`);

    // Fase 3: reabrir el banner desde esta misma página, entrar en su
    // configuración y extraer lo declarado por categoría.
    const patronReabrir = new RegExp(patrones.reabrirBanner.patron, patrones.reabrirBanner.flags);
    const bannerReabierto = await pulsarSegunPatron(pagina, patronReabrir, {
      selector: opciones.selectorReabrir,
      texto: opciones.textoReabrir,
    });
    if (!bannerReabierto) {
      throw new Bloqueo(
        'boton-reabrir-no-encontrado',
        3,
        'No se encontró el botón que reabre el banner de cookies desde la página de cookies (se esperaba un texto como «Configurar cookies»). Indica el texto exacto del botón con --texto-reabrir, o un selector CSS con --selector-reabrir.'
      );
    }

    const entradoEnConfiguracion = await pulsarSegunPatron(pagina, patronReabrir);
    if (!entradoEnConfiguracion) {
      throw new Bloqueo(
        'panel-configuracion-no-encontrado',
        3,
        'No se encontró «Configuración de cookies» dentro del banner reabierto. Indica el selector con --selector-reabrir.'
      );
    }

    await scrollContenedoresInternos(pagina);
    auditoria.cookiesPanel = await extraerCookiesPanel(pagina, patrones);
    console.log(`Cookies/terceros declarados en el panel: ${auditoria.cookiesPanel.length}`);
  } finally {
    await contexto.close();
    await navegador.close();
  }

  const dirSalida =
    opciones.salida ?? path.join(RAIZ, 'reports', `${opciones.dominio}-${sello(fecha)}`);
  await mkdir(dirSalida, { recursive: true });

  const rutaJson = path.join(dirSalida, 'auditoria.json');
  await writeFile(rutaJson, `${JSON.stringify(auditoria, null, 2)}\n`, 'utf8');

  console.log(`Carpeta de salida: ${dirSalida}`);
  console.log(`Auditoría escrita: ${rutaJson}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof Bloqueo) {
    console.log(JSON.stringify({ bloqueo: error.bloqueo, fase: error.fase, descripcion: error.descripcion }));
    process.exitCode = 2;
  } else {
    throw error;
  }
}
