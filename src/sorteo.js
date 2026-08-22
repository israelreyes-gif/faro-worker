import { json, error, madridNow, cicloActual, usuarioDesdePeticion, firmarToken } from './utils.js';
import { enviarAUsuario, enviarATodos } from './push.js';

const T_CUMPLE = 9 * 60;        // 09:00 -> avisos de cumpleaños
const T_RESET = 10 * 60;        // 10:00 -> vuelve a "apagado"
const T_GIRANDO = 21 * 60 + 50; // 21:50 -> empieza a girar el dado (visual)
const T_ELEGIDO = 21 * 60 + 55; // 21:55 -> se revela el elegido
const T_ESCRIBIENDO = 22 * 60;  // 22:00 -> se abre la hora para escribir
const T_CIERRE = 23 * 60;       // 23:00 -> se cierra la ventana

// Tolerancia: si el cron se retrasa o se salta un tick (cada 5 min),
// esta ventana permite "recuperar" la tarea en los siguientes minutos
// en vez de perderla para siempre ese día.
const VENTANA_TOLERANCIA_MIN = 10;

// Duración del token y umbral de renovación silenciosa: si al token le
// quedan menos de 7 días de vida cuando se usa, se emite uno nuevo con
// otros 30 días por delante, para que el uso diario nunca caduque.
const TOKEN_DURACION_MS = 1000 * 60 * 60 * 24 * 30;
const TOKEN_RENOVAR_UMBRAL_MS = 1000 * 60 * 60 * 24 * 7;

// ---------------------------------------------------------------
// GET /api/estado — llamado por el frontend cada pocos segundos
// ---------------------------------------------------------------
export async function getEstado(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const ciclo = cicloActual();
  const hm = madridNow().minutesOfDay;

  const totalUsuarios = (await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users').first())?.n ?? 0;

  const sorteo = await env.DB
    .prepare(`SELECT s.*, u.nombre_completo
              FROM sorteos s JOIN users u ON u.id = s.ganador_user_id
              WHERE s.fecha_ciclo = ?`)
    .bind(ciclo).first();

  const mensajeRow = sorteo ? await env.DB
    .prepare(`SELECT m.*, u.nombre_completo
              FROM mensajes m JOIN users u ON u.id = m.user_id
              WHERE m.sorteo_id = ?`)
    .bind(sorteo.id).first() : null;

  const fase = calcularFase(hm, sorteo, mensajeRow);

  const respuesta = { fase, totalUsuarios };

  if (sorteo) {
    respuesta.ganador = { id: sorteo.ganador_user_id, nombre: sorteo.nombre_completo };
    // El número solo se envía a quien fue elegido. Para el resto no viaja
    // en la respuesta, así nadie puede llevar la cuenta de qué número le
    // tocó a quién noche tras noche.
    if (sorteo.ganador_user_id === usuario.id) {
      respuesta.numeroElegido = sorteo.numero_elegido;
    }
  }
  if (mensajeRow) {
    respuesta.mensaje = {
      nombre: mensajeRow.nombre_completo,
      categoria: mensajeRow.categoria,
      texto: mensajeRow.texto
    };

    const fotoRow = await env.DB
      .prepare('SELECT datos, mime_type FROM foto_dia WHERE id = 1 AND sorteo_id = ?')
      .bind(sorteo.id).first();
    if (fotoRow?.datos) {
      respuesta.mensaje.foto = fotoRow.datos;
      respuesta.mensaje.fotoMime = fotoRow.mime_type;
    }
  }
  if (fase === 'escribiendo') {
    respuesta.segundosRestantes = Math.max(0, (T_CIERRE - hm) * 60 - madridNow().second);
  }

  // Renovación silenciosa: si al token le quedan menos de 7 días, se
  // emite uno nuevo con otros 30 días por delante. El frontend lo
  // guarda sin que la persona note nada.
  if (usuario.exp && (usuario.exp - Date.now()) < TOKEN_RENOVAR_UMBRAL_MS) {
    respuesta.nuevoToken = await firmarToken(
      { id: usuario.id, username: usuario.username, exp: Date.now() + TOKEN_DURACION_MS },
      env.JWT_SECRET
    );
  }

  return json(respuesta, {}, origin);
}

function calcularFase(hm, sorteo, mensaje) {
  if (hm >= T_RESET && hm < T_GIRANDO) return 'apagado';
  if (hm >= T_GIRANDO && hm < T_ELEGIDO) return 'girando';
  if (hm >= T_ELEGIDO && hm < T_ESCRIBIENDO) return sorteo ? 'elegido' : 'girando';

  if (hm >= T_ESCRIBIENDO && hm < T_CIERRE) {
    if (mensaje) return 'mensaje';
    return sorteo ? 'escribiendo' : 'elegido';
  }

  // 23:00 -> 10:00 del día siguiente (overnight)
  if (mensaje) return 'mensaje';
  if (sorteo) return 'sin_mensaje';
  return 'apagado';
}

// ---------------------------------------------------------------
// Control de ejecución única por ciclo (evita duplicados si la
// ventana de tolerancia coincide con más de un tick del cron)
// ---------------------------------------------------------------
async function yaEjecutado(env, ciclo, tarea) {
  const row = await env.DB
    .prepare('SELECT 1 FROM cron_ejecuciones WHERE ciclo = ? AND tarea = ?')
    .bind(ciclo, tarea).first();
  return !!row;
}

async function marcarEjecutado(env, ciclo, tarea) {
  await env.DB
    .prepare('INSERT OR IGNORE INTO cron_ejecuciones (ciclo, tarea) VALUES (?, ?)')
    .bind(ciclo, tarea).run();
}

function dentroDeVentana(hm, objetivo) {
  return hm >= objetivo && hm < objetivo + VENTANA_TOLERANCIA_MIN;
}

// ---------------------------------------------------------------
// Tarea programada (cron cada 5 min) — ver src/index.js `scheduled`
// ---------------------------------------------------------------
export async function ejecutarTareaProgramada(env) {
  const hm = madridNow().minutesOfDay;
  const ciclo = cicloActual();

  await ejecutarSiToca(env, ciclo, 'cumple', hm, T_CUMPLE, () => avisarCumpleanos(env));
  await ejecutarSiToca(env, ciclo, 'girando', hm, T_GIRANDO, () => avisarDadoGirando(env));
  await ejecutarSiToca(env, ciclo, 'elegido', hm, T_ELEGIDO, () => elegirGanador(env, ciclo));
  await ejecutarSiToca(env, ciclo, 'escribiendo', hm, T_ESCRIBIENDO, () => avisarInicioEscritura(env, ciclo));
  await ejecutarSiToca(env, ciclo, 'cierre', hm, T_CIERRE, () => avisarSiSinMensaje(env, ciclo));
  await ejecutarSiToca(env, ciclo, 'limpieza', hm, T_RESET, () => limpiarCronAntiguo(env));
  await ejecutarSiToca(env, ciclo, 'limpieza_foto', hm, T_RESET, () => limpiarFotoDia(env));
}

// Mantenimiento: borra registros de cron_ejecuciones de hace más de 60 días.
// Se ejecuta una vez al día (a las 10:00, hueco de T_RESET) para no dejar
// crecer la tabla indefinidamente, aunque en la práctica tardaría años en
// suponer un problema real de tamaño.
async function limpiarCronAntiguo(env) {
  await env.DB
    .prepare(`DELETE FROM cron_ejecuciones WHERE ciclo < date('now', '-60 days')`)
    .run();
}

// Vacía la foto del día anterior en el reseteo diario, para que nunca
// ocupe espacio de forma permanente en la base de datos.
async function limpiarFotoDia(env) {
  await env.DB
    .prepare('UPDATE foto_dia SET sorteo_id = NULL, datos = NULL, mime_type = NULL WHERE id = 1')
    .run();
}

async function ejecutarSiToca(env, ciclo, tarea, hm, objetivo, accion) {
  if (!dentroDeVentana(hm, objetivo)) return;
  if (await yaEjecutado(env, ciclo, tarea)) return;

  await accion();
  await marcarEjecutado(env, ciclo, tarea);
}

async function avisarCumpleanos(env) {
  const { month, day } = madridNow();
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const cumples = await env.DB
    .prepare(`SELECT nombre_completo FROM users WHERE substr(fecha_nacimiento, 6, 5) = ?`)
    .bind(mmdd).all();

  for (const persona of cumples.results) {
    await enviarATodos(env, {
      title: 'FARO',
      body: `Hoy es el cumpleaños de ${persona.nombre_completo}. 🎉`
    });
  }
}

async function avisarDadoGirando(env) {
  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro está eligiendo a alguien esta noche.'
  });
}

async function elegirGanador(env, ciclo) {
  const yaExiste = await env.DB
    .prepare('SELECT id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (yaExiste) return;

  const usuarios = await env.DB.prepare('SELECT id FROM users ORDER BY id ASC').all();
  const ids = usuarios.results.map(u => u.id);
  if (ids.length === 0) return;

  const indice = randomIndex(ids.length); // aleatoriedad estricta, misma probabilidad para todos
  const ganadorId = ids[indice];

  await env.DB.prepare(
    `INSERT OR IGNORE INTO sorteos (fecha_ciclo, ganador_user_id, numero_elegido, total_usuarios)
     VALUES (?, ?, ?, ?)`
  ).bind(ciclo, ganadorId, indice + 1, ids.length).run();

  await enviarAUsuario(env, ganadorId, {
    title: 'FARO',
    body: 'Esta noche, el faro te ha iluminado.'
  });
}

async function avisarInicioEscritura(env, ciclo) {
  const sorteo = await env.DB
    .prepare('SELECT ganador_user_id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (!sorteo) return;

  await enviarAUsuario(env, sorteo.ganador_user_id, {
    title: 'FARO',
    body: 'Tienes 1 hora para escribir lo que quieras dejar esta noche.'
  });
}

async function avisarSiSinMensaje(env, ciclo) {
  const sorteo = await env.DB
    .prepare('SELECT id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (!sorteo) return;

  const mensaje = await env.DB
    .prepare('SELECT id FROM mensajes WHERE sorteo_id = ?').bind(sorteo.id).first();
  if (mensaje) return; // ya se difundió al enviarlo, ver src/mensajes.js

  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro se apagó esta noche sin dejar ningún mensaje.'
  });
}

// Rechaza valores que introducirían sesgo de módulo, para que cada
// usuario tenga exactamente la misma probabilidad de ser elegido.
function randomIndex(n) {
  const max = Math.floor(0xFFFFFFFF / n) * n;
  let x;
  do {
    x = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (x >= max);
  return x % n;
}
