import { json, error, hashPassword, verifyPassword, firmarToken } from './utils.js';

const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;

export async function registrar(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const { username, password, password2, nombre, fechaNacimiento } = body;

  if (!username || !password || !nombre) {
    return error('Rellena al menos usuario, contraseña y nombre.', 400, origin);
  }
  if (password !== password2) {
    return error('Las contraseñas no coinciden.', 400, origin);
  }
  if (fechaNacimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fechaNacimiento)) {
    return error('La fecha de nacimiento no es válida.', 400, origin);
  }

  const existente = await env.DB
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username.toLowerCase())
    .first();

  if (existente) {
    return error('Ese usuario ya existe en el faro.', 409, origin);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt, nombre_completo, fecha_nacimiento)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(username.toLowerCase(), hash, salt, nombre, fechaNacimiento || null).run();

  return json({ ok: true }, { status: 201 }, origin);
}

export async function login(request, env, origin) {
  const { username, password } = await request.json().catch(() => ({}));
  if (!username || !password) {
    return error('Escribe tu usuario y tu contraseña.', 400, origin);
  }

  const usernameLower = username.toLowerCase();

  const user = await env.DB
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(usernameLower)
    .first();

  if (!user) return error('Acceso incorrecto.', 401, origin);

  // Comprobar si el usuario está bloqueado por demasiados fallos
  if (user.login_bloqueado_hasta) {
    const restante = new Date(user.login_bloqueado_hasta).getTime() - Date.now();
    if (restante > 0) {
      return json({
        error: 'Cuenta bloqueada temporalmente por demasiados intentos.',
        locked: true,
        segundosRestantes: Math.ceil(restante / 1000)
      }, { status: 429 }, origin);
    }
  }

  const valido = await verifyPassword(password, user.password_hash, user.password_salt);

  if (!valido) {
    const fallosNuevos = (user.login_fallos ?? 0) + 1;

    if (fallosNuevos >= MAX_INTENTOS) {
      const bloqueadoHasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60 * 1000).toISOString();
      await env.DB.prepare(
        'UPDATE users SET login_fallos = 0, login_bloqueado_hasta = ? WHERE id = ?'
      ).bind(bloqueadoHasta, user.id).run();

      return json({
        error: 'Cuenta bloqueada temporalmente por demasiados intentos.',
        locked: true,
        segundosRestantes: BLOQUEO_MINUTOS * 60
      }, { status: 429 }, origin);
    }

    await env.DB.prepare(
      'UPDATE users SET login_fallos = ? WHERE id = ?'
    ).bind(fallosNuevos, user.id).run();

    return json({
      error: 'Acceso incorrecto.',
      intentosRestantes: MAX_INTENTOS - fallosNuevos
    }, { status: 401 }, origin);
  }

  // Login correcto: se resetea el contador de fallos
  await env.DB.prepare(
    'UPDATE users SET login_fallos = 0, login_bloqueado_hasta = NULL WHERE id = ?'
  ).bind(user.id).run();

  const token = await firmarToken(
    { id: user.id, username: user.username, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({
    token,
    user: { id: user.id, nombre: user.nombre_completo }
  }, {}, origin);
}
