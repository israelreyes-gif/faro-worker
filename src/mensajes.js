import { json, error, cicloActual, usuarioDesdePeticion, comprobarRateLimit } from './utils.js';
import { enviarATodos } from './push.js';

const CATEGORIAS_VALIDAS = ['historia', 'recuerdo', 'consejo'];
const TEXTO_MAX_LENGTH = 500;
const MENSAJE_COOLDOWN_MS = 3000;

// La foto se limita a ~900 KB una vez decodificada (el frontend la
// comprime antes de mandarla). En base64 ocupa ~1/3 más, de ahí el margen.
const FOTO_MAX_BASE64_LENGTH = 1_200_000;
const FOTO_MIME_VALIDOS = ['image/jpeg', 'image/png', 'image/webp'];

export async function postMensaje(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const { limitado, segundosRestantes } = await comprobarRateLimit(env, `mensaje_${usuario.id}`, MENSAJE_COOLDOWN_MS);
  if (limitado) {
    return error(`Espera ${segundosRestantes} segundo(s) antes de intentarlo de nuevo.`, 429, origin);
  }

  const { categoria, texto, foto, fotoMime } = await request.json().catch(() => ({}));
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return error('Categoría no válida.', 400, origin);
  }
  if (!texto || !texto.trim()) {
    return error('Escribe algo antes de encender el faro.', 400, origin);
  }
  if (texto.trim().length > TEXTO_MAX_LENGTH) {
    return error(`El mensaje no puede superar los ${TEXTO_MAX_LENGTH} caracteres.`, 400, origin);
  }
  if (foto) {
    if (!FOTO_MIME_VALIDOS.includes(fotoMime)) {
      return error('El formato de la foto no es válido.', 400, origin);
    }
    if (foto.length > FOTO_MAX_BASE64_LENGTH) {
      return error('La foto pesa demasiado. Prueba con otra.', 400, origin);
    }
  }

  const ciclo = cicloActual();
  const sorteo = await env.DB
    .prepare('SELECT * FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();

  if (!sorteo) return error('Esta noche el faro aún no ha elegido a nadie.', 400, origin);
  if (sorteo.ganador_user_id !== usuario.id) {
    return error('Esta noche el faro no te ha iluminado a ti.', 403, origin);
  }

  const yaEscrito = await env.DB
    .prepare('SELECT id FROM mensajes WHERE sorteo_id = ?').bind(sorteo.id).first();
  if (yaEscrito) return error('Ya has dejado tu mensaje esta noche.', 409, origin);

  await env.DB.prepare(
    `INSERT INTO mensajes (sorteo_id, user_id, categoria, texto) VALUES (?, ?, ?, ?)`
  ).bind(sorteo.id, usuario.id, categoria, texto.trim()).run();

  // La foto vive aparte, en una única fila que se sobrescribe cada vez y
  // se vacía sola en el reseteo diario, para no ocupar espacio permanente.
  if (foto) {
    await env.DB.prepare(
      `INSERT INTO foto_dia (id, sorteo_id, datos, mime_type) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sorteo_id = ?, datos = ?, mime_type = ?, created_at = datetime('now')`
    ).bind(sorteo.id, foto, fotoMime, sorteo.id, foto, fotoMime).run();
  }

  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro ha hablado esta noche. Ven a leerlo.'
  });

  return json({ ok: true }, { status: 201 }, origin);
}
