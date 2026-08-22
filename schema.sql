CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  nombre_completo TEXT NOT NULL,
  fecha_nacimiento TEXT,
  login_fallos INTEGER NOT NULL DEFAULT 0,
  login_bloqueado_hasta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sorteos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_ciclo TEXT NOT NULL UNIQUE,
  ganador_user_id INTEGER NOT NULL,
  numero_elegido INTEGER NOT NULL,
  total_usuarios INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ganador_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sorteo_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('historia', 'recuerdo', 'consejo')),
  texto TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sorteo_id) REFERENCES sorteos(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cron_ejecuciones (
  ciclo TEXT NOT NULL,
  tarea TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ciclo, tarea)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  clave TEXT PRIMARY KEY,
  last_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foto_dia (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sorteo_id INTEGER,
  datos TEXT,
  mime_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
