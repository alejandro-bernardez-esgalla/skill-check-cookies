#!/usr/bin/env node
// Genera los CSV de la auditoría a partir de auditoria.json. Ver SPEC 01.

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR_SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RUTA_PLANTILLA_INFORME = path.join(DIR_SCRIPTS, 'plantilla_informe.html');

const SEPARADOR = ';';
const BOM = '﻿';
const LONGITUD_MAXIMA_VALOR = 40;

const RANGO_SEVERIDAD = { Crítica: 0, Alta: 1, Media: 2, '—': 3 };

const TABLA_VEREDICTOS = {
  'true,false,false': { veredicto: 'No declarada', severidad: 'Crítica' },
  'true,true,false': { veredicto: 'Ausente en el panel del banner', severidad: 'Alta' },
  'true,false,true': { veredicto: 'Ausente en la página de cookies', severidad: 'Alta' },
  'true,true,true': { veredicto: 'Correcta', severidad: '—' },
  'false,true,true': { veredicto: 'Declarada y no presente', severidad: 'Media' },
  'false,true,false': { veredicto: 'Declarada solo en la página', severidad: 'Media' },
  'false,false,true': { veredicto: 'Declarada solo en el panel', severidad: 'Media' },
};

function leerArgumentos() {
  const { values } = parseArgs({
    options: {
      auditoria: { type: 'string' },
    },
  });

  if (!values.auditoria) {
    console.error('Falta --auditoria. Uso: node build_report.mjs --auditoria ruta/auditoria.json');
    process.exit(1);
  }

  return { rutaAuditoria: path.resolve(values.auditoria) };
}

function normalizar(nombre) {
  return (nombre ?? '').trim();
}

// Un nombre declarado con "*" o un marcador "<...>" es un patrón que casa
// por prefijo: "_ga_*" o "_ga_<id>" casan con "_ga_ABC123".
function esPatron(nombre) {
  return nombre.includes('*') || nombre.includes('<');
}

function prefijoDePatron(nombre) {
  const indice = Math.min(
    ...['*', '<'].map((marca) => (nombre.includes(marca) ? nombre.indexOf(marca) : Infinity))
  );
  return nombre.slice(0, indice);
}

function coincide(declarado, real) {
  const declaradoNormalizado = normalizar(declarado);
  if (esPatron(declaradoNormalizado)) {
    return real.startsWith(prefijoDePatron(declaradoNormalizado));
  }
  return declaradoNormalizado === real;
}

function categoriasDe(declaraciones) {
  return [...new Set(declaraciones.map((d) => d.categoria).filter(Boolean))];
}

function construirFila(nombre, presente, enPaginaMatches, enPanelMatches) {
  const enPagina = enPaginaMatches.length > 0;
  const enPanel = enPanelMatches.length > 0;

  const clave = `${presente},${enPagina},${enPanel}`;
  const base = TABLA_VEREDICTOS[clave];
  const veredictos = [base.veredicto];
  let severidad = base.severidad;

  // Misma cookie declarada en página y panel con categoría distinta: se
  // marca aparte, aunque el resto de la fila sea correcto.
  if (enPagina && enPanel) {
    const categoriasPagina = categoriasDe(enPaginaMatches);
    const categoriasPanel = categoriasDe(enPanelMatches);
    const hayIncoherencia =
      categoriasPagina.length > 0 &&
      categoriasPanel.length > 0 &&
      !categoriasPagina.some((c) => categoriasPanel.includes(c));

    if (hayIncoherencia) {
      veredictos.push('Categoría incoherente');
      severidad = 'Alta';
    }
  }

  const patronesCoincidentes = [
    ...new Set(
      [...enPaginaMatches, ...enPanelMatches]
        .map((d) => normalizar(d.nombre))
        .filter((declarado) => esPatron(declarado) && declarado !== nombre)
    ),
  ];

  return {
    nombre,
    presente: presente ? 'sí' : 'no',
    enPagina: enPagina ? 'sí' : 'no',
    enPanel: enPanel ? 'sí' : 'no',
    categoriaPagina: categoriasDe(enPaginaMatches).join(', ') || null,
    categoriaPanel: categoriasDe(enPanelMatches).join(', ') || null,
    veredicto: veredictos.join('; '),
    severidad,
    patron: patronesCoincidentes.join(', ') || null,
  };
}

// Construye la matriz de correspondencia: primero una fila por cada nombre
// de cookie real (cotejando comodines contra los dos listados declarados),
// y luego una fila por cada declaración que no haya casado con ninguna
// cookie real (agrupando página y panel cuando declaran el mismo texto).
function calcularCorrespondencia(auditoria) {
  const nombresReales = [...new Set(auditoria.cookiesReales.map((c) => normalizar(c.nombre)))];

  const paginaUsada = new Set();
  const panelUsado = new Set();
  const filas = [];

  nombresReales.forEach((nombre) => {
    const enPaginaMatches = auditoria.cookiesPagina.filter((d) => coincide(d.nombre, nombre));
    const enPanelMatches = auditoria.cookiesPanel.filter((d) => coincide(d.nombre, nombre));
    enPaginaMatches.forEach((d) => paginaUsada.add(d));
    enPanelMatches.forEach((d) => panelUsado.add(d));

    filas.push(construirFila(nombre, true, enPaginaMatches, enPanelMatches));
  });

  const restantesPagina = auditoria.cookiesPagina.filter((d) => !paginaUsada.has(d));
  const restantesPanel = auditoria.cookiesPanel.filter((d) => !panelUsado.has(d));

  const nombresRestantes = [
    ...new Set([...restantesPagina, ...restantesPanel].map((d) => normalizar(d.nombre))),
  ];

  nombresRestantes.forEach((nombre) => {
    const enPaginaMatches = restantesPagina.filter((d) => normalizar(d.nombre) === nombre);
    const enPanelMatches = restantesPanel.filter((d) => normalizar(d.nombre) === nombre);
    filas.push(construirFila(nombre, false, enPaginaMatches, enPanelMatches));
  });

  filas.sort((a, b) => {
    const diferenciaSeveridad = RANGO_SEVERIDAD[a.severidad] - RANGO_SEVERIDAD[b.severidad];
    return diferenciaSeveridad !== 0 ? diferenciaSeveridad : a.nombre.localeCompare(b.nombre);
  });

  return filas;
}

function celda(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  if (texto.includes(SEPARADOR) || texto.includes('"') || texto.includes('\n')) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function filaCsv(valores) {
  return valores.map(celda).join(SEPARADOR);
}

function truncarValor(valor) {
  const texto = valor ?? '';
  return texto.length > LONGITUD_MAXIMA_VALOR ? texto.slice(0, LONGITUD_MAXIMA_VALOR) : texto;
}

function construirCookiesCsv(auditoria) {
  const bloques = [
    {
      titulo: 'COOKIES REALES (navegador)',
      cabecera: ['nombre', 'valor', 'dominio', 'path', 'expira', 'httpOnly', 'secure', 'sameSite'],
      filas: auditoria.cookiesReales.map((c) => [
        c.nombre,
        truncarValor(c.valor),
        c.dominio,
        c.path,
        c.expira,
        c.httpOnly,
        c.secure,
        c.sameSite,
      ]),
    },
    {
      titulo: 'COOKIES DECLARADAS EN LA PÁGINA DE COOKIES',
      cabecera: ['nombre', 'categoria', 'proveedor', 'duracion', 'finalidad', 'tablaOrigen'],
      filas: auditoria.cookiesPagina.map((c) => [
        c.nombre,
        c.categoria,
        c.proveedor,
        c.duracion,
        c.finalidad,
        c.tablaOrigen,
      ]),
    },
    {
      titulo: 'COOKIES DECLARADAS EN EL PANEL DE CONFIGURACIÓN',
      cabecera: ['nombre', 'categoria', 'proveedor', 'duracion', 'finalidad', 'seccion'],
      filas: auditoria.cookiesPanel.map((c) => [
        c.nombre,
        c.categoria,
        c.proveedor,
        c.duracion,
        c.finalidad,
        c.seccion,
      ]),
    },
  ];

  const lineas = [];
  bloques.forEach((bloque, indice) => {
    if (indice > 0) lineas.push('');
    lineas.push(celda(bloque.titulo));
    lineas.push(filaCsv(bloque.cabecera));
    bloque.filas.forEach((fila) => lineas.push(filaCsv(fila)));
  });

  return `${BOM}${lineas.join('\r\n')}\r\n`;
}

function construirCorrespondenciaCsv(filas) {
  const cabecera = [
    'nombre',
    'presente',
    'enPagina',
    'enPanel',
    'categoriaPagina',
    'categoriaPanel',
    'veredicto',
    'severidad',
    'patron',
  ];

  const lineas = [filaCsv(cabecera)];
  filas.forEach((fila) =>
    lineas.push(
      filaCsv([
        fila.nombre,
        fila.presente,
        fila.enPagina,
        fila.enPanel,
        fila.categoriaPagina,
        fila.categoriaPanel,
        fila.veredicto,
        fila.severidad,
        fila.patron,
      ])
    )
  );

  return `${BOM}${lineas.join('\r\n')}\r\n`;
}

function escaparHtml(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CLASE_SEVERIDAD = {
  Crítica: 'severidad-critica',
  Alta: 'severidad-alta',
  Media: 'severidad-media',
};

function construirTablaDiscrepancias(filas) {
  const discrepancias = filas.filter((fila) => fila.severidad !== '—');
  if (discrepancias.length === 0) {
    return '<p class="vacio">Sin discrepancias: las tres bandas coinciden en todas las cookies.</p>';
  }

  const filasHtml = discrepancias
    .map((fila) => {
      const claseSeveridad = CLASE_SEVERIDAD[fila.severidad] ?? '';
      return `      <tr>
        <td>${escaparHtml(fila.nombre)}</td>
        <td>${escaparHtml(fila.presente)}</td>
        <td>${escaparHtml(fila.enPagina)}</td>
        <td>${escaparHtml(fila.enPanel)}</td>
        <td>${escaparHtml(fila.categoriaPagina)}</td>
        <td>${escaparHtml(fila.categoriaPanel)}</td>
        <td>${escaparHtml(fila.veredicto)}</td>
        <td class="${claseSeveridad}">${escaparHtml(fila.severidad)}</td>
        <td>${escaparHtml(fila.patron)}</td>
      </tr>`;
    })
    .join('\n');

  return `  <table>
    <caption>${discrepancias.length} de ${filas.length} cookies con alguna discrepancia</caption>
    <thead>
      <tr>
        <th>Nombre</th><th>Presente</th><th>En página</th><th>En panel</th>
        <th>Categoría (página)</th><th>Categoría (panel)</th><th>Veredicto</th><th>Severidad</th><th>Patrón</th>
      </tr>
    </thead>
    <tbody>
${filasHtml}
    </tbody>
  </table>`;
}

function construirTablaIncidencias(incidencias) {
  if (!incidencias || incidencias.length === 0) {
    return '<p class="vacio">Sin incidencias registradas.</p>';
  }

  const filasHtml = incidencias
    .map(
      (incidencia) => `      <tr>
        <td>${escaparHtml(incidencia.fase)}</td>
        <td>${escaparHtml(incidencia.descripcion)}</td>
        <td>${escaparHtml(incidencia.resolucionUsuario)}</td>
      </tr>`
    )
    .join('\n');

  return `  <table>
    <thead>
      <tr><th>Fase</th><th>Descripción</th><th>Resolución</th></tr>
    </thead>
    <tbody>
${filasHtml}
    </tbody>
  </table>`;
}

function calcularSemaforo(conteoPorSeveridad) {
  if (conteoPorSeveridad.Crítica > 0) {
    return { clase: 'rojo', texto: 'Crítico: hay cookies presentes sin declarar' };
  }
  if (conteoPorSeveridad.Alta > 0) {
    return { clase: 'naranja', texto: 'Atención: hay discrepancias de severidad alta' };
  }
  if (conteoPorSeveridad.Media > 0) {
    return { clase: 'amarillo', texto: 'Revisar: hay discrepancias menores' };
  }
  return { clase: 'verde', texto: 'Correcto: las tres bandas coinciden' };
}

async function generarInformeHtml(auditoria, correspondencia, conteoPorSeveridad) {
  const plantilla = await readFile(RUTA_PLANTILLA_INFORME, 'utf8');
  const semaforo = calcularSemaforo(conteoPorSeveridad);

  const reemplazos = {
    DOMINIO: escaparHtml(auditoria.dominio),
    URL: escaparHtml(auditoria.url),
    URL_PAGINA_COOKIES: escaparHtml(auditoria.urlPaginaCookies ?? '(no encontrada)'),
    TIMESTAMP: escaparHtml(auditoria.timestamp),
    SEMAFORO_CLASE: semaforo.clase,
    SEMAFORO_TEXTO: semaforo.texto,
    CONTEO_CRITICA: conteoPorSeveridad.Crítica ?? 0,
    CONTEO_ALTA: conteoPorSeveridad.Alta ?? 0,
    CONTEO_MEDIA: conteoPorSeveridad.Media ?? 0,
    CONTEO_CORRECTA: conteoPorSeveridad['—'] ?? 0,
    TABLA_DISCREPANCIAS: construirTablaDiscrepancias(correspondencia),
    TABLA_INCIDENCIAS: construirTablaIncidencias(auditoria.incidencias),
  };

  return Object.entries(reemplazos).reduce(
    (html, [token, valor]) => html.replaceAll(`{{${token}}}`, () => String(valor)),
    plantilla
  );
}

async function main() {
  const { rutaAuditoria } = leerArgumentos();
  const dirSalida = path.dirname(rutaAuditoria);

  const auditoria = JSON.parse(await readFile(rutaAuditoria, 'utf8'));
  const correspondencia = calcularCorrespondencia(auditoria);

  const rutaCookiesCsv = path.join(dirSalida, 'cookies.csv');
  const rutaCorrespondenciaCsv = path.join(dirSalida, 'correspondencia.csv');

  await writeFile(rutaCookiesCsv, construirCookiesCsv(auditoria), 'utf8');
  await writeFile(rutaCorrespondenciaCsv, construirCorrespondenciaCsv(correspondencia), 'utf8');

  const conteoPorSeveridad = correspondencia.reduce((conteo, fila) => {
    conteo[fila.severidad] = (conteo[fila.severidad] ?? 0) + 1;
    return conteo;
  }, {});

  const rutaInformeHtml = path.join(dirSalida, 'informe.html');
  const informeHtml = await generarInformeHtml(auditoria, correspondencia, conteoPorSeveridad);
  await writeFile(rutaInformeHtml, informeHtml, 'utf8');

  console.log(`cookies.csv escrito: ${rutaCookiesCsv}`);
  console.log(`correspondencia.csv escrito: ${rutaCorrespondenciaCsv}`);
  console.log(`informe.html escrito: ${rutaInformeHtml}`);
  console.log(`Filas de correspondencia: ${correspondencia.length}`);
  console.log(`Conteo por severidad: ${JSON.stringify(conteoPorSeveridad)}`);
}

await main();
