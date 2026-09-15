// ============================================================================
// admin-routes.js — API do painel administrativo do DECAY Master Server
//
// Uso no server.js (depois de criar playWatcher e ANTES de `new WebSocketServer`):
//
//   const { registrarRotasAdmin } = require("./admin-routes");
//   registrarRotasAdmin(app, {
//     config, logger, store, authStore, banStore, pushStore, fcm,
//     shopStore, googleShop, skinCatalog, chatClients, playWatcher,
//     rateLimiter, kickFromChat, onCredited,
//   });
//
// master.config.json (novo campo, opcional mas recomendado):
//   "adminKey": "outra-chave-longa-e-secreta"
//
// Painel: GET /admin  (serve public/admin.html)
// API:    /admin/api/*  — header X-Admin-Key
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { DC_PACKAGES, processPayment, findPaymentByOrderId } = require("./shop-dc");
const { PLAY_PRODUCTS } = require("./shop-google");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function escreverAtomico(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// ============================================================================
// BUFFER DE LOGS — envolve o Logger existente sem alterar o comportamento
// ============================================================================

function instalarBufferDeLogs(logger, max = 3000) {
  const buffer = [];
  const listeners = new Set();
  let seq = 0;

  for (const level of ["debug", "info", "warn", "error"]) {
    const original = logger[level].bind(logger);
    logger[level] = (...args) => {
      original(...args);
      const entry = { seq: ++seq, ts: Date.now(), level, msg: args.map(fmtArg).join(" ") };
      buffer.push(entry);
      if (buffer.length > max) buffer.shift();
      for (const fn of listeners) {
        try { fn(entry); } catch { /* listener morto */ }
      }
    };
  }

  // Linhas do chat vão direto pro console.log; capturamos as que têm prefixo.
  const consoleLog = console.log.bind(console);
  console.log = (...args) => {
    consoleLog(...args);
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.startsWith("[Chat]")) {
      const entry = { seq: ++seq, ts: Date.now(), level: "chat", msg: args.map(fmtArg).join(" ") };
      buffer.push(entry);
      if (buffer.length > max) buffer.shift();
      for (const fn of listeners) {
        try { fn(entry); } catch { /* ignore */ }
      }
    }
  };

  return { buffer, listeners };
}

// ============================================================================
// VALIDAÇÃO DE CONFIG (espelha loadConfig do server.js)
// ============================================================================

function validarConfig(c) {
  if (!c || typeof c !== "object") return "config deve ser um objeto";
  const required = [
    "serverName", "host", "port", "publicBaseUrl", "tokenTTLSeconds",
    "heartbeatTTLSeconds", "rateLimit", "allowedClientBuilds",
    "latestClientBuild", "logLevel", "serverKey",
  ];
  for (const f of required) {
    if (c[f] === undefined || c[f] === null) return `campo obrigatório ausente: ${f}`;
  }
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return "port deve ser inteiro 1-65535";
  if (typeof c.tokenTTLSeconds !== "number") return "tokenTTLSeconds deve ser número";
  if (typeof c.heartbeatTTLSeconds !== "number") return "heartbeatTTLSeconds deve ser número";
  if (!c.rateLimit.windowSeconds || !c.rateLimit.maxRequests) return "rateLimit precisa de windowSeconds e maxRequests";
  if (!Array.isArray(c.allowedClientBuilds) || c.allowedClientBuilds.length === 0) return "allowedClientBuilds deve ser array não vazio";
  if (
    !c.latestClientBuild.version ||
    typeof c.latestClientBuild.sizeMB !== "number" ||
    !Array.isArray(c.latestClientBuild.changelog)
  ) return "latestClientBuild precisa de version, sizeMB (número) e changelog (array)";
  if (!["debug", "info", "warn", "error"].includes(c.logLevel)) return "logLevel inválido";
  if (typeof c.serverKey !== "string" || c.serverKey.length < 8) return "serverKey muito curta";
  if (c.jwtSecret !== undefined && (typeof c.jwtSecret !== "string" || c.jwtSecret.length < 16)) return "jwtSecret muito curto (mín. 16)";
  if (c.adminKey !== undefined && (typeof c.adminKey !== "string" || c.adminKey.length < 12)) return "adminKey muito curta (mín. 12)";
  return null;
}

// Campos que podem ser trocados sem reiniciar o processo.
const CAMPOS_HOT = [
  "serverName", "publicBaseUrl", "tokenTTLSeconds", "heartbeatTTLSeconds",
  "rateLimit", "allowedClientBuilds", "latestClientBuild", "logLevel",
  "serverKey", "adminKey", "push",
];
const CAMPOS_RESTART = ["host", "port", "jwtSecret", "jwtExpirySeconds", "fcm", "playWatcher", "pushStorePath", "googleClientId"];

// ============================================================================
// PACOTES DC — persistência em data/dc-packages.json + mutação in-place
// ============================================================================

function validarPacotes(list) {
  if (!Array.isArray(list) || list.length === 0) return "lista de pacotes vazia";
  const ids = new Set();
  for (const p of list) {
    if (typeof p.packageId !== "string" || !/^[a-z0-9_.]+$/.test(p.packageId)) return `packageId inválido: ${p.packageId}`;
    if (ids.has(p.packageId)) return `packageId duplicado: ${p.packageId}`;
    ids.add(p.packageId);
    if (!Number.isInteger(p.amountDC) || p.amountDC <= 0) return `${p.packageId}: amountDC deve ser inteiro > 0`;
    if (!Number.isInteger(p.bonusDC) || p.bonusDC < 0) return `${p.packageId}: bonusDC deve ser inteiro >= 0`;
    if (!Number.isInteger(p.priceCents) || p.priceCents <= 0) return `${p.packageId}: priceCents deve ser inteiro > 0`;
  }
  return null;
}

function aplicarPacotes(list) {
  const limpos = list.map((p) => ({
    packageId: p.packageId,
    amountDC: p.amountDC,
    bonusDC: p.bonusDC,
    priceCents: p.priceCents,
  }));
  DC_PACKAGES.splice(0, DC_PACKAGES.length, ...limpos);
  PLAY_PRODUCTS.splice(
    0,
    PLAY_PRODUCTS.length,
    ...limpos.map((p) => ({
      productId: p.packageId,
      packageId: p.packageId,
      amountDC: p.amountDC,
      bonusDC: p.bonusDC,
      totalDC: p.amountDC + p.bonusDC,
    })),
  );
}

// ============================================================================
// REGISTRO
// ============================================================================

function registrarRotasAdmin(app, deps) {
  const {
    config, logger, store, authStore, banStore, pushStore, fcm,
    shopStore, googleShop, skinCatalog, chatClients, playWatcher,
    kickFromChat, onCredited,
  } = deps;

  const db = authStore.db;
  const dataDir = path.join(process.cwd(), "data");
  const configPath = path.join(process.cwd(), "master.config.json");
  const packagesPath = path.join(dataDir, "dc-packages.json");
  const skinsPath = path.join(dataDir, "skins.json");
  const painelPath = path.join(process.cwd(), "public", "admin.html");

  const logs = instalarBufferDeLogs(logger);

  // ── Schema extra ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      action    TEXT NOT NULL,
      target    TEXT,
      details   TEXT,
      ip        TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(createdAt);
  `);
  const ledgerCols = db.prepare(`PRAGMA table_info(dc_ledger)`).all().map((c) => c.name);
  if (!ledgerCols.includes("currency")) {
    db.exec(`ALTER TABLE dc_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'DC'`);
  }

  function audit(req, action, target, details) {
    try {
      db.prepare(
        `INSERT INTO admin_audit (action, target, details, ip, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(action, target != null ? String(target) : null, details ? JSON.stringify(details) : null, req.ip || null, nowSeconds());
    } catch (e) {
      logger.warn(`[Admin] falha ao gravar auditoria: ${e.message}`);
    }
    logger.info(`[Admin] ${action}${target != null ? ` ${target}` : ""} (${req.ip})`);
  }

  // ── Pacotes persistidos ───────────────────────────────────────────────────
  try {
    if (fs.existsSync(packagesPath)) {
      const raw = JSON.parse(fs.readFileSync(packagesPath, "utf8"));
      const lista = raw.packages || raw;
      const err = validarPacotes(lista);
      if (err) logger.error(`[Admin] dc-packages.json inválido, usando catálogo do código: ${err}`);
      else {
        aplicarPacotes(lista);
        logger.info(`[Admin] ${lista.length} pacote(s) DC carregados de dc-packages.json`);
      }
    }
  } catch (e) {
    logger.error(`[Admin] falha ao ler dc-packages.json: ${e.message}`);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!config.adminKey) {
    logger.warn("[Admin] adminKey não definida no config — usando serverKey. Defina uma adminKey separada.");
  }
  function chaveValida(k) {
    const esperada = String(config.adminKey || config.serverKey || "");
    const dada = String(k || "");
    if (!esperada || dada.length !== esperada.length) return false;
    return crypto.timingSafeEqual(Buffer.from(dada), Buffer.from(esperada));
  }
  const adminAuth = (req, res, next) => {
    const k = req.headers["x-admin-key"] || req.query.key;
    if (!chaveValida(k)) {
      logger.warn(`[Admin] chave inválida de ${req.ip}`);
      return res.status(401).json({ ok: false, error: "Chave de administrador inválida" });
    }
    next();
  };

  const bad = (res, msg, status = 400) => res.status(status).json({ ok: false, error: msg });
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ ok: false, error: e.message });
      logger.error("[Admin] erro:", e);
      res.status(500).json({ ok: false, error: e.message || "Erro interno" });
    }
  };
  const toInt = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };

  // ── Painel estático ───────────────────────────────────────────────────────
  app.get(["/admin", "/admin/"], (req, res) => {
    if (!fs.existsSync(painelPath)) return res.status(404).send("public/admin.html não encontrado");
    res.sendFile(painelPath);
  });

  const r = "/admin/api";
  app.use(r, (req, res, next) => {
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Server-Key, X-Admin-Key");
    if (req.method === "OPTIONS") return res.status(200).end();
    next();
  });

  app.get(`${r}/ping`, adminAuth, (req, res) => {
    res.json({ ok: true, serverName: config.serverName, time: nowSeconds(), usingServerKey: !config.adminKey });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // VISÃO GERAL
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/overview`, adminAuth, wrap((req, res) => {
    const now = nowSeconds();
    const d1 = now - 86400;
    const d7 = now - 7 * 86400;

    const contas = db.prepare(`SELECT COUNT(*) c, SUM(accountType='guest') guests, SUM(accountType='email') emails FROM accounts`).get();
    const novas24h = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE createdAt >= ?`).get(d1).c;
    const saldos = db.prepare(`SELECT SUM(balanceDC) dc, SUM(balanceDS) ds FROM accounts`).get();
    const mp24 = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(priceCents),0) c FROM dc_orders WHERE status='approved' AND creditedAt >= ?`).get(d1);
    const mp7 = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(priceCents),0) c FROM dc_orders WHERE status='approved' AND creditedAt >= ?`).get(d7);
    const mpTotal = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(priceCents),0) c FROM dc_orders WHERE status='approved'`).get();
    const play24 = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(totalDC),0) dc FROM play_orders WHERE status='credited' AND creditedAt >= ?`).get(d1);
    const play7 = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(totalDC),0) dc FROM play_orders WHERE status='credited' AND creditedAt >= ?`).get(d7);
    const review = db.prepare(`SELECT COUNT(*) c FROM dc_orders WHERE status='review'`).get().c;
    const pendentes = db.prepare(`SELECT COUNT(*) c FROM dc_orders WHERE status='pending' AND expiresAt > ?`).get(now).c;
    const skinsVendidas = db.prepare(`SELECT COUNT(*) c FROM skins WHERE acquiredAt >= ?`).get(d7).c;

    const servers = [...store.servers.values()].map((s) => ({
      ...s,
      online: now - s.lastHeartbeatAt <= config.heartbeatTTLSeconds,
    }));
    const playersEmServidores = servers.filter((s) => s.online).reduce((a, s) => a + (s.playersOnline || 0), 0);

    const ledgerRecente = db.prepare(
      `SELECT l.*, a.playerName FROM dc_ledger l LEFT JOIN accounts a ON a.playerId = l.playerId
       ORDER BY l.id DESC LIMIT 12`,
    ).all();

    res.json({
      ok: true,
      time: now,
      contas: { total: contas.c, guests: contas.guests, emails: contas.emails, novas24h },
      saldos: { dc: saldos.dc || 0, ds: saldos.ds || 0 },
      vendas: {
        mp: { h24: mp24, d7: mp7, total: mpTotal },
        play: { h24: play24, d7: play7 },
        review, pendentes, skinsVendidas7d: skinsVendidas,
      },
      servidores: {
        total: servers.length,
        online: servers.filter((s) => s.online).length,
        players: playersEmServidores,
        lista: servers,
      },
      chat: { online: chatClients.size },
      bans: banStore.listBans(true).length,
      push: pushStore.getStats(),
      play: playWatcher ? playWatcher.status() : null,
      fcmEnabled: !!fcm?.enabled,
      ledgerRecente,
      uptime: Math.floor(process.uptime()),
      memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // JOGADORES
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/players`, adminAuth, wrap((req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(200, toInt(req.query.limit, 50));
    const offset = Math.max(0, toInt(req.query.offset, 0));
    const tipo = req.query.type;
    const orderBy = ["createdAt", "level", "kills", "balanceDC", "balanceDS", "playerName"].includes(req.query.sort)
      ? req.query.sort : "createdAt";
    const dir = req.query.dir === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];
    if (q) {
      if (/^\d+$/.test(q)) {
        where.push(`(playerId = ? OR playerName LIKE ? COLLATE NOCASE)`);
        params.push(Number(q), `%${q}%`);
      } else {
        where.push(`(playerName LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE OR guestDeviceId = ?)`);
        params.push(`%${q}%`, `%${q}%`, q);
      }
    }
    if (tipo === "guest" || tipo === "email") {
      where.push(`accountType = ?`);
      params.push(tipo);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = db.prepare(
      `SELECT playerId, playerName, email, accountType, balanceDC, balanceDS, level, xp,
              kills, deaths, headshots, createdAt, guestDeviceId
       FROM accounts ${w} ORDER BY ${orderBy} ${dir} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM accounts ${w}`).get(...params).c;

    for (const p of rows) {
      p.banned = !!banStore.isPlayerBanned(p.playerId);
      p.online = chatClients.has(p.playerId) || chatClients.has(String(p.playerId));
    }
    res.json({ ok: true, rows, total, limit, offset });
  }));

  app.get(`${r}/players/:id`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    if (!Number.isInteger(id)) return bad(res, "playerId inválido");
    const account = db.prepare(`SELECT * FROM accounts WHERE playerId = ?`).get(id);
    if (!account) return bad(res, "Conta não encontrada", 404);
    delete account.passwordHash;

    const skins = db.prepare(`SELECT skinId, acquiredAt, expiresAt FROM skins WHERE playerId = ?`).all(id);
    const equipped = authStore.getEquipped(id);
    const sessions = db.prepare(`SELECT sessionId, deviceId, expiresAt, createdAt FROM sessions WHERE playerId = ?`).all(id);
    const ordersMp = db.prepare(`SELECT * FROM dc_orders WHERE playerId = ? ORDER BY createdAt DESC LIMIT 50`).all(id);
    const ordersPlay = db.prepare(`SELECT * FROM play_orders WHERE playerId = ? ORDER BY createdAt DESC LIMIT 50`).all(id);
    const ledger = db.prepare(`SELECT * FROM dc_ledger WHERE playerId = ? ORDER BY id DESC LIMIT 100`).all(id);
    const fp = banStore.fingerprints.get(String(id)) || null;
    const bans = banStore.listBans(false).filter((b) => String(b.playerId) === String(id));
    const pushTokens = pushStore.getTokensForPlayer(id).map((t) => ({ ...t, token: `${t.token.slice(0, 14)}…` }));

    res.json({
      ok: true,
      account: {
        ...account,
        xpToNextLevel: authStore._xpRequiredForLevel(account.level),
        banned: !!banStore.isPlayerBanned(id),
        online: chatClients.has(id) || chatClients.has(String(id)),
      },
      skins, equipped, sessions, ordersMp, ordersPlay, ledger,
      fingerprints: fp ? fp.devices : [],
      bans, pushTokens,
    });
  }));

  app.post(`${r}/players`, adminAuth, wrap(async (req, res) => {
    const { accountType, email, password, deviceId, playerName, balanceDC, balanceDS, level } = req.body || {};
    let result;
    if (accountType === "email") {
      if (!email || !password) return bad(res, "email e password são obrigatórios");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, "email inválido");
      if (String(password).length < 6) return bad(res, "senha mínima de 6 caracteres");
      result = await authStore.registerEmail(email, password, deviceId || `admin_${crypto.randomBytes(6).toString("hex")}`);
    } else if (accountType === "guest") {
      result = authStore.registerGuest(deviceId || `admin_${crypto.randomBytes(8).toString("hex")}`);
    } else {
      return bad(res, "accountType deve ser 'email' ou 'guest'");
    }
    const id = result.playerId;
    // sessão criada pelo registro não é do admin: remove
    db.prepare(`DELETE FROM sessions WHERE playerId = ?`).run(id);

    if (playerName) {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(playerName)) return bad(res, "playerName inválido (3-20, letras/números/_)");
      authStore.setPlayerName(id, playerName);
    }
    const dc = toInt(balanceDC, 0), ds = toInt(balanceDS, 0), lv = toInt(level, 1);
    db.prepare(`UPDATE accounts SET balanceDC = ?, balanceDS = ?, level = ? WHERE playerId = ?`).run(dc, ds, Math.max(1, lv), id);
    if (dc) db.prepare(`INSERT INTO dc_ledger (playerId, delta, balance, source, refId, currency, createdAt) VALUES (?, ?, ?, 'admin', 'conta criada', 'DC', ?)`).run(id, dc, dc, nowSeconds());
    if (ds) db.prepare(`INSERT INTO dc_ledger (playerId, delta, balance, source, refId, currency, createdAt) VALUES (?, ?, ?, 'admin', 'conta criada', 'DS', ?)`).run(id, ds, ds, nowSeconds());

    audit(req, "player.create", id, { accountType, email, playerName });
    res.json({ ok: true, playerId: id });
  }));

  app.patch(`${r}/players/:id`, adminAuth, wrap(async (req, res) => {
    const id = toInt(req.params.id, NaN);
    if (!Number.isInteger(id)) return bad(res, "playerId inválido");
    if (!db.prepare(`SELECT 1 FROM accounts WHERE playerId = ?`).get(id)) return bad(res, "Conta não encontrada", 404);

    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.playerName !== undefined) {
      if (b.playerName === null || b.playerName === "") {
        sets.push("playerName = NULL");
      } else {
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(b.playerName)) return bad(res, "playerName inválido");
        const dono = db.prepare(`SELECT playerId FROM accounts WHERE playerName = ?`).get(b.playerName);
        if (dono && dono.playerId !== id) return bad(res, "Nome já em uso", 409);
        sets.push("playerName = ?"); params.push(b.playerName);
      }
    }
    if (b.email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return bad(res, "email inválido");
      const dono = db.prepare(`SELECT playerId FROM accounts WHERE email = ?`).get(b.email);
      if (dono && dono.playerId !== id) return bad(res, "Email já em uso", 409);
      sets.push("email = ?"); params.push(b.email);
    }
    if (b.password !== undefined) {
      if (String(b.password).length < 6) return bad(res, "senha mínima de 6 caracteres");
      sets.push("passwordHash = ?"); params.push(await bcrypt.hash(String(b.password), 10));
    }
    for (const f of ["level", "xp", "kills", "deaths", "headshots"]) {
      if (b[f] !== undefined) {
        if (!Number.isInteger(b[f]) || b[f] < 0) return bad(res, `${f} deve ser inteiro >= 0`);
        sets.push(`${f} = ?`); params.push(f === "level" ? Math.max(1, b[f]) : b[f]);
      }
    }
    if (sets.length === 0) return bad(res, "nada para atualizar");
    params.push(id);
    db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE playerId = ?`).run(...params);
    if (b.password !== undefined) db.prepare(`DELETE FROM sessions WHERE playerId = ?`).run(id);

    const safe = { ...b }; delete safe.password;
    audit(req, "player.update", id, safe);
    res.json({ ok: true });
  }));

  app.delete(`${r}/players/:id`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    if (!Number.isInteger(id)) return bad(res, "playerId inválido");
    const acc = db.prepare(`SELECT playerId, playerName, email FROM accounts WHERE playerId = ?`).get(id);
    if (!acc) return bad(res, "Conta não encontrada", 404);

    kickFromChat(id, "Conta removida");
    db.transaction(() => {
      db.prepare(`DELETE FROM sessions WHERE playerId = ?`).run(id);
      db.prepare(`DELETE FROM skins WHERE playerId = ?`).run(id);
      db.prepare(`DELETE FROM equipped_skins WHERE playerId = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE playerId = ?`).run(id);
      // pedidos e ledger ficam: são registro financeiro
    })();
    pushStore.removeTokensOfPlayer(id);

    audit(req, "player.delete", id, acc);
    res.json({ ok: true });
  }));

  app.post(`${r}/players/:id/kick`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    const client = chatClients.get(id) || chatClients.get(String(id));
    if (client && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: "session_displaced", reason: req.body?.reason || "Desconectado pelo administrador" }));
      setTimeout(() => client.ws.close(), 100);
    }
    audit(req, "player.kick", id);
    res.json({ ok: true, estavaOnline: !!client });
  }));

  app.post(`${r}/players/:id/sessions/revoke`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    const n = db.prepare(`DELETE FROM sessions WHERE playerId = ?`).run(id).changes;
    kickFromChat(id, "Sessão encerrada pelo administrador");
    audit(req, "player.revokeSessions", id, { removidas: n });
    res.json({ ok: true, removidas: n });
  }));

  app.post(`${r}/players/:id/skins`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    const skinId = req.body?.skinId;
    if (!Number.isInteger(skinId)) return bad(res, "skinId deve ser inteiro");
    if (!db.prepare(`SELECT 1 FROM accounts WHERE playerId = ?`).get(id)) return bad(res, "Conta não encontrada", 404);
    const ins = db.prepare(`INSERT OR IGNORE INTO skins (playerId, skinId, acquiredAt, expiresAt) VALUES (?, ?, ?, 0)`).run(id, skinId, nowSeconds());
    audit(req, "player.grantSkin", id, { skinId });
    res.json({ ok: true, jaPossuia: ins.changes === 0 });
  }));

  app.delete(`${r}/players/:id/skins/:skinId`, adminAuth, wrap((req, res) => {
    const id = toInt(req.params.id, NaN);
    const skinId = toInt(req.params.skinId, NaN);
    db.transaction(() => {
      db.prepare(`DELETE FROM skins WHERE playerId = ? AND skinId = ?`).run(id, skinId);
      db.prepare(`DELETE FROM equipped_skins WHERE playerId = ? AND skinId = ?`).run(id, skinId);
    })();
    audit(req, "player.removeSkin", id, { skinId });
    res.json({ ok: true });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // MOEDAS
  // ══════════════════════════════════════════════════════════════════════════
  function ajustarSaldo(playerId, currency, delta, reason, allowNegative) {
    const col = currency === "DS" ? "balanceDS" : "balanceDC";
    const acc = db.prepare(`SELECT balanceDC, balanceDS FROM accounts WHERE playerId = ?`).get(playerId);
    if (!acc) throw { status: 404, message: `Conta ${playerId} não encontrada` };

    const upd = allowNegative
      ? db.prepare(`UPDATE accounts SET ${col} = ${col} + ? WHERE playerId = ?`).run(delta, playerId)
      : db.prepare(`UPDATE accounts SET ${col} = ${col} + ? WHERE playerId = ? AND ${col} + ? >= 0`).run(delta, playerId, delta);
    if (upd.changes === 0) throw { status: 402, message: `Saldo ${currency} insuficiente no player ${playerId}` };

    const novo = db.prepare(`SELECT ${col} AS b FROM accounts WHERE playerId = ?`).get(playerId).b;
    db.prepare(
      `INSERT INTO dc_ledger (playerId, delta, balance, source, refId, currency, createdAt) VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
    ).run(playerId, delta, novo, reason || null, currency, nowSeconds());
    return novo;
  }

  app.post(`${r}/coins/adjust`, adminAuth, wrap((req, res) => {
    const { playerId, currency, delta, reason, allowNegative } = req.body || {};
    const id = toInt(playerId, NaN);
    if (!Number.isInteger(id)) return bad(res, "playerId inválido");
    if (!["DC", "DS"].includes(currency)) return bad(res, "currency deve ser DC ou DS");
    if (!Number.isInteger(delta) || delta === 0) return bad(res, "delta deve ser inteiro diferente de zero");

    const novo = db.transaction(() => ajustarSaldo(id, currency, delta, reason, !!allowNegative))();
    if (currency === "DC" && delta > 0) onCredited?.(id, delta, novo, "admin");
    audit(req, "coins.adjust", id, { currency, delta, reason });
    res.json({ ok: true, playerId: id, currency, balance: novo });
  }));

  app.post(`${r}/coins/transfer`, adminAuth, wrap((req, res) => {
    const { fromPlayerId, toPlayerId, currency, amount, reason } = req.body || {};
    const from = toInt(fromPlayerId, NaN), to = toInt(toPlayerId, NaN);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return bad(res, "playerIds inválidos");
    if (!["DC", "DS"].includes(currency)) return bad(res, "currency deve ser DC ou DS");
    if (!Number.isInteger(amount) || amount <= 0) return bad(res, "amount deve ser inteiro > 0");

    const motivo = reason || `transferência ${from} → ${to}`;
    const out = db.transaction(() => {
      const a = ajustarSaldo(from, currency, -amount, motivo, false);
      const b = ajustarSaldo(to, currency, amount, motivo, false);
      return { from: a, to: b };
    })();
    if (currency === "DC") onCredited?.(to, amount, out.to, "admin");
    audit(req, "coins.transfer", `${from}->${to}`, { currency, amount, reason });
    res.json({ ok: true, balances: out });
  }));

  app.get(`${r}/coins/ledger`, adminAuth, wrap((req, res) => {
    const limit = Math.min(500, toInt(req.query.limit, 100));
    const offset = Math.max(0, toInt(req.query.offset, 0));
    const where = [], params = [];
    if (req.query.playerId) { where.push("l.playerId = ?"); params.push(toInt(req.query.playerId, 0)); }
    if (req.query.source) { where.push("l.source = ?"); params.push(req.query.source); }
    if (req.query.currency) { where.push("l.currency = ?"); params.push(req.query.currency); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT l.*, a.playerName FROM dc_ledger l LEFT JOIN accounts a ON a.playerId = l.playerId
       ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM dc_ledger l ${w}`).get(...params).c;
    res.json({ ok: true, rows, total });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // BANIMENTOS
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/bans`, adminAuth, (req, res) => {
    const all = req.query.all === "1";
    const bans = banStore.listBans(!all).sort((a, b) => b.createdAt - a.createdAt);
    const nomes = new Map();
    for (const b of bans) {
      if (!nomes.has(b.playerId)) {
        const a = db.prepare(`SELECT playerName FROM accounts WHERE playerId = ?`).get(Number(b.playerId));
        nomes.set(b.playerId, a?.playerName || null);
      }
      b.playerName = nomes.get(b.playerId);
    }
    res.json({ ok: true, bans });
  });

  app.post(`${r}/bans`, adminAuth, wrap((req, res) => {
    const { playerId, reason } = req.body || {};
    const id = toInt(playerId, NaN);
    if (!Number.isInteger(id)) return bad(res, "playerId inválido");
    const rec = banStore.banPlayer(id, reason || "Banido pelo painel", "painel");
    kickFromChat(id, reason || "Você foi banido");
    audit(req, "ban.create", id, { reason });
    res.json({ ok: true, ban: rec });
  }));

  app.delete(`${r}/bans/:playerId`, adminAuth, wrap((req, res) => {
    const id = req.params.playerId;
    const n = banStore.unbanPlayer(id);
    audit(req, "ban.remove", id, { removidos: n });
    res.json({ ok: true, removidos: n });
  }));

  // Edita listas de um ban específico (remover IP compartilhado, por ex.)
  app.patch(`${r}/bans/:banId`, adminAuth, wrap((req, res) => {
    const ban = banStore.bans.get(req.params.banId);
    if (!ban) return bad(res, "Ban não encontrado", 404);
    const b = req.body || {};
    for (const f of ["deviceIds", "hardwareIds", "ips"]) {
      if (Array.isArray(b[f])) ban[f] = b[f].map(String);
    }
    if (typeof b.reason === "string") ban.reason = b.reason;
    if (typeof b.active === "boolean") {
      ban.active = b.active;
      if (!b.active) ban.unbannedAt = nowSeconds();
    }
    banStore._save(banStore.bansFile, banStore.bans);
    audit(req, "ban.update", req.params.banId, b);
    res.json({ ok: true, ban });
  }));

  app.get(`${r}/bans/settings`, adminAuth, (req, res) => {
    res.json({ ok: true, banByIp: banStore.banByIp });
  });
  app.put(`${r}/bans/settings`, adminAuth, (req, res) => {
    if (typeof req.body?.banByIp === "boolean") banStore.banByIp = req.body.banByIp;
    audit(req, "ban.settings", null, { banByIp: banStore.banByIp });
    res.json({ ok: true, banByIp: banStore.banByIp });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SERVIDORES
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/servers`, adminAuth, (req, res) => {
    const now = nowSeconds();
    const rows = [...store.servers.values()].map((s) => ({
      ...s,
      online: now - s.lastHeartbeatAt <= config.heartbeatTTLSeconds,
      secondsSinceHeartbeat: now - s.lastHeartbeatAt,
    }));
    res.json({ ok: true, rows, tokensAtivos: store.tokens.size, heartbeatTTL: config.heartbeatTTLSeconds });
  });

  app.delete(`${r}/servers/:id`, adminAuth, (req, res) => {
    const ok = store.servers.delete(req.params.id);
    if (ok) store._save(store.serversFile, store.servers);
    audit(req, "server.remove", req.params.id);
    res.json({ ok: true, removido: ok });
  });

  app.patch(`${r}/servers/:id`, adminAuth, (req, res) => {
    const s = store.servers.get(req.params.id);
    if (!s) return bad(res, "Servidor não encontrado", 404);
    const b = req.body || {};
    if (["Online", "Cheio", "Offline", "Manutenção"].includes(b.status)) s.status = b.status;
    for (const f of ["name", "description", "discordUrl", "wipeDate", "region"]) {
      if (b[f] !== undefined) s[f] = b[f];
    }
    if (Number.isInteger(b.maxPlayers) && b.maxPlayers > 0) s.maxPlayers = b.maxPlayers;
    store._save(store.serversFile, store.servers);
    audit(req, "server.update", req.params.id, b);
    res.json({ ok: true, server: s });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PEDIDOS
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/orders`, adminAuth, wrap((req, res) => {
    const provider = req.query.provider === "play" ? "play" : "mp";
    const limit = Math.min(500, toInt(req.query.limit, 100));
    const offset = Math.max(0, toInt(req.query.offset, 0));
    const where = [], params = [];
    if (req.query.status) { where.push("o.status = ?"); params.push(req.query.status); }
    if (req.query.playerId) { where.push("o.playerId = ?"); params.push(toInt(req.query.playerId, 0)); }
    if (req.query.hours) { where.push("o.createdAt >= ?"); params.push(nowSeconds() - toInt(req.query.hours, 24) * 3600); }
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      if (provider === "mp") { where.push("(o.orderId LIKE ? OR o.paymentId LIKE ? OR a.playerName LIKE ?)"); params.push(q, q, q); }
      else { where.push("(o.purchaseToken LIKE ? OR o.gpOrderId LIKE ? OR a.playerName LIKE ?)"); params.push(q, q, q); }
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const table = provider === "mp" ? "dc_orders" : "play_orders";
    const rows = db.prepare(
      `SELECT o.*, a.playerName FROM ${table} o LEFT JOIN accounts a ON a.playerId = o.playerId
       ${w} ORDER BY o.createdAt DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM ${table} o LEFT JOIN accounts a ON a.playerId = o.playerId ${w}`).get(...params).c;
    const porStatus = db.prepare(`SELECT status, COUNT(*) n FROM ${table} GROUP BY status`).all();
    res.json({ ok: true, provider, rows, total, porStatus });
  }));

  // Reconciliação: consulta o MP e processa (idempotente)
  app.post(`${r}/orders/mp/:orderId/reconcile`, adminAuth, wrap(async (req, res) => {
    const order = shopStore.getOrder(req.params.orderId);
    if (!order) return bad(res, "Pedido não encontrado", 404);
    const payment = order.paymentId ? { id: order.paymentId } : await findPaymentByOrderId(order.orderId);
    if (!payment?.id) {
      audit(req, "order.reconcile", order.orderId, { resultado: "sem pagamento no MP" });
      return res.json({ ok: true, found: false, order: shopStore.getOrder(order.orderId) });
    }
    const result = await processPayment(payment.id, { shopStore, logger, onCredited });
    audit(req, "order.reconcile", order.orderId, result);
    res.json({ ok: true, found: true, result, order: shopStore.getOrder(order.orderId) });
  }));

  // Crédito manual forçado (ex.: pagamento confirmado por fora, status 'review')
  app.post(`${r}/orders/mp/:orderId/force-credit`, adminAuth, wrap((req, res) => {
    const order = shopStore.getOrder(req.params.orderId);
    if (!order) return bad(res, "Pedido não encontrado", 404);
    if (order.creditedAt) return bad(res, "Pedido já creditado", 409);
    const result = shopStore.creditOrder(order.orderId, {
      id: order.paymentId || `manual_${nowSeconds()}`,
      payment_method_id: order.paymentMethod || "manual",
      transaction_amount: order.priceCents / 100,
    });
    if (result.credited) onCredited?.(result.playerId, result.totalDC, result.balanceDC, order.orderId);
    audit(req, "order.forceCredit", order.orderId, { ...result, reason: req.body?.reason });
    res.json({ ok: true, result });
  }));

  app.post(`${r}/orders/mp/:orderId/status`, adminAuth, wrap((req, res) => {
    const { status, reason } = req.body || {};
    if (!["pending", "approved", "rejected", "cancelled", "expired", "review", "failed", "refunded"].includes(status)) return bad(res, "status inválido");
    const order = shopStore.getOrder(req.params.orderId);
    if (!order) return bad(res, "Pedido não encontrado", 404);
    db.prepare(`UPDATE dc_orders SET status = ?, failReason = COALESCE(?, failReason) WHERE orderId = ?`).run(status, reason || null, order.orderId);
    audit(req, "order.setStatus", order.orderId, { status, reason });
    res.json({ ok: true, order: shopStore.getOrder(order.orderId) });
  }));

  app.post(`${r}/orders/play/:token/revoke`, adminAuth, wrap((req, res) => {
    const result = googleShop.revoke(req.params.token, req.body?.reason || "revogado pelo painel");
    audit(req, "order.playRevoke", req.params.token.slice(0, 16), result);
    res.json({ ok: true, result });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // RELATÓRIOS
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/reports/sales`, adminAuth, wrap((req, res) => {
    const days = Math.min(365, toInt(req.query.days, 30));
    const desde = nowSeconds() - days * 86400;
    const mp = db.prepare(
      `SELECT date(creditedAt, 'unixepoch') dia, COUNT(*) n, SUM(priceCents) cents, SUM(amountDC + bonusDC) dc
       FROM dc_orders WHERE status='approved' AND creditedAt >= ? GROUP BY dia ORDER BY dia`,
    ).all(desde);
    const play = db.prepare(
      `SELECT date(creditedAt, 'unixepoch') dia, COUNT(*) n, SUM(totalDC) dc
       FROM play_orders WHERE status='credited' AND creditedAt >= ? GROUP BY dia ORDER BY dia`,
    ).all(desde);
    const porPacote = db.prepare(
      `SELECT packageId, COUNT(*) n, SUM(priceCents) cents FROM dc_orders
       WHERE status='approved' AND creditedAt >= ? GROUP BY packageId ORDER BY n DESC`,
    ).all(desde);
    const porPacotePlay = db.prepare(
      `SELECT productId packageId, COUNT(*) n, SUM(totalDC) dc FROM play_orders
       WHERE status='credited' AND creditedAt >= ? GROUP BY productId ORDER BY n DESC`,
    ).all(desde);
    const funil = db.prepare(
      `SELECT status, COUNT(*) n FROM dc_orders WHERE createdAt >= ? GROUP BY status`,
    ).all(desde);
    const metodos = db.prepare(
      `SELECT COALESCE(paymentMethod,'?') metodo, COUNT(*) n, SUM(priceCents) cents FROM dc_orders
       WHERE status='approved' AND creditedAt >= ? GROUP BY metodo ORDER BY n DESC`,
    ).all(desde);
    const skins = db.prepare(
      `SELECT skinId, COUNT(*) n FROM skins WHERE acquiredAt >= ? GROUP BY skinId ORDER BY n DESC LIMIT 20`,
    ).all(desde);
    res.json({ ok: true, days, mp, play, porPacote, porPacotePlay, funil, metodos, skins });
  }));

  app.get(`${r}/reports/players`, adminAuth, wrap((req, res) => {
    const days = Math.min(365, toInt(req.query.days, 30));
    const desde = nowSeconds() - days * 86400;
    const cadastros = db.prepare(
      `SELECT date(createdAt, 'unixepoch') dia, COUNT(*) n, SUM(accountType='guest') guests
       FROM accounts WHERE createdAt >= ? GROUP BY dia ORDER BY dia`,
    ).all(desde);
    const niveis = db.prepare(
      `SELECT CASE WHEN level < 5 THEN '1-4' WHEN level < 10 THEN '5-9' WHEN level < 20 THEN '10-19'
                   WHEN level < 40 THEN '20-39' ELSE '40+' END faixa, COUNT(*) n
       FROM accounts GROUP BY faixa`,
    ).all();
    const metric = ["kills", "level", "balanceDC", "balanceDS", "headshots"].includes(req.query.top) ? req.query.top : "kills";
    const top = db.prepare(
      `SELECT playerId, playerName, level, kills, deaths, headshots, balanceDC, balanceDS
       FROM accounts ORDER BY ${metric} DESC LIMIT 20`,
    ).all();
    const ativos = pushStore.tokens.size
      ? [...pushStore.tokens.values()].filter((t) => nowSeconds() - (t.lastSeenAt || 0) < 86400 * 7).length
      : null;
    res.json({ ok: true, days, cadastros, niveis, top, metric, ativos7dPush: ativos });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // SKINS
  // ══════════════════════════════════════════════════════════════════════════
  function lerSkinsRaw() {
    try {
      if (fs.existsSync(skinsPath)) return JSON.parse(fs.readFileSync(skinsPath, "utf8"));
    } catch (e) {
      logger.error(`[Admin] skins.json inválido: ${e.message}`);
    }
    return { skins: [] };
  }

  app.get(`${r}/skins`, adminAuth, (req, res) => {
    const raw = lerSkinsRaw();
    const owners = new Map(db.prepare(`SELECT skinId, COUNT(*) n FROM skins GROUP BY skinId`).all().map((x) => [x.skinId, x.n]));
    const skins = (raw.skins || []).map((s) => ({ ...s, owners: owners.get(s.skinId) || 0 }));
    res.json({ ok: true, skins, carregadas: skinCatalog.entries.size });
  });

  function validarSkins(list) {
    if (!Array.isArray(list)) return "skins deve ser array";
    const ids = new Set();
    for (const s of list) {
      if (!Number.isInteger(s.skinId)) return `skinId inválido: ${s.skinId}`;
      if (ids.has(s.skinId)) return `skinId duplicado: ${s.skinId}`;
      ids.add(s.skinId);
      if (typeof s.price !== "number" || s.price < 0) return `skin ${s.skinId}: price inválido`;
      if (s.currency !== undefined && !["DC", "DS"].includes(s.currency)) return `skin ${s.skinId}: currency deve ser DC ou DS`;
      if (s.slotKey !== undefined && s.slotKey !== null && typeof s.slotKey !== "string") return `skin ${s.skinId}: slotKey inválido`;
    }
    return null;
  }

  function salvarSkins(list) {
    const raw = lerSkinsRaw();
    raw.skins = list.map((s) => ({
      skinId: s.skinId,
      name: s.name || undefined,
      price: s.price,
      currency: s.currency || "DC",
      available: s.available !== false,
      slotKey: s.slotKey || null,
    }));
    escreverAtomico(skinsPath, JSON.stringify(raw, null, 2));
    return skinCatalog.reload();
  }

  app.put(`${r}/skins`, adminAuth, wrap((req, res) => {
    const list = req.body?.skins;
    const err = validarSkins(list);
    if (err) return bad(res, err);
    const n = salvarSkins(list);
    audit(req, "skins.replaceAll", null, { total: list.length });
    res.json({ ok: true, carregadas: n });
  }));

  app.post(`${r}/skins`, adminAuth, wrap((req, res) => {
    const s = req.body || {};
    const raw = lerSkinsRaw();
    const list = (raw.skins || []).filter((x) => x.skinId !== s.skinId);
    list.push(s);
    list.sort((a, b) => a.skinId - b.skinId);
    const err = validarSkins(list);
    if (err) return bad(res, err);
    const n = salvarSkins(list);
    audit(req, "skins.upsert", s.skinId, s);
    res.json({ ok: true, carregadas: n });
  }));

  app.delete(`${r}/skins/:skinId`, adminAuth, wrap((req, res) => {
    const skinId = toInt(req.params.skinId, NaN);
    const raw = lerSkinsRaw();
    const list = (raw.skins || []).filter((x) => x.skinId !== skinId);
    const n = salvarSkins(list);
    audit(req, "skins.delete", skinId);
    res.json({ ok: true, carregadas: n });
  }));

  app.post(`${r}/skins/reload`, adminAuth, (req, res) => {
    const n = skinCatalog.reload();
    audit(req, "skins.reload", null, { carregadas: n });
    res.json({ ok: true, carregadas: n });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PACOTES DC
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/packages`, adminAuth, (req, res) => {
    const vendas = new Map(db.prepare(`SELECT packageId, COUNT(*) n FROM dc_orders WHERE status='approved' GROUP BY packageId`).all().map((x) => [x.packageId, x.n]));
    const vendasPlay = new Map(db.prepare(`SELECT productId, COUNT(*) n FROM play_orders WHERE status='credited' GROUP BY productId`).all().map((x) => [x.productId, x.n]));
    res.json({
      ok: true,
      packages: DC_PACKAGES.map((p) => ({ ...p, vendasMp: vendas.get(p.packageId) || 0, vendasPlay: vendasPlay.get(p.packageId) || 0 })),
      persistido: fs.existsSync(packagesPath),
    });
  });

  app.put(`${r}/packages`, adminAuth, wrap((req, res) => {
    const list = req.body?.packages;
    const err = validarPacotes(list);
    if (err) return bad(res, err);
    aplicarPacotes(list);
    escreverAtomico(packagesPath, JSON.stringify({ packages: DC_PACKAGES }, null, 2));
    audit(req, "packages.replaceAll", null, { total: list.length });
    res.json({ ok: true, packages: DC_PACKAGES });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIG
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/config`, adminAuth, (req, res) => {
    let disco = null;
    try { disco = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { /* sem disco */ }
    res.json({ ok: true, memoria: config, disco, camposHot: CAMPOS_HOT, camposRestart: CAMPOS_RESTART });
  });

  app.put(`${r}/config`, adminAuth, wrap((req, res) => {
    const novo = req.body?.config;
    const err = validarConfig(novo);
    if (err) return bad(res, err);

    const precisaRestart = CAMPOS_RESTART.filter((f) => JSON.stringify(config[f]) !== JSON.stringify(novo[f]));

    // disco primeiro: se falhar, memória continua coerente com o arquivo antigo
    escreverAtomico(configPath, JSON.stringify(novo, null, 2));

    // memória: campos hot em cima do objeto compartilhado (as rotas leem config.*)
    for (const f of CAMPOS_HOT) {
      if (novo[f] !== undefined) config[f] = novo[f];
      else delete config[f];
    }
    // campos de restart também vão pra memória (só não têm efeito até reiniciar)
    for (const f of CAMPOS_RESTART) {
      if (novo[f] !== undefined) config[f] = novo[f];
    }
    logger.currentLevel = logger.levels[novo.logLevel] ?? logger.currentLevel;

    audit(req, "config.update", null, { precisaRestart });
    res.json({ ok: true, precisaRestart });
  }));

  app.post(`${r}/config/generate-secret`, adminAuth, (req, res) => {
    res.json({ ok: true, secret: crypto.randomBytes(32).toString("hex") });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PUSH / CHAT / PLAY
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/push/stats`, adminAuth, (req, res) => {
    const agora = nowSeconds();
    const recs = [...pushStore.tokens.values()];
    res.json({
      ok: true,
      ...pushStore.getStats(),
      fcmEnabled: !!fcm?.enabled,
      dryRun: !!fcm?.dryRun,
      ativos24h: recs.filter((t) => agora - (t.lastSeenAt || 0) < 86400).length,
      inativos7d: recs.filter((t) => agora - (t.lastSeenAt || 0) > 7 * 86400).length,
      candidatosReengajamento: pushStore.listCandidatosReengajamento({
        inatividadeMinHoras: config.push?.reengagementInactiveHours ?? 24,
        inatividadeMaxDias: config.push?.reengagementMaxInactiveDays ?? 30,
        cooldownHoras: config.push?.reengagementCooldownHours ?? 48,
        horaLocalMin: 0, horaLocalMax: 23,
        maxSemRetorno: config.push?.reengagementMaxStreak ?? 4,
      }).length,
    });
  });

  app.post(`${r}/push/send`, adminAuth, wrap(async (req, res) => {
    const { playerId, playerIds, all, title, body, priority } = req.body || {};
    if (!title || !body) return bad(res, "title e body são obrigatórios");
    let tokens = [];
    if (all === true) tokens = [...pushStore.tokens.keys()];
    else if (Array.isArray(playerIds)) {
      for (const list of pushStore.getTokensForPlayers(playerIds).values()) tokens.push(...list.map((t) => t.token));
    } else if (playerId != null) tokens = pushStore.getTokensForPlayer(playerId).map((t) => t.token);
    else return bad(res, "informe playerId, playerIds ou all=true");
    if (tokens.length === 0) return res.json({ ok: true, enviados: 0, tokens: 0 });

    const resultados = await fcm.sendToTokens(tokens, {
      title, body,
      channelId: "novidades",
      priority: priority === "high" ? "high" : "normal",
      collapseKey: "admin_msg",
      ttlSeconds: 12 * 3600,
      data: { tipo: "admin" },
    });
    let enviados = 0, invalidos = 0;
    for (const x of resultados) {
      if (x.ok) enviados++;
      else if (x.invalid) { pushStore.removeToken(x.token); invalidos++; }
    }
    audit(req, "push.send", all ? "all" : playerId ?? "lista", { title, tokens: tokens.length, enviados });
    res.json({ ok: true, tokens: tokens.length, enviados, invalidos, fcmEnabled: !!fcm?.enabled });
  }));

  app.get(`${r}/chat/online`, adminAuth, (req, res) => {
    const rows = [];
    for (const [id, c] of chatClients) rows.push({ playerId: id, playerName: c.playerName, open: c.ws.readyState === 1 });
    res.json({ ok: true, rows });
  });

  app.post(`${r}/chat/broadcast`, adminAuth, (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return bad(res, "text obrigatório");
    const payload = JSON.stringify({
      type: "chat_message", playerId: 0, playerName: req.body?.as || "[ADMIN]", text: text.slice(0, 200), timestamp: nowSeconds(),
    });
    let n = 0;
    for (const [, c] of chatClients) if (c.ws.readyState === 1) { c.ws.send(payload); n++; }
    audit(req, "chat.broadcast", null, { text, entregues: n });
    res.json({ ok: true, entregues: n });
  });

  app.post(`${r}/chat/system`, adminAuth, (req, res) => {
    // mensagem estruturada que o cliente pode tratar (ex.: aviso de manutenção)
    const payload = JSON.stringify({ type: req.body?.type || "system_notice", ...req.body });
    let n = 0;
    for (const [, c] of chatClients) if (c.ws.readyState === 1) { c.ws.send(payload); n++; }
    audit(req, "chat.system", req.body?.type, req.body);
    res.json({ ok: true, entregues: n });
  });

  app.get(`${r}/play/status`, adminAuth, (req, res) => {
    res.json({ ok: true, status: playWatcher ? playWatcher.status() : null });
  });
  app.post(`${r}/play/check`, adminAuth, wrap(async (req, res) => {
    if (!playWatcher) return bad(res, "PlayWatcher indisponível");
    const result = await playWatcher.check({ manual: true });
    audit(req, "play.check", null, result);
    res.json({ ok: true, result });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // LOGS & AUDITORIA
  // ══════════════════════════════════════════════════════════════════════════
  app.get(`${r}/logs`, adminAuth, (req, res) => {
    const limit = Math.min(3000, toInt(req.query.limit, 300));
    const level = req.query.level;
    const q = String(req.query.q || "").toLowerCase();
    const after = toInt(req.query.after, 0);
    let rows = logs.buffer;
    if (after) rows = rows.filter((e) => e.seq > after);
    if (level && level !== "all") rows = rows.filter((e) => e.level === level);
    if (q) rows = rows.filter((e) => e.msg.toLowerCase().includes(q));
    res.json({ ok: true, rows: rows.slice(-limit), lastSeq: logs.buffer.length ? logs.buffer[logs.buffer.length - 1].seq : 0 });
  });

  app.get(`${r}/logs/stream`, adminAuth, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`: conectado\n\n`);
    const fn = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    logs.listeners.add(fn);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => {
      logs.listeners.delete(fn);
      clearInterval(ping);
    });
  });

  app.get(`${r}/audit`, adminAuth, (req, res) => {
    const limit = Math.min(500, toInt(req.query.limit, 100));
    const offset = Math.max(0, toInt(req.query.offset, 0));
    const where = [], params = [];
    if (req.query.action) { where.push("action LIKE ?"); params.push(`${req.query.action}%`); }
    if (req.query.target) { where.push("target = ?"); params.push(String(req.query.target)); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM admin_audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM admin_audit ${w}`).get(...params).c;
    res.json({ ok: true, rows, total });
  });

  logger.info("[Admin] Painel disponível em /admin — API em /admin/api");
}

module.exports = { registrarRotasAdmin, validarConfig, validarPacotes };