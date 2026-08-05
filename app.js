const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const http = require("http");
const { GoogleAuth } = require("google-auth-library");
const { ShopStore, registrarRotasLoja, iniciarJobsDaLoja } = require("./shop-dc");
const { iniciarReconciliacao } = require("./shop-reconcile");

// ===== UTILITY FUNCTIONS =====

function generateGuid() {
  return crypto.randomUUID();
}

function generateJoinToken() {
  return crypto.randomBytes(32).toString("hex");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function validateRequired(fields, body) {
  if (!body || typeof body !== "object") {
    return "Request body must be a JSON object";
  }

  const missing = [];

  for (const field of fields) {
    const value = body[field];

    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }

    if (typeof value === "string" && value.trim().length === 0) {
      missing.push(field);
    }
  }

  return missing.length > 0
    ? `Missing required field(s): ${missing.join(", ")}`
    : null;
}

/**
 * Tipos esperados. Aceita: "number", "integer", "string", "boolean", "array".
 *
 * Campo ausente é ignorado de propósito — obrigatoriedade é responsabilidade
 * do validateRequired, e as rotas chamam ele primeiro. Assim um campo
 * opcional não vira erro de tipo só por não ter sido enviado.
 *
 * "number" recusa NaN/Infinity via Number.isFinite (JSON.parse não produz
 * esses valores, mas a função também é usada com objetos montados à mão).
 */
function validateTypes(spec, body) {
  const errors = [];

  for (const [field, expected] of Object.entries(spec)) {
    const value = body ? body[field] : undefined;

    if (value === undefined || value === null) continue;

    let ok;
    switch (expected) {
      case "number":
        ok = typeof value === "number" && Number.isFinite(value);
        break;
      case "integer":
        ok = Number.isInteger(value);
        break;
      case "string":
        ok = typeof value === "string";
        break;
      case "boolean":
        ok = typeof value === "boolean";
        break;
      case "array":
        ok = Array.isArray(value);
        break;
      default:
        ok = typeof value === expected;
    }

    if (!ok) errors.push(`${field} must be of type ${expected}`);
  }

  return errors.length > 0 ? errors.join("; ") : null;
}
function onCredited(playerId, totalDC, balanceDC, orderId) {
  const c = chatClients.get(playerId) || chatClients.get(String(playerId));
  if (c?.ws.readyState === 1) {
    c.ws.send(JSON.stringify({ type: "dc_credited", totalDC, balanceDC, orderId }));
  }
}
// ===== LOGGER =====

class Logger {
  constructor(level) {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.currentLevel = this.levels[level] || this.levels.info;
  }

  debug(...args) {
    if (this.currentLevel <= this.levels.debug) {
      console.log("[DEBUG]", ...args);
    }
  }

  info(...args) {
    if (this.currentLevel <= this.levels.info) {
      console.log("[INFO]", ...args);
    }
  }

  warn(...args) {
    if (this.currentLevel <= this.levels.warn) {
      console.warn("[WARN]", ...args);
    }
  }

  error(...args) {
    if (this.currentLevel <= this.levels.error) {
      console.error("[ERROR]", ...args);
    }
  }
}

// ===== CONFIG LOADER =====

function loadConfig() {
  const fs = require("fs");
  const path = require("path");

  const configPath = path.join(process.cwd(), "master.config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  let config;
  try {
    const configData = fs.readFileSync(configPath, "utf8");
    config = JSON.parse(configData);
  } catch (error) {
    throw new Error(`Failed to parse configuration file: ${error.message}`);
  }

  const required = [
    "serverName",
    "host",
    "port",
    "publicBaseUrl",
    "tokenTTLSeconds",
    "heartbeatTTLSeconds",
    "rateLimit",
    "allowedClientBuilds",
    "latestClientBuild",
    "logLevel",
    "serverKey",
  ];
  
  for (const field of required) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`Missing required configuration field: ${field}`);
    }
  }
  
  if (!config.rateLimit.windowSeconds || !config.rateLimit.maxRequests) {
    throw new Error("rateLimit must have windowSeconds and maxRequests");
  }
  
  if (
    !config.latestClientBuild.version ||
    typeof config.latestClientBuild.sizeMB !== "number" ||
    !Array.isArray(config.latestClientBuild.changelog)
  ) {
    throw new Error(
      "latestClientBuild must have version (string), sizeMB (number), and changelog (array)",
    );
  }

  if (typeof config.tokenTTLSeconds !== "number") {
    throw new Error("tokenTTLSeconds must be a number");
  }
  if (typeof config.heartbeatTTLSeconds !== "number") {
    throw new Error("heartbeatTTLSeconds must be a number");
  }
  if (!Array.isArray(config.allowedClientBuilds)) {
    throw new Error("allowedClientBuilds must be an array");
  }
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
    throw new Error("logLevel must be one of: debug, info, warn, error");
  }

  return config;
}

// ===== MIDDLEWARE =====

function serverAuthMiddleware(config, logger) {
  return (req, res, next) => {
    const providedKey = req.headers["x-server-key"];

    if (!providedKey) {
      logger.warn("Server auth failed: missing X-Server-Key header");
      return res.status(401).json({
        ok: false,
        error: "Missing X-Server-Key header",
      });
    }

    if (providedKey !== config.serverKey) {
      logger.warn("Server auth failed: invalid X-Server-Key");
      return res.status(401).json({
        ok: false,
        error: "Invalid server key",
      });
    }

    next();
  };
}

// ===== RATE LIMITER =====

class RateLimiter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.requests = new Map();
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const now = nowSeconds();
      const windowStart = now - this.config.rateLimit.windowSeconds;

      let history = this.requests.get(ip) || [];
      const validRequests = history.filter((ts) => ts > windowStart);
      this.requests.set(ip, validRequests);

      if (validRequests.length >= this.config.rateLimit.maxRequests) {
        this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
        return res.status(429).json({
          ok: false,
          error: "Rate limit exceeded",
          details: `Max ${this.config.rateLimit.maxRequests} requests per ${this.config.rateLimit.windowSeconds} seconds`,
        });
      }

      validRequests.push(now);
      this.requests.set(ip, validRequests);
      next();
    };
  }

  cleanup() {
    const now = nowSeconds();
    const windowStart = now - this.config.rateLimit.windowSeconds;
    let cleaned = 0;

    for (const [ip, history] of this.requests.entries()) {
      const validRequests = history.filter((ts) => ts > windowStart);
      if (validRequests.length === 0) {
        this.requests.delete(ip);
        cleaned++;
      } else {
        this.requests.set(ip, validRequests);
      }
    }

    return cleaned;
  }
}

class BanStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.banByIp = true;

    const fs = require("fs");
    const path = require("path");

    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this.bansFile = path.join(dataDir, "bans.json");
    // fingerprints por playerId — histórico de dispositivos vistos
    this.fingerprintsFile = path.join(dataDir, "fingerprints.json");

    this.bans = this._load(this.bansFile);              // banId -> banRecord
    this.fingerprints = this._load(this.fingerprintsFile); // playerId -> fpRecord
  }

  _load(filePath) {
    const fs = require("fs");
    try {
      if (fs.existsSync(filePath)) {
        return new Map(Object.entries(JSON.parse(fs.readFileSync(filePath, "utf8"))));
      }
    } catch (e) {
      console.error(`[BanStore] Falha ao carregar ${filePath}:`, e.message);
    }
    return new Map();
  }

  _save(filePath, map) {
    const fs = require("fs");
    try {
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(map), null, 2), "utf8");
    } catch (e) {
      console.error(`[BanStore] Falha ao salvar ${filePath}:`, e.message);
    }
  }

  // Chamado em todo login/registro para guardar o dispositivo daquele player.
  // Mantém um histórico (um player pode logar de vários aparelhos).
  recordFingerprint(playerId, fp) {
    const key = String(playerId);
    const now = nowSeconds();
    const existing = this.fingerprints.get(key) || { playerId, devices: [] };

    // fp = { deviceId, hardwareId, ip, platform, model }
    const already = existing.devices.find(
      (d) => d.deviceId === fp.deviceId && d.hardwareId === fp.hardwareId,
    );

    if (already) {
      already.lastSeen = now;
      already.ip = fp.ip;          // atualiza último IP visto
      already.seenCount = (already.seenCount || 1) + 1;
    } else {
      existing.devices.push({
        deviceId: fp.deviceId || null,
        hardwareId: fp.hardwareId || null,
        ip: fp.ip || null,
        platform: fp.platform || null,
        model: fp.model || null,
        firstSeen: now,
        lastSeen: now,
        seenCount: 1,
      });
    }

    this.fingerprints.set(key, existing);
    this._save(this.fingerprintsFile, this.fingerprints);
  }

  // Retorna o banRecord se este fingerprint casar com algum ban ativo, senão null.
  checkBanned(fp) {
    for (const ban of this.bans.values()) {
      if (!ban.active) continue;

      if (fp.deviceId && ban.deviceIds.includes(fp.deviceId)) return ban;
      if (fp.hardwareId && ban.hardwareIds.includes(fp.hardwareId)) return ban;
      if (this.banByIp && fp.ip && ban.ips.includes(fp.ip)) return ban;
    }
    return null;
  }

  // Bane um player: coleta TODOS os dispositivos/ips já vistos dele
  // e agrega no registro de ban (por isso o histórico de fingerprints importa).
  banPlayer(playerId, reason, admin = "console") {
    const key = String(playerId);
    const fp = this.fingerprints.get(key);

    const deviceIds = new Set();
    const hardwareIds = new Set();
    const ips = new Set();

    if (fp) {
      for (const d of fp.devices) {
        if (d.deviceId) deviceIds.add(d.deviceId);
        if (d.hardwareId) hardwareIds.add(d.hardwareId);
        if (d.ip) ips.add(d.ip);
      }
    }

    const banId = `ban_${playerId}_${nowSeconds()}`;
    const record = {
      banId,
      playerId,
      reason: reason || "Sem motivo especificado",
      admin,
      active: true,
      deviceIds: [...deviceIds],
      hardwareIds: [...hardwareIds],
      ips: [...ips],
      createdAt: nowSeconds(),
    };

    this.bans.set(banId, record);
    this._save(this.bansFile, this.bans);
    return record;
  }

  // Desbane por playerId (desativa todos os bans ativos daquele player).
  unbanPlayer(playerId) {
    let count = 0;
    for (const ban of this.bans.values()) {
      if (ban.active && String(ban.playerId) === String(playerId)) {
        ban.active = false;
        ban.unbannedAt = nowSeconds();
        count++;
      }
    }
    if (count > 0) this._save(this.bansFile, this.bans);
    return count;
  }

  isPlayerBanned(playerId) {
    for (const ban of this.bans.values()) {
      if (ban.active && String(ban.playerId) === String(playerId)) return ban;
    }
    return null;
  }

  listBans(activeOnly = true) {
    const out = [];
    for (const ban of this.bans.values()) {
      if (activeOnly && !ban.active) continue;
      out.push(ban);
    }
    return out;
  }
}

class DataStore {
  constructor(config) {
    this.config = config;
    this.fs = require("fs");
    this.path = require("path");

    this.serversFile = this.path.join(process.cwd(), "data", "servers.json");
    this.tokensFile = this.path.join(process.cwd(), "data", "tokens.json");

    const dataDir = this.path.join(process.cwd(), "data");
    if (!this.fs.existsSync(dataDir)) {
      this.fs.mkdirSync(dataDir, { recursive: true });
    }

    this.servers = this._load(this.serversFile);
    this.tokens = this._load(this.tokensFile);
    this._saveTimers = new Map();
  }

  // ===== GENERIC FILE OPERATIONS =====

  _load(filePath) {
    try {
      if (this.fs.existsSync(filePath)) {
        const data = this.fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(data);
        return new Map(Object.entries(parsed));
      }
    } catch (error) {
      console.error(`[ERROR] Failed to load ${filePath}:`, error.message);
    }
    return new Map();
  }

  _save(filePath, map) {
    try {
      const obj = Object.fromEntries(map);
      this.fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
    } catch (error) {
      console.error(`[ERROR] Failed to save ${filePath}:`, error.message);
    }
  }

  // ===== SERVER MANAGEMENT =====

  _saveDebounced(filePath, map, delayMs = 10000) {
    if (this._saveTimers.has(filePath)) return; // já há um save agendado

    const timer = setTimeout(() => {
      this._saveTimers.delete(filePath);
      this._save(filePath, map);
    }, delayMs);

    // unref() impede que o timer segure o processo aberto no shutdown
    if (timer.unref) timer.unref();
    this._saveTimers.set(filePath, timer);
  }

  flush() {
    for (const [, timer] of this._saveTimers) clearTimeout(timer);
    this._saveTimers.clear();
    this._save(this.serversFile, this.servers);
    this._save(this.tokensFile, this.tokens);
  }

  registerServer(serverData) {
    const now = nowSeconds();
    const existing = this.servers.get(serverData.serverId);

    const record = {
      serverId: serverData.serverId,
      name: serverData.name,
      ip: serverData.ip,
      port: serverData.port,
      serverType: serverData.serverType,
      region: serverData.region,
      maxPlayers: serverData.maxPlayers,
      playersOnline: serverData.playersOnline || 0,
      status: serverData.status || "Online",
      mapId: serverData.mapId || null,
      buildVersion: serverData.buildVersion,
      description: serverData.description || null,
      discordUrl: serverData.discordUrl || null,
      latencyMs: existing ? existing.latencyMs : null,
      registeredAt: existing ? existing.registeredAt : now,
      lastHeartbeatAt: now,
      wipeDate:
        serverData.wipeDate !== undefined
          ? serverData.wipeDate
          : existing
            ? existing.wipeDate
            : null,
    };

    this.servers.set(serverData.serverId, record);
    this._save(this.serversFile, this.servers);
    return record;
  }

  updateLatency(serverId, latencyMs) {
    const server = this.servers.get(serverId);
    if (!server) return null;

    server.latencyMs = latencyMs;
    this._save(this.serversFile, this.servers);
    return server;
  }

  updateHeartbeat(serverId, playersOnline, status, wipeDate) {
    const server = this.servers.get(serverId);
    if (!server) return null;

    server.lastHeartbeatAt = nowSeconds();
    server.playersOnline = playersOnline;
    if (wipeDate !== undefined) server.wipeDate = wipeDate;

    // ✅ Padronizado com o valor que o /join verifica ("Cheio").
    // Antes setava "FULL", que nenhuma outra parte do sistema reconhecia.
    if (playersOnline >= server.maxPlayers) {
      server.status = "Cheio";
    } else if (status) {
      server.status = status;
    }
    this._saveDebounced(this.serversFile, this.servers);
    return server;
  }

  getServer(serverId) {
    return this.servers.get(serverId);
  }

  getActiveServers(region = null) {
    const now = nowSeconds();
    const ttl = this.config.heartbeatTTLSeconds;
    const active = [];

    for (const server of this.servers.values()) {
      const timeSinceHeartbeat = now - server.lastHeartbeatAt;

      if (timeSinceHeartbeat <= ttl) {
        if (region === null || server.region === region) {
          active.push(server);
        }
      }
    }

    return active;
  }

  cleanupExpiredServers() {
    const now = nowSeconds();
    const ttl = this.config.heartbeatTTLSeconds;
    let removed = 0;

    for (const [serverId, server] of this.servers.entries()) {
      const timeSinceHeartbeat = now - server.lastHeartbeatAt;
      if (timeSinceHeartbeat > ttl) {
        this.servers.delete(serverId);
        removed++;
      }
    }

    if (removed > 0) {
      this._save(this.serversFile, this.servers);
    }

    return removed;
  }

  // ===== TOKEN MANAGEMENT =====

  createJoinToken(tokenData) {
    const record = {
      joinToken: tokenData.joinToken,
      serverId: tokenData.serverId,
      playerId: tokenData.playerId,
      playerName: tokenData.playerName,
      clientBuildVersion: tokenData.clientBuildVersion,
      expiresAt: tokenData.expiresAt,
      used: false,
    };

    this.tokens.set(tokenData.joinToken, record);
    this._save(this.tokensFile, this.tokens);
    return record;
  }

  validateToken(serverId, playerId, joinToken) {
    const token = this.tokens.get(joinToken);

    if (!token) {
      return { valid: false, reason: "token_not_found" };
    }

    const now = nowSeconds();

    if (now > token.expiresAt) {
      return { valid: false, reason: "token_expired" };
    }

    if (token.used) {
      return { valid: false, reason: "token_already_used" };
    }

    if (token.serverId !== serverId) {
      return { valid: false, reason: "server_mismatch" };
    }

    if (token.playerId !== playerId) {
      return { valid: false, reason: "player_mismatch" };
    }

    token.used = true;
    this._save(this.tokensFile, this.tokens);

    return {
      valid: true,
      playerName: token.playerName,
      clientBuildVersion: token.clientBuildVersion,
    };
  }

  cleanupExpiredTokens() {
    const now = nowSeconds();
    let removed = 0;

    for (const [tokenKey, token] of this.tokens.entries()) {
      if (now > token.expiresAt) {
        this.tokens.delete(tokenKey);
        removed++;
      }
    }

    if (removed > 0) {
      this._save(this.tokensFile, this.tokens);
    }

    return removed;
  }

  // ===== STATS =====

  getStats() {
    return {
      totalServers: this.servers.size,
      activeServers: this.getActiveServers().length,
      totalTokens: this.tokens.size,
    };
  }
}

function toPublicServer(server) {
  return {
    serverId: server.serverId,
    name: server.name,
    description: server.description ?? null,
    region: server.region,
    playersOnline: server.playersOnline,
    maxPlayers: server.maxPlayers,
    status: server.status,
    serverType: server.serverType,
    mapId: server.mapId ?? null,
    buildVersion: server.buildVersion,
    discordUrl: server.discordUrl ?? null,
    wipeDate: server.wipeDate ?? null,
    latencyMs: server.latencyMs ?? null,
  };
}

class AuthStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.jwtSecret = config.jwtSecret || "CHANGE_THIS_SECRET_KEY";
    this.jwtExpiry = config.jwtExpirySeconds || 86400 * 7;

    const dbDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(path.join(dbDir, "accounts.db"));
    this.db.pragma("journal_mode = WAL");
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        playerId INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        passwordHash TEXT,
        accountType TEXT NOT NULL CHECK(accountType IN ('email', 'guest')),
        playerName TEXT UNIQUE,
        balanceDC INTEGER DEFAULT 0,
        balanceDS INTEGER DEFAULT 0,
        guestDeviceId TEXT,
        kills INTEGER DEFAULT 0,
        deaths INTEGER DEFAULT 0,
        headshots INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        xp INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        CONSTRAINT check_auth CHECK (
          (accountType = 'email' AND email IS NOT NULL AND passwordHash IS NOT NULL) OR
          (accountType = 'guest' AND guestDeviceId IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS sessions (
        sessionId TEXT PRIMARY KEY,
        playerId INTEGER NOT NULL,
        deviceId TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS skins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playerId INTEGER NOT NULL,
        skinId INTEGER NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('weapon', 'character', 'world')),
        expiresAt INTEGER,
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_playerId ON sessions(playerId);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_skins_playerId ON skins(playerId);
    `);
  }

  _xpRequiredForLevel(level) {
    return Math.floor(100 * Math.pow(level, 1.5));
  }

  addXP(playerId, xpAmount) {
    if (xpAmount <= 0) {
      throw { status: 400, message: "XP amount must be positive" };
    }

    const account = this.db
      .prepare(`SELECT level, xp FROM accounts WHERE playerId = ?`)
      .get(playerId);

    if (!account) {
      throw { status: 404, message: "Conta não encontrada" };
    }

    let { level, xp } = account;
    xp += xpAmount;
    let levelsGained = 0;

    while (true) {
      const xpNeeded = this._xpRequiredForLevel(level);
      if (xp >= xpNeeded) {
        xp -= xpNeeded;
        level += 1;
        levelsGained++;
      } else {
        break;
      }
    }

    this.db
      .prepare(`UPDATE accounts SET level = ?, xp = ? WHERE playerId = ?`)
      .run(level, xp, playerId);

    return {
      level,
      xp,
      levelsGained,
      xpToNextLevel: this._xpRequiredForLevel(level),
    };
  }
  
  // Busca players por nick (parcial, case-insensitive). Limite pra não travar console.
  findPlayersByName(query, limit = 25) {
    return this.db
      .prepare(
        `SELECT playerId, playerName, accountType, level, kills, deaths, createdAt
         FROM accounts
         WHERE playerName LIKE ? COLLATE NOCASE
         ORDER BY playerName ASC
         LIMIT ?`,
      )
      .all(`%${query}%`, limit);
  }

  // Lista todos os players (paginado). offset/limit evitam despejar milhares de linhas.
  listAllPlayers(limit = 50, offset = 0) {
    const rows = this.db
      .prepare(
        `SELECT playerId, playerName, accountType, level, kills, deaths, createdAt
         FROM accounts
         ORDER BY createdAt DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);

    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM accounts`)
      .get().c;

    return { rows, total, limit, offset };
  }

  getProfile(playerId) {
    const account = this.db
      .prepare(
        `SELECT playerId, playerName, accountType, balanceDC, balanceDS,
                kills, deaths, headshots, level, xp, createdAt
         FROM accounts WHERE playerId = ?`,
      )
      .get(playerId);

    if (!account) {
      throw { status: 404, message: "Conta não encontrada" };
    }

    const skins = this.db
      .prepare(`SELECT skinId, category, expiresAt FROM skins WHERE playerId = ?`)
      .all(playerId);

    return {
      ...account,
      xpToNextLevel: this._xpRequiredForLevel(account.level),
      skins,
    };
  }

  updateStats(playerId, kills, deaths, headshots) {
    this.db
      .prepare(
        `
      UPDATE accounts 
      SET kills = kills + ?, deaths = deaths + ?, headshots = headshots + ?
      WHERE playerId = ?
    `,
      )
      .run(kills, deaths, headshots, playerId);
  }

  _generatePlayerId() {
    const min = 10000000;
    const max = 99999999;
    let playerId;
    let exists = true;

    while (exists) {
      playerId = Math.floor(Math.random() * (max - min + 1)) + min;
      const stmt = this.db.prepare(
        "SELECT playerId FROM accounts WHERE playerId = ?",
      );
      exists = stmt.get(playerId) !== undefined;
    }

    return playerId;
  }

  _createSession(playerId, deviceId) {
    const now = nowSeconds();
    const expiresAt = now + this.jwtExpiry;
    const sessionId = crypto.randomUUID();

    const token = jwt.sign({ playerId, sessionId, deviceId }, this.jwtSecret, {
      expiresIn: this.jwtExpiry,
    });

    this.db.prepare("DELETE FROM sessions WHERE playerId = ?").run(playerId);

    this.db
      .prepare(
        `
      INSERT INTO sessions (sessionId, playerId, deviceId, token, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(sessionId, playerId, deviceId, token, expiresAt, now);

    return { token, expiresAt };
  }

  async registerEmail(email, password, deviceId) {
    const existing = this.db
      .prepare("SELECT playerId FROM accounts WHERE email = ?")
      .get(email);
    if (existing) {
      throw { status: 409, message: "Email already registered" };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const playerId = this._generatePlayerId();
    const now = nowSeconds();

    this.db
      .prepare(
        `
      INSERT INTO accounts (playerId, email, passwordHash, accountType, createdAt)
      VALUES (?, ?, ?, 'email', ?)
    `,
      )
      .run(playerId, email, passwordHash, now);

    const session = this._createSession(playerId, deviceId);

    return {
      playerId,
      token: session.token,
      expiresAt: session.expiresAt,
      needsName: true,
    };
  }

  async loginOrRegisterEmail(email, password, deviceId) {
    const account = this.db
      .prepare(
        `
      SELECT playerId, passwordHash, playerName FROM accounts WHERE email = ?
    `,
      )
      .get(email);

    if (account) {
      const valid = await bcrypt.compare(password, account.passwordHash);
      if (!valid) {
        throw { status: 401, message: "Senha incorreta" };
      }

      const session = this._createSession(account.playerId, deviceId);

      return {
        playerId: account.playerId,
        token: session.token,
        expiresAt: session.expiresAt,
        needsName: !account.playerName,
        isNewAccount: false,
      };
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const playerId = this._generatePlayerId();
      const now = nowSeconds();

      this.db
        .prepare(
          `
        INSERT INTO accounts (playerId, email, passwordHash, accountType, createdAt)
        VALUES (?, ?, ?, 'email', ?)
      `,
        )
        .run(playerId, email, passwordHash, now);

      const session = this._createSession(playerId, deviceId);

      return {
        playerId,
        token: session.token,
        expiresAt: session.expiresAt,
        needsName: true,
        isNewAccount: true,
      };
    }
  }

  registerGuest(deviceId) {
    const existing = this.db
      .prepare("SELECT playerId FROM accounts WHERE guestDeviceId = ?")
      .get(deviceId);
    if (existing) {
      throw {
        status: 409,
        message: "Conta convidado já existe para este dispositivo",
      };
    }

    const playerId = this._generatePlayerId();
    const now = nowSeconds();

    this.db
      .prepare(
        `
      INSERT INTO accounts (playerId, guestDeviceId, accountType, createdAt)
      VALUES (?, ?, 'guest', ?)
    `,
      )
      .run(playerId, deviceId, now);

    const session = this._createSession(playerId, deviceId);

    return {
      playerId,
      token: session.token,
      expiresAt: session.expiresAt,
      needsName: true,
    };
  }

  loginGuest(deviceId) {
    const account = this.db
      .prepare(
        `
      SELECT playerId, playerName FROM accounts WHERE guestDeviceId = ?
    `,
      )
      .get(deviceId);

    if (!account) {
      throw { status: 404, message: "Conta convidado não encontrada para este dispositivo" };
    }

    const session = this._createSession(account.playerId, deviceId);

    return {
      playerId: account.playerId,
      token: session.token,
      expiresAt: session.expiresAt,
      needsName: !account.playerName,
    };
  }

  validateSession(token, deviceId) {
    let decoded;
    try {
      decoded = jwt.verify(token, this.jwtSecret);
    } catch (error) {
      return { valid: false, reason: "invalid_token" };
    }

    const session = this.db
      .prepare(
        `
      SELECT playerId, deviceId, expiresAt FROM sessions WHERE token = ?
    `,
      )
      .get(token);

    if (!session) {
      return { valid: false, reason: "session_not_found" };
    }

    if (nowSeconds() > session.expiresAt) {
      return { valid: false, reason: "session_expired" };
    }

    if (session.deviceId !== deviceId) {
      return { valid: false, reason: "device_mismatch" };
    }

    return { valid: true, playerId: session.playerId };
  }

  logout(token) {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  checkNameAvailable(playerName) {
    const existing = this.db
      .prepare("SELECT playerId FROM accounts WHERE playerName = ?")
      .get(playerName);
    return !existing;
  }

  setPlayerName(playerId, playerName) {
    if (!this.checkNameAvailable(playerName)) {
      throw { status: 409, message: "Nome já existe" };
    }

    this.db
      .prepare("UPDATE accounts SET playerName = ? WHERE playerId = ?")
      .run(playerName, playerId);
  }

  cleanupExpiredSessions() {
    const now = nowSeconds();
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expiresAt < ?")
      .run(now);
    return result.changes;
  }
}

//#region Push e notificações
// Formato em disco:
// {
//   "tokens": {
//     "<fcmToken>": {
//       playerId, deviceId, platform, model, utcOffsetMinutes, language,
//       createdAt, updatedAt, lastSeenAt, lastRaidPushAt, lastReengagementAt,
//       reengagementIndex, reengagementStreak
//     }
//   }
// }
class PushStore {
  constructor(config, logger) {
    this.logger = logger;
    this.filePath =
      config.pushStorePath || path.join(process.cwd(), "data", "push-tokens.json");

    this.tokens = new Map();
    this._dirty = false;
    this._flushTimer = null;

    this._load();

    this._flushTimer = setInterval(() => this.flush(), 5000);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.info(`[Push] Store vazio, será criado em ${this.filePath}`);
        return;
      }

      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const [token, rec] of Object.entries(raw.tokens || {})) {
        this.tokens.set(token, rec);
      }

      this.logger.info(`[Push] ${this.tokens.size} token(s) carregado(s).`);
    } catch (e) {
      this.logger.error(`[Push] Falha ao carregar store: ${e.message}`);
    }
  }

  flush() {
    if (!this._dirty) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const out = { tokens: Object.fromEntries(this.tokens) };
      const tmp = `${this.filePath}.tmp`;

      // Escrita atômica: um SIGKILL no meio de um writeFile direto deixaria o
      // arquivo truncado e todo mundo perderia as notificações.
      fs.writeFileSync(tmp, JSON.stringify(out), "utf8");
      fs.renameSync(tmp, this.filePath);

      this._dirty = false;
    } catch (e) {
      this.logger.error(`[Push] Falha ao gravar store: ${e.message}`);
    }
  }

  // ── Registro ──────────────────────────────────────────────────────────────

  registerToken(playerId, info) {
    const { fcmToken } = info;
    if (!fcmToken) return null;

    const agora = nowSeconds();
    const existente = this.tokens.get(fcmToken);

    const rec = {
      playerId: Number(playerId),
      deviceId: info.deviceId || existente?.deviceId || null,
      platform: info.platform || existente?.platform || null,
      model: info.model || existente?.model || null,
      utcOffsetMinutes:
        typeof info.utcOffsetMinutes === "number"
          ? info.utcOffsetMinutes
          : existente?.utcOffsetMinutes ?? 0,
      language: info.language || existente?.language || "pt-BR",
      createdAt: existente?.createdAt ?? agora,
      updatedAt: agora,
      lastSeenAt: agora,
      lastRaidPushAt: existente?.lastRaidPushAt ?? 0,
      lastReengagementAt: existente?.lastReengagementAt ?? 0,
      reengagementIndex: existente?.reengagementIndex ?? 0,
      reengagementStreak: 0,
    };

    this.tokens.set(fcmToken, rec);
    this._dirty = true;
    return rec;
  }

  removeToken(fcmToken) {
    const removido = this.tokens.delete(fcmToken);
    if (removido) this._dirty = true;
    return removido;
  }

  removeTokensOfPlayer(playerId) {
    let n = 0;
    for (const [token, rec] of this.tokens) {
      if (rec.playerId === Number(playerId)) {
        this.tokens.delete(token);
        n++;
      }
    }
    if (n > 0) this._dirty = true;
    return n;
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  getTokensForPlayer(playerId) {
    const alvo = Number(playerId);
    const out = [];
    for (const [token, rec] of this.tokens) {
      if (rec.playerId === alvo) out.push({ token, ...rec });
    }
    return out;
  }

  /** @returns {Map<number, Array<{token:string}>>} playerId → tokens */
  getTokensForPlayers(playerIds) {
    const alvos = new Set(playerIds.map(Number));
    const mapa = new Map();

    for (const [token, rec] of this.tokens) {
      if (!alvos.has(rec.playerId)) continue;
      if (!mapa.has(rec.playerId)) mapa.set(rec.playerId, []);
      mapa.get(rec.playerId).push({ token, ...rec });
    }

    return mapa;
  }

  // ── Atividade / cooldowns ─────────────────────────────────────────────────

  /** Marca os players como ativos: reengajamento e raid alert usam isto. */
  touchActivity(playerIds) {
    const alvos = new Set(playerIds.map(Number));
    const agora = nowSeconds();

    for (const rec of this.tokens.values()) {
      if (!alvos.has(rec.playerId)) continue;
      rec.lastSeenAt = agora;
      rec.reengagementStreak = 0;
      this._dirty = true;
    }
  }

  markRaidPush(fcmToken) {
    const rec = this.tokens.get(fcmToken);
    if (!rec) return;
    rec.lastRaidPushAt = nowSeconds();
    this._dirty = true;
  }

  markReengagement(fcmToken, novoIndice) {
    const rec = this.tokens.get(fcmToken);
    if (!rec) return;
    rec.lastReengagementAt = nowSeconds();
    rec.reengagementIndex = novoIndice;
    rec.reengagementStreak = (rec.reengagementStreak || 0) + 1;
    this._dirty = true;
  }

  listCandidatosReengajamento(opts) {
    const {
      inatividadeMinHoras = 24,
      inatividadeMaxDias = 30,
      cooldownHoras = 48,
      horaLocalMin = 11,
      horaLocalMax = 21,
      maxSemRetorno = 4,
    } = opts || {};

    const agora = nowSeconds();
    const out = [];
    const jaIncluidos = new Set(); // 1 push por player, não por aparelho

    for (const [token, rec] of this.tokens) {
      if (jaIncluidos.has(rec.playerId)) continue;

      const inativoHa = (agora - (rec.lastSeenAt || 0)) / 3600;
      if (inativoHa < inatividadeMinHoras) continue;
      if (inativoHa > inatividadeMaxDias * 24) continue;

      const desdeUltimo = (agora - (rec.lastReengagementAt || 0)) / 3600;
      if (desdeUltimo < cooldownHoras) continue;

      if ((rec.reengagementStreak || 0) >= maxSemRetorno) continue;

      const horaLocal = new Date(
        (agora + (rec.utcOffsetMinutes || 0) * 60) * 1000,
      ).getUTCHours();

      if (horaLocal < horaLocalMin || horaLocal > horaLocalMax) continue;

      jaIncluidos.add(rec.playerId);
      out.push({ token, ...rec });
    }

    return out;
  }

  getStats() {
    const porPlataforma = {};
    for (const rec of this.tokens.values()) {
      const p = rec.platform || "?";
      porPlataforma[p] = (porPlataforma[p] || 0) + 1;
    }

    return {
      tokens: this.tokens.size,
      players: new Set([...this.tokens.values()].map((r) => r.playerId)).size,
      porPlataforma,
    };
  }
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

class FcmSender {
  constructor(config, logger) {
    this.logger = logger;
    const fcm = config.fcm || {};

    this.projectId = fcm.projectId || null;
    this.serviceAccountPath = fcm.serviceAccountPath || null;
    this.dryRun = Boolean(fcm.dryRun);
    this.concurrency = fcm.concurrency || 10;

    this.enabled = Boolean(this.projectId && this.serviceAccountPath);

    if (!this.enabled) {
      logger.warn(
        "[FCM] projectId/serviceAccountPath ausentes — push DESATIVADO (modo log-only).",
      );
      return;
    }

    this._auth = new GoogleAuth({
      keyFile: this.serviceAccountPath,
      scopes: [FCM_SCOPE],
    });

    this._client = null;
    this._endpoint = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;
  }

  async _getClient() {
    if (!this._client) {
      this._client = await this._auth.getClient();
    }
    return this._client;
  }

  _montarMensagem(token, payload) {
    const data = {};
    for (const [k, v] of Object.entries(payload.data || {})) {
      data[k] = String(v); // FCM v1 exige data como <string, string>
    }

    return {
      message: {
        token,
        data,
        android: {
          priority: payload.priority === "normal" ? "NORMAL" : "HIGH",
          collapse_key: payload.collapseKey || undefined,
          ttl: payload.ttlSeconds ? `${payload.ttlSeconds}s` : undefined,
          notification: {
            title: payload.title,
            body: payload.body,
            channel_id: payload.channelId || "geral",
            tag: payload.tag || undefined,
            sound: "default",
            notification_priority:
              payload.priority === "normal" ? "PRIORITY_DEFAULT" : "PRIORITY_HIGH",
          },
        },
        apns: {
          headers: {
            "apns-priority": payload.priority === "normal" ? "5" : "10",
            "apns-collapse-id": payload.collapseKey || undefined,
          },
          payload: {
            aps: {
              alert: { title: payload.title, body: payload.body },
              sound: "default",
            },
          },
        },
      },
    };
  }

  async sendToToken(token, payload) {
    if (!this.enabled) {
      this.logger.warn(`[FCM] (log-only) DESCARTADO :: ${payload.title}`);
      return { token, ok: false, invalid: false, error: "FCM_DISABLED" };
    }

    try {
      const client = await this._getClient();
      const body = this._montarMensagem(token, payload);

      if (this.dryRun) body.validate_only = true;

      await client.request({
        url: this._endpoint,
        method: "POST",
        data: body,
      });

      return { token, ok: true, invalid: false };
    } catch (err) {
      const status = err?.response?.status;
      const fcmError =
        err?.response?.data?.error?.details?.[0]?.errorCode ||
        err?.response?.data?.error?.status ||
        err.message;

      const invalid =
        status === 404 ||
        fcmError === "UNREGISTERED" ||
        fcmError === "INVALID_ARGUMENT" ||
        fcmError === "NOT_FOUND";

      if (!invalid) {
        this.logger.warn(`[FCM] Falha (${status}): ${fcmError}`);
      }

      return { token, ok: false, invalid, error: String(fcmError) };
    }
  }

  async sendToTokens(tokens, payload) {
    const resultados = [];
    const fila = [...new Set(tokens)];
    const limite = Math.max(1, this.concurrency);

    while (fila.length > 0) {
      const lote = fila.splice(0, limite);
      const parciais = await Promise.all(
        lote.map((t) => this.sendToToken(t, payload)),
      );
      resultados.push(...parciais);
    }

    return resultados;
  }
}

const MENSAGENS_REENGAJAMENTO = [
  // Competitivas e provocativas
  {
    title: "Vão ficar com seu loot?",
    body: "Enquanto você está fora, alguém está ficando mais forte. Vai deixar?"
  },
  {
    title: "Estão passando você",
    body: "A ilha não espera. Entre, evolua e volte para a disputa."
  },
  {
    title: "Seu rival agradece",
    body: "Cada dia longe é mais recurso para quem continua jogando."
  },
  {
    title: "A ilha ficou competitiva",
    body: "Tem jogador crescendo rápido por aí. Hora de responder."
  },
  {
    title: "Vai entregar o território?",
    body: "Espaço vazio sempre encontra um novo dono."
  },
  {
    title: "Você ficou para trás?",
    body: "Só existe um jeito de descobrir. Entre e confira."
  },
  {
    title: "A concorrência não dorme",
    body: "Mas tudo bem. Você ainda pode estragar o dia deles."
  },
  {
    title: "Seu lugar está em jogo",
    body: "Volte antes que alguém decida ocupar."
  },
  {
    title: "O servidor seguiu em frente",
    body: "Agora é sua vez de alcançar — ou ultrapassar — todo mundo."
  },
  {
    title: "Hora da revanche",
    body: "Você ainda tem contas para acertar nessa ilha."
  },

  // Humoradas e provocativas
  {
    title: "Seu machado sente saudades",
    body: "Ele anda dizendo que você não corta mais como antigamente."
  },
  {
    title: "As árvores estão tranquilas",
    body: "Até demais. Entre e resolva esse problema."
  },
  {
    title: "O loot não vem sozinho",
    body: "Já tentamos conversar com ele. Não funcionou."
  },
  {
    title: "Sua base pediu ajuda",
    body: "Ela não falou nada, mas o silêncio foi preocupante."
  },
  {
    title: "Você abandonou a ilha?",
    body: "Porque ela definitivamente não abandonou seus recursos."
  },
  {
    title: "Cinco minutinhos",
    body: "É assim que começa. Depois você percebe que construiu uma fortaleza."
  },
  {
    title: "Más notícias",
    body: "Os outros jogadores também aprenderam a coletar recursos."
  },
  {
    title: "Seu inventário está leve",
    body: "Uma situação triste, porém totalmente reversível."
  },
  {
    title: "Diagnóstico: pouco loot",
    body: "Tratamento recomendado: entrar no servidor imediatamente."
  },
  {
    title: "A ilha está suspeita",
    body: "Calma demais. Melhor entrar e causar um pouco."
  },

  // Importância e urgência leve
  {
    title: "Muita coisa pode mudar",
    body: "Alguns dias fazem diferença em um servidor de sobrevivência."
  },
  {
    title: "Proteja seu progresso",
    body: "Entre para revisar seus recursos, equipamentos e próximos passos."
  },
  {
    title: "Não perca o ritmo",
    body: "Uma visita rápida pode manter você perto dos jogadores mais fortes."
  },
  {
    title: "Seu próximo avanço começa agora",
    body: "Colete, melhore sua base e prepare-se para o que vier."
  },
  {
    title: "A disputa continua",
    body: "Volte para acompanhar o servidor e planejar sua próxima jogada."
  },
  {
    title: "Hora de conferir a base",
    body: "Veja o que falta e deixe tudo pronto para sua próxima batalha."
  },
  {
    title: "Seu progresso importa",
    body: "Entre, organize seus recursos e continue evoluindo."
  },
  {
    title: "Não deixe a vantagem escapar",
    body: "Alguns minutos hoje podem fazer diferença na próxima disputa."
  },

  // Descontraídas
  {
    title: "Dá uma passada na ilha",
    body: "Sem compromisso. Só você, alguns recursos e possíveis confusões."
  },
  {
    title: "Bora buscar loot?",
    body: "Uma coleta rápida nunca fez mal. Quase nunca."
  },
  {
    title: "Tem espaço na mochila",
    body: "E isso é praticamente um convite para entrar."
  },
  {
    title: "A base ainda está lá",
    body: "Provavelmente. Melhor dar uma olhada."
  },
  {
    title: "Partiu sobrevivência?",
    body: "Entre, pegue recursos e tente não virar recurso de alguém."
  },
  {
    title: "Só uma voltinha",
    body: "Confira a base, colete alguma coisa e provoque os vizinhos."
  },
  {
    title: "A ilha chamou",
    body: "Ela quer saber quando você vai voltar a causar problemas."
  },
  {
    title: "Hora de fazer barulho",
    body: "O servidor está calmo demais sem você."
  },

  // Foco direto na competição entre jogadores
  {
    title: "Quem manda nessa ilha?",
    body: "Entre e lembre os outros jogadores."
  },
  {
    title: "Eles estão ficando confiantes",
    body: "Talvez confiantes demais. Faça uma visita."
  },
  {
    title: "Tem gente querendo seu lugar",
    body: "Mostre que ele ainda tem dono."
  },
  {
    title: "Suba no ranking da sobrevivência",
    body: "Mais recursos, mais poder e menos espaço para os rivais."
  },
  {
    title: "Construa. Domine. Repita.",
    body: "Sua próxima disputa já pode começar."
  },
  {
    title: "Não facilite para eles",
    body: "Volte, evolua e obrigue seus rivais a trabalharem mais."
  },
  {
    title: "A ilha precisa de um problema",
    body: "Entre e seja esse problema."
  },
  {
    title: "O topo não fica vazio",
    body: "Ou você volta para disputar, ou alguém ocupa."
  },
  {
    title: "Seus rivais ganharam folga",
    body: "Já está na hora de acabar com isso."
  },
  {
    title: "Volte para a briga",
    body: "Recursos esperando, território disputado e rivais confortáveis demais."
  }
];

function registrarRotasPush(app, deps) {
  const {
    config,
    logger,
    pushStore,
    fcm,
    jwtAuth,
    serverAuth,
    isPlayerOnline,
    rateLimiter,
  } = deps;

  const raidCooldownSegundos = config.push?.raidCooldownSeconds ?? 300;
  const limiter = rateLimiter ? rateLimiter.middleware() : (req, res, next) => next();

  // ── Cliente ───────────────────────────────────────────────────────────────

  app.post("/push/register", jwtAuth, limiter, (req, res) => {
    const { fcmToken, deviceId, platform, model, utcOffsetMinutes, language } = req.body;

    if (!fcmToken || typeof fcmToken !== "string" || fcmToken.length < 20) {
      return res.status(400).json({ ok: false, error: "Invalid fcmToken" });
    }

    const rec = pushStore.registerToken(req.playerId, {
      fcmToken,
      deviceId: deviceId || req.headers["x-device-id"] || null,
      platform,
      model,
      utcOffsetMinutes,
      language,
    });

    logger.info(
      `[Push] Token registrado: player=${req.playerId} platform=${rec.platform} model=${rec.model}`,
    );

    res.json({ ok: true });
  });

  app.post("/push/unregister", jwtAuth, (req, res) => {
    const { fcmToken } = req.body;

    if (fcmToken) {
      pushStore.removeToken(fcmToken);
    } else {
      pushStore.removeTokensOfPlayer(req.playerId);
    }

    logger.info(`[Push] Token removido: player=${req.playerId}`);
    res.json({ ok: true });
  });

  // ── Servidor de jogo ──────────────────────────────────────────────────────

  app.post("/push/activity", serverAuth, (req, res) => {
    const { playerIds } = req.body;

    if (!Array.isArray(playerIds)) {
      return res.status(400).json({ ok: false, error: "playerIds must be an array" });
    }

    pushStore.touchActivity(playerIds);
    res.json({ ok: true });
  });

  app.post("/push/raid-alert", serverAuth, async (req, res) => {
    const {
      serverId,
      serverName,
      playerIds,
      donoNome,
      atacanteNome,
      pecasAtingidas,
      algumaDestruida,
      posX,
      posY,
      posZ,
    } = req.body;

    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ ok: false, error: "playerIds must be a non-empty array" });
    }

    if (playerIds.length > 64) {
      return res.status(400).json({ ok: false, error: "Too many playerIds" });
    }

    const agora = nowSeconds();
    const mapa = pushStore.getTokensForPlayers(playerIds);

    let enviados = 0;
    let semToken = 0;
    let emCooldown = 0;
    let ignoradosOnline = 0;

    const payload = montarPayloadRaid({
      serverName,
      donoNome,
      atacanteNome,
      pecasAtingidas,
      algumaDestruida,
      serverId,
      posX,
      posY,
      posZ,
    });

    const tokensParaEnviar = [];

    for (const playerId of playerIds) {
      // O jogador pode estar fora do servidor de jogo mas com o app aberto no
      // menu/chat. Nesse caso o cliente já mostra o alerta in-app.
      if (typeof isPlayerOnline === "function" && isPlayerOnline(playerId)) {
        ignoradosOnline++;
        continue;
      }

      const tokens = mapa.get(Number(playerId));
      if (!tokens || tokens.length === 0) {
        semToken++;
        continue;
      }

      let algumPassou = false;
      for (const t of tokens) {
        if (agora - (t.lastRaidPushAt || 0) < raidCooldownSegundos) {
          continue;
        }
        tokensParaEnviar.push(t.token);
        algumPassou = true;
      }

      if (!algumPassou) emCooldown++;
    }

    if (tokensParaEnviar.length === 0) {
      return res.json({ ok: true, enviados: 0, semToken, emCooldown });
    }

    const resultados = await fcm.sendToTokens(tokensParaEnviar, payload);

    for (const r of resultados) {
      if (r.ok) {
        enviados++;
        pushStore.markRaidPush(r.token);
      } else {
        logger.warn(
          `[Push] Falha no token ${String(r.token).slice(0, 12)}...: ` +
            `${r.error} (invalid=${!!r.invalid})`
        );
        if (r.invalid) pushStore.removeToken(r.token);
      }
    }

    logger.info(
      `[Push] Raid alert '${serverName || serverId}': ${enviados} enviado(s), ` +
        `${semToken} sem token, ${emCooldown} em cooldown, ${ignoradosOnline} online.`,
    );

    res.json({ ok: true, enviados, semToken, emCooldown });
  });

  app.get("/push/stats", serverAuth, (req, res) => {
    res.json({ ok: true, ...pushStore.getStats() });
  });
}

function montarPayloadRaid(info) {
  const {
    serverName,
    donoNome,
    atacanteNome,
    pecasAtingidas,
    algumaDestruida,
    serverId,
    posX,
    posY,
    posZ,
  } = info;

  const quem = atacanteNome ? atacanteNome : "Alguém";
  const alvo = donoNome ? `a base de ${donoNome}` : "sua base";

  const title = algumaDestruida ? "⚠️ Sua base está caindo" : "⚠️ Sua base está sob ataque";

  let body;
  if (algumaDestruida) {
    body = `${quem} destruiu estruturas em ${alvo}.`;
  } else if (pecasAtingidas > 1) {
    body = `${quem} está atacando ${alvo} (${pecasAtingidas} estruturas atingidas).`;
  } else {
    body = `${quem} está atacando ${alvo}.`;
  }

  if (serverName) body += ` — ${serverName}`;

  return {
    title,
    body,
    channelId: "raid_alerts",
    priority: "high",
    // Mesma collapseKey = a notificação nova SUBSTITUI a anterior na bandeja,
    // em vez de empilhar 5 avisos do mesmo raid.
    collapseKey: `raid_${serverId || "srv"}`,
    tag: `raid_${serverId || "srv"}`,
    ttlSeconds: 900, // 15 min: alerta de raid velho não serve pra nada
    data: {
      tipo: "raid",
      serverId: serverId || "",
      posX: posX ?? 0,
      posY: posY ?? 0,
      posZ: posZ ?? 0,
      atacante: atacanteNome || "",
    },
  };
}

function iniciarJobsDePush(deps) {
  const { config, logger, pushStore, fcm } = deps;

  const opts = {
    intervaloMinutos: config.push?.reengagementIntervalMinutes ?? 60,
    maxPorRodada: config.push?.reengagementMaxPerRun ?? 200,
    inatividadeMinHoras: config.push?.reengagementInactiveHours ?? 24,
    inatividadeMaxDias: config.push?.reengagementMaxInactiveDays ?? 30,
    cooldownHoras: config.push?.reengagementCooldownHours ?? 48,
    horaLocalMin: config.push?.quietHoursEnd ?? 11,
    horaLocalMax: config.push?.quietHoursStart ?? 21,
    maxSemRetorno: config.push?.reengagementMaxStreak ?? 4,
    habilitado: config.push?.reengagementEnabled !== false,
  };

  if (!opts.habilitado) {
    logger.info("[Push] Reengajamento desabilitado por config.");
    return;
  }

  const rodar = async () => {
    try {
      const candidatos = pushStore
        .listCandidatosReengajamento(opts)
        .slice(0, opts.maxPorRodada);

      if (candidatos.length === 0) return;

      let enviados = 0;

      for (const c of candidatos) {
        const idx = (c.reengagementIndex || 0) % MENSAGENS_REENGAJAMENTO.length;
        const msg = MENSAGENS_REENGAJAMENTO[idx];

        const r = await fcm.sendToToken(c.token, {
          title: msg.title,
          body: msg.body,
          channelId: "novidades",
          priority: "normal",
          collapseKey: "reengajamento",
          tag: "reengajamento",
          ttlSeconds: 12 * 3600,
          data: { tipo: "reengajamento" },
        });

        if (r.ok) {
          pushStore.markReengagement(c.token, idx + 1);
          enviados++;
        } else if (r.invalid) {
          pushStore.removeToken(r.token);
        }
      }

      pushStore.flush();
      logger.info(
        `[Push] Reengajamento: ${enviados}/${candidatos.length} enviado(s).`,
      );
    } catch (e) {
      logger.error(`[Push] Job de reengajamento falhou: ${e.message}`);
    }
  };

  const intervalo = Math.max(5, opts.intervaloMinutos) * 60 * 1000;
  const timer = setInterval(rodar, intervalo);
  if (timer.unref) timer.unref();

  logger.info(
    `[Push] Job de reengajamento ativo (a cada ${opts.intervaloMinutos} min, ` +
      `inativos > ${opts.inatividadeMinHoras}h, janela local ${opts.horaLocalMin}h–${opts.horaLocalMax}h).`,
  );
}
//#endregion

// ===== LOAD CONFIG =====
let config;
try {
  config = loadConfig();
} catch (error) {
  console.error("[FATAL]", error.message);
  process.exit(1);
}

const logger = new Logger(config.logLevel);
const store = new DataStore(config);
const authStore = new AuthStore(config, logger);
const banStore = new BanStore(config, logger);
const rateLimiter = new RateLimiter(config, logger);
const pushStore = new PushStore(config, logger);
const fcm = new FcmSender(config, logger);
const app = express();
const chatClients = new Map();
const shopStore = new ShopStore(authStore.db, config, logger);

function extractFingerprint(req) {
  return {
    deviceId: req.body.deviceId || null,
    hardwareId: req.body.hardwareId || null,
    platform: req.body.platform || null,       // "android" | "windows"
    model: req.body.model || null,             // modelo do aparelho/PC
    ip: req.ip || null,
  };
}

// ===== MIDDLEWARE =====
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path} from ${req.ip}`);
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Server-Key");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json());
app.set("trust proxy", true);

const serverAuth = serverAuthMiddleware(config, logger);
const jwtAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ ok: false, error: "Missing or invalid token" });
  }

  const token = authHeader.substring(7);
  const deviceId = req.headers["x-device-id"];

  if (!deviceId) {
    return res.status(401).json({ ok: false, error: "Missing device ID" });
  }

  const validation = authStore.validateSession(token, deviceId);
  if (!validation.valid) {
    return res
      .status(401)
      .json({ ok: false, error: "Invalid session", reason: validation.reason });
  }

  req.playerId = validation.playerId;
  req.token = token;
  next();
};

registrarRotasLoja(app, {
  config, logger, shopStore, authStore, jwtAuth, serverAuth, rateLimiter, onCredited,
});


//#region Rotas servidores

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowSeconds() });
});

// Server registration
app.post("/servers/register", serverAuth, (req, res) => {
  const {
    serverId,
    name,
    ip,
    port,
    region,
    maxPlayers,
    mapId,
    buildVersion,
    serverType,
    description,
    discordUrl,
    wipeDate
  } = req.body;

  const validation = validateRequired(
    [
      "serverId",
      "name",
      "ip",
      "port",
      "region",
      "maxPlayers",
      "buildVersion",
      "serverType",
    ],
    req.body,
  );
  if (validation) {
    logger.warn("Server registration failed: missing required fields");
    return res.status(400).json({ ok: false, error: validation });
  }

  if (wipeDate != null && typeof wipeDate !== "string") {
    return res.status(400).json({ ok: false, error: "wipeDate must be an ISO-8601 string or null" });
  }
  if (description != null && String(description).length > 500) {
    return res.status(400).json({ ok: false, error: "description too long (max 500)" });
  }

  const typeValidation = validateTypes(
    { port: "number", maxPlayers: "number" },
    req.body,
  );
  if (typeValidation) {
    return res.status(400).json({ ok: false, error: typeValidation });
  }

  const validServerTypes = ["community", "official", "modded"];
  if (!validServerTypes.includes(serverType)) {
    return res.status(400).json({
      ok: false,
      error: `serverType must be one of: ${validServerTypes.join(", ")}`,
    });
  }

  const serverData = {
    serverId,
    name,
    ip,
    port,
    region,
    maxPlayers,
    playersOnline: 0,
    mapId,
    buildVersion,
    serverType,
    description,
    discordUrl,
    wipeDate
  };

  store.registerServer(serverData);
  logger.info(
    `Server registered: ${serverId} (${name}) [${serverType}] (${ip}:${port})`,
  );
  res.json({ ok: true });
});

// Server heartbeat
app.post("/servers/heartbeat", serverAuth, (req, res) => {
  const { serverId, playersOnline, status, wipeDate } = req.body;

  const validation = validateRequired(["serverId", "playersOnline"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  const typeValidation = validateTypes({ playersOnline: "integer" }, req.body);
  if (typeValidation) {
    return res.status(400).json({ ok: false, error: typeValidation });
  }

  if (playersOnline < 0) {
    return res
      .status(400)
      .json({ ok: false, error: "playersOnline must be >= 0" });
  }

  const validStatuses = ["Online", "Cheio", "Offline", "Manutenção"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      error: `Status must be one of: ${validStatuses.join(", ")}`,
    });
  }

  if (
    wipeDate !== undefined &&
    wipeDate !== null &&
    typeof wipeDate !== "string"
  ) {
    return res
      .status(400)
      .json({ ok: false, error: "wipeDate must be an ISO-8601 string or null" });
  }

  const server = store.updateHeartbeat(serverId, playersOnline, status, wipeDate);
  if (!server) {
    logger.warn(`Heartbeat failed: server not found ${serverId}`);
    return res.status(404).json({
      ok: false,
      error: "Server not found",
    });
  }

  logger.debug(`Heartbeat received: ${serverId} (${playersOnline} players)`);
  res.json({ ok: true });
});

// Server latency update
app.post("/servers/latency", serverAuth, (req, res) => {
  const { serverId, latencyMs } = req.body;

  const validation = validateRequired(["serverId", "latencyMs"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  if (typeof latencyMs !== "number" || latencyMs < 0) {
    return res.status(400).json({
      ok: false,
      error: "latencyMs must be a positive number",
    });
  }

  const server = store.updateLatency(serverId, latencyMs);
  if (!server) {
    logger.warn(`Latency update failed: server not found ${serverId}`);
    return res.status(404).json({ ok: false, error: "Server not found" });
  }

  logger.debug(`Latency updated: ${serverId} (${latencyMs}ms)`);
  res.json({ ok: true });
});

// Server listing
app.get("/servers", rateLimiter.middleware(), (req, res) => {
  const region = req.query.region || null;
  const servers = store.getActiveServers(region).map(toPublicServer);
  logger.debug(
    `Server list requested: ${servers.length} servers (region: ${region || "all"})`,
  );
  res.json({ servers });
});


// Join token issuance
app.post("/join", rateLimiter.middleware(), (req, res) => {
  const { serverId, playerName, clientBuildVersion } = req.body;

  const validation = validateRequired(
    ["serverId", "playerName", "clientBuildVersion"],
    req.body,
  );
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  if (!config.allowedClientBuilds.includes(clientBuildVersion)) {
    logger.warn(
      `Join rejected: incompatible client build ${clientBuildVersion}`,
    );
    return res.status(400).json({
      ok: false,
      error: "Incompatible client version",
      latestBuild: config.latestClientBuild,
    });
  }

  const server = store.getServer(serverId);
  if (!server) {
    return res.status(409).json({
      ok: false,
      error: "Server not available",
      details: "Server not found or offline",
    });
  }

  const now = nowSeconds();
  const timeSinceHeartbeat = now - server.lastHeartbeatAt;
  if (timeSinceHeartbeat > config.heartbeatTTLSeconds) {
    return res.status(409).json({
      ok: false,
      error: "Server not available",
      details: "Server is offline",
    });
  }

  if (server.status === "Cheio") {
    return res.status(409).json({
      ok: false,
      error: "Server full",
      details: "Server has reached maximum capacity",
    });
  }

  if (server.status === "Offline" || server.status === "Manutenção") {
    return res.status(409).json({
      ok: false,
      error: "Server not available",
      details: `Server status: ${server.status}`,
    });
  }

  const playerId = generateGuid();
  const joinToken = generateJoinToken();
  const expiresAt = now + config.tokenTTLSeconds;

  const tokenData = {
    joinToken,
    serverId,
    playerId,
    playerName,
    clientBuildVersion,
    expiresAt,
  };

  store.createJoinToken(tokenData);
  logger.info(
    `Join token issued: ${playerName} -> ${server.name} (expires in ${config.tokenTTLSeconds}s)`,
  );

  res.json({
    ok: true,
    ip: server.ip,
    port: server.port,
    playerId,
    joinToken,
    expiresAt,
  });
});

// Join token validation
app.post("/join/validate", serverAuth, (req, res) => {
  const { serverId, playerId, joinToken } = req.body;

  logger.info(`[VALIDATE] Request from ${req.ip}`);
  logger.debug(`[VALIDATE] Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(
    `[VALIDATE] Body: serverId=${serverId}, playerId=${playerId}, token=${joinToken?.substring(0, 8)}...`,
  );

  const validation = validateRequired(
    ["serverId", "playerId", "joinToken"],
    req.body,
  );
  if (validation) {
    logger.warn("[VALIDATE] Missing required fields");
    return res.status(400).json({ ok: false, error: validation });
  }

  const result = store.validateToken(serverId, playerId, joinToken);

  if (!result.valid) {
    logger.warn(
      `[VALIDATE] Token validation failed: ${result.reason} (serverId=${serverId}, playerId=${playerId})`,
    );
    return res.json({
      ok: true,
      valid: false,
      reason: result.reason,
    });
  }

  logger.info(
    `[VALIDATE] ✓ Token validated: ${result.playerName} joined server ${serverId}`,
  );

  res.json({
    ok: true,
    valid: true,
    playerId: playerId,
    clientBuildVersion: result.clientBuildVersion,
  });
});

// Stats
app.get("/stats", (req, res) => {
  res.json(store.getStats());
});

//#endregion

//#region Rotas Contas

app.post("/auth/email", rateLimiter.middleware(), async (req, res) => {
  const { email, password, deviceId, clientBuildVersion } = req.body;

  const validation = validateRequired(
    ["email", "password", "deviceId", "clientBuildVersion"],
    req.body,
  );
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  if (!config.allowedClientBuilds.includes(clientBuildVersion)) {
    logger.warn(`Email auth rejected: incompatible client build ${clientBuildVersion}`);
    return res.status(400).json({
      ok: false,
      error: "Incompatible client version",
      latestBuild: config.latestClientBuild,
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Invalid email format" });
  }

  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
  }

  // 🔒 checagem de ban ANTES de logar/registrar (bloqueia device/hardware/ip banido)
  const fp = extractFingerprint(req);
  const ban = banStore.checkBanned(fp);
  if (ban) {
    logger.warn(`Email auth BLOQUEADO (banido): ${email} | motivo=${ban.reason}`);
    return res.status(403).json({
      ok: false,
      error: "Conta ou dispositivo banido",
      reason: ban.reason,
      banned: true,
    });
  }

  try {
    const result = await authStore.loginOrRegisterEmail(email, password, deviceId);

    // registra o fingerprint deste player (histórico de dispositivos)
    banStore.recordFingerprint(result.playerId, fp);

    // se a conta em si estiver banida por playerId, bloqueia também
    const playerBan = banStore.isPlayerBanned(result.playerId);
    if (playerBan) {
      return res.status(403).json({
        ok: false,
        error: "Conta banida",
        reason: playerBan.reason,
        banned: true,
      });
    }

    logger.info(`Email auth: ${email} -> playerId ${result.playerId} (new: ${result.isNewAccount})`);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Email auth error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/auth/guest", rateLimiter.middleware(), (req, res) => {
  const { deviceId, clientBuildVersion } = req.body;

  const validation = validateRequired(["deviceId", "clientBuildVersion"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  if (!config.allowedClientBuilds.includes(clientBuildVersion)) {
    logger.warn(`Guest auth rejected: incompatible client build ${clientBuildVersion}`);
    return res.status(400).json({
      ok: false,
      error: "Incompatible client version",
      latestBuild: config.latestClientBuild,
    });
  }

  // 🔒 checagem de ban por device/hardware/ip
  const fp = extractFingerprint(req);
  const ban = banStore.checkBanned(fp);
  if (ban) {
    logger.warn(`Guest auth BLOQUEADO (banido): deviceId=${deviceId} | motivo=${ban.reason}`);
    return res.status(403).json({
      ok: false,
      error: "Dispositivo banido",
      reason: ban.reason,
      banned: true,
    });
  }

  try {
    let result;
    try {
      result = authStore.loginGuest(deviceId);
      result.isNewAccount = false;
    } catch (error) {
      if (error.status === 404) {
        result = authStore.registerGuest(deviceId);
        result.isNewAccount = true;
      } else {
        throw error;
      }
    }

    banStore.recordFingerprint(result.playerId, fp);

    const playerBan = banStore.isPlayerBanned(result.playerId);
    if (playerBan) {
      return res.status(403).json({
        ok: false,
        error: "Conta banida",
        reason: playerBan.reason,
        banned: true,
      });
    }

    logger.info(`Guest auth: deviceId ${deviceId} -> playerId ${result.playerId} (new: ${result.isNewAccount})`);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status && error.status !== 404) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Guest auth error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/auth/login/guest", rateLimiter.middleware(), (req, res) => {
  const { deviceId, clientBuildVersion } = req.body;

  const validation = validateRequired(["deviceId", "clientBuildVersion"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  if (!config.allowedClientBuilds.includes(clientBuildVersion)) {
    logger.warn(`Guest login rejected: incompatible client build ${clientBuildVersion}`);
    return res.status(400).json({
      ok: false,
      error: "Incompatible client version",
      latestBuild: config.latestClientBuild,
    });
  }

  // 🔒 checagem de ban por device/hardware/ip ANTES de logar
  const fp = extractFingerprint(req);
  const ban = banStore.checkBanned(fp);
  if (ban) {
    logger.warn(`Guest login BLOQUEADO (banido): deviceId=${deviceId} | motivo=${ban.reason}`);
    return res.status(403).json({
      ok: false,
      error: "Dispositivo banido",
      reason: ban.reason,
      banned: true,
    });
  }

  try {
    const result = authStore.loginGuest(deviceId);

    // registra o fingerprint deste player
    banStore.recordFingerprint(result.playerId, fp);

    // conta banida por playerId
    const playerBan = banStore.isPlayerBanned(result.playerId);
    if (playerBan) {
      return res.status(403).json({
        ok: false,
        error: "Conta banida",
        reason: playerBan.reason,
        banned: true,
      });
    }

    logger.info(`Guest login: deviceId ${deviceId} -> playerId ${result.playerId}`);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Guest login error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/auth/check-name", (req, res) => {
  const { playerName } = req.body;

  if (!playerName || playerName.length < 3 || playerName.length > 20) {
    return res
      .status(400)
      .json({ ok: false, error: "Name must be 3-20 characters" });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(playerName)) {
    return res.status(400).json({
      ok: false,
      error: "Name can only contain letters, numbers and underscore",
    });
  }

  const available = authStore.checkNameAvailable(playerName);
  res.json({ ok: true, available });
});

app.post("/auth/set-name", jwtAuth, (req, res) => {
  const { playerName } = req.body;

  if (!playerName || playerName.length < 3 || playerName.length > 20) {
    return res
      .status(400)
      .json({ ok: false, error: "Name must be 3-20 characters" });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(playerName)) {
    return res.status(400).json({
      ok: false,
      error: "Name can only contain letters, numbers and underscore",
    });
  }

  try {
    authStore.setPlayerName(req.playerId, playerName);
    logger.info(`Player ${req.playerId} set name: ${playerName}`);
    res.json({ ok: true, playerName });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Set name error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/auth/logout", jwtAuth, (req, res) => {
  authStore.logout(req.token);
  logger.info(`Player ${req.playerId} logged out`);
  res.json({ ok: true });
});

app.get("/auth/profile", jwtAuth, (req, res) => {
  try {
    const profile = authStore.getProfile(req.playerId);
    res.json({ ok: true, profile });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Profile error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/auth/validate-session", (req, res) => {
  const { token, deviceId } = req.body;

  const validation = validateRequired(["token", "deviceId"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  const result = authStore.validateSession(token, deviceId);
  res.json({ ok: true, ...result });
});

app.get("/players/search", jwtAuth, (req, res) => {
  const { query } = req.query;

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ ok: false, error: "Query must be at least 2 characters" });
  }

  if (query.trim().length > 30) {
    return res.status(400).json({ ok: false, error: "Query too long" });
  }

  try {
    const results = authStore.searchPlayers(req.playerId, query.trim());
    res.json({ ok: true, results });
  } catch (error) {
    logger.error("Search players error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/stats/update", serverAuth, (req, res) => {
  const { playerId, kills, deaths, headshots } = req.body;

  const validation = validateRequired(
    ["playerId", "kills", "deaths", "headshots"],
    req.body,
  );
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  const typeValidation = validateTypes(
    {
      playerId: "number",
      kills: "number",
      deaths: "number",
      headshots: "number",
    },
    req.body,
  );
  if (typeValidation) {
    return res.status(400).json({ ok: false, error: typeValidation });
  }

  try {
    authStore.updateStats(playerId, kills, deaths, headshots);
    logger.debug(
      `Stats updated for player ${playerId}: +${kills}K/${deaths}D/${headshots}H`,
    );
    res.json({ ok: true });
  } catch (error) {
    logger.error("Update stats error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/stats/xp", serverAuth, (req, res) => {
  const { playerId, xpAmount } = req.body;

  const validation = validateRequired(["playerId", "xpAmount"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  const typeValidation = validateTypes(
    { playerId: "number", xpAmount: "number" },
    req.body,
  );
  if (typeValidation) {
    return res.status(400).json({ ok: false, error: typeValidation });
  }

  try {
    const result = authStore.addXP(playerId, req.body.xpAmount);
    logger.info(
      `XP added for player ${playerId}: +${xpAmount}xp` +
      (result.levelsGained > 0 ? ` | LEVEL UP x${result.levelsGained} -> level ${result.level}` : ""),
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    logger.error("Add XP error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/players/online-status", jwtAuth, (req, res) => {
  const { playerIds } = req.body;

  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    return res.status(400).json({ ok: false, error: "playerIds must be a non-empty array" });
  }

  if (playerIds.length > 100) {
    return res.status(400).json({ ok: false, error: "Too many playerIds" });
  }

  const result = {};
  for (const id of playerIds) {
    result[id] = chatClients.has(id);
  }

  res.json({ ok: true, onlineStatus: result });
});
//#endregion

// ===== BACKGROUND JOBS =====
function startBackgroundJobs() {
  setInterval(() => {
    const removed = store.cleanupExpiredServers();
    if (removed > 0) {
      logger.info(`Cleanup: removed ${removed} expired server(s)`);
    }
  }, 1200000);

  setInterval(() => {
    const removed = store.cleanupExpiredTokens();
    if (removed > 0) {
      logger.debug(`Cleanup: removed ${removed} expired token(s)`);
    }
  }, 60000);

  setInterval(() => {
    const cleaned = rateLimiter.cleanup();
    if (cleaned > 0) {
      logger.debug(`Cleanup: removed ${cleaned} rate limit entries`);
    }
  }, 60000);

  setInterval(() => {
    const removed = authStore.cleanupExpiredSessions();
    if (removed > 0) {
      logger.debug(`Cleanup: removed ${removed} expired session(s)`);
    }
  }, 120000);
  iniciarJobsDePush({ config, logger, pushStore, fcm });
  iniciarReconciliacao({ shopStore, logger, onCredited });
  logger.info("Background cleanup jobs started");
}
iniciarJobsDaLoja({ shopStore, logger });

function kickFromChat(playerId, reason = "Você foi banido") {
  pushStore.removeTokensOfPlayer(playerId);
  const key = String(playerId);
  if (chatClients.has(key) || chatClients.has(playerId)) {
    const client = chatClients.get(key) || chatClients.get(playerId);
    if (client && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: "banned", reason }));
      setTimeout(() => client.ws.close(), 100);
    }
  }
}

// ===== ADMIN CONSOLE (stdin) =====
function startAdminConsole() {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "admin> ",
  });

  const help = () => {
    console.log(`
Comandos disponíveis:
  ban <playerId> [motivo...]   Bane um player (device + hardware + ip)
  unban <playerId>             Remove o banimento de um player
  list [all]                   Lista bans ativos (ou todos com "all")
  find <playerId>              Mostra dispositivos/ips conhecidos do player
  findnick <nick>              Busca players pelo nome (parcial)
  players [limit] [offset]     Lista todos os players (paginado)
  help                         Mostra esta ajuda
`);
  };

  console.log("\n[ADMIN] Console pronto. Digite 'help' para comandos.\n");
  rl.prompt();

  rl.on("line", (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();

    try {
      switch (cmd) {
        case "": break;

        case "help":
          help();
          break;

        case "ban": {
          const playerId = parts[1];
          if (!playerId) { console.log("Uso: ban <playerId> [motivo]"); break; }
          const reason = parts.slice(2).join(" ") || "Banido pelo admin";
          const rec = banStore.banPlayer(playerId, reason, "console");
          kickFromChat(playerId, reason);
          console.log(`✓ Player ${playerId} banido.`);
          console.log(`  Motivo: ${reason}`);
          console.log(`  Devices: ${rec.deviceIds.length} | Hardware: ${rec.hardwareIds.length} | IPs: ${rec.ips.length}`);
          if (rec.deviceIds.length === 0 && rec.hardwareIds.length === 0) {
            console.log("  ⚠ Nenhum fingerprint conhecido — só bane por playerId. O player pode ter nunca logado nesta versão.");
          }
          break;
        }
        case "findnick": {
          const q = parts.slice(1).join(" ");
          if (!q) { console.log("Uso: findnick <nick>"); break; }
          const rows = authStore.findPlayersByName(q);
          if (rows.length === 0) { console.log(`Nenhum player com nick contendo "${q}".`); break; }
          console.log(`\n${rows.length} resultado(s) para "${q}":`);
          for (const p of rows) {
            const banned = banStore.isPlayerBanned(p.playerId) ? " [BANIDO]" : "";
            console.log(`  ${p.playerId} | ${p.playerName || "(sem nome)"} | ${p.accountType} | lvl ${p.level} | ${p.kills}K/${p.deaths}D${banned}`);
          }
          console.log("");
          break;
        }
        case "pedido": {
          const orderId = parts[1];
          if (!orderId) { console.log("Uso: pedido <orderId>"); break; }
          reconcileOrderNow(orderId, { shopStore, logger, onCredited })
            .then((r) => console.log(r));
          break;
        }
        
        case "vendas": {
          const { rows, stuck } = relatorioPedidos(shopStore, parseInt(parts[1], 10) || 24);
          for (const r of rows) {
            console.log(`  ${r.status}: ${r.total} pedido(s) | R$ ${(r.cents / 100).toFixed(2)}`);
          }
          if (stuck.length > 0) {
            console.log(`\n  ⚠ ${stuck.length} pedido(s) travado(s):`);
            for (const s of stuck) console.log(`    ${s.orderId} | player ${s.playerId} | ${s.status} | ${s.checkCount} checagens`);
          }
          break;
        }
        case "players": {
          const limit = parseInt(parts[1], 10) || 50;
          const offset = parseInt(parts[2], 10) || 0;
          const { rows, total } = authStore.listAllPlayers(limit, offset);
          if (rows.length === 0) { console.log("Nenhum player encontrado."); break; }
          console.log(`\nPlayers ${offset + 1}-${offset + rows.length} de ${total}:`);
          for (const p of rows) {
            const banned = banStore.isPlayerBanned(p.playerId) ? " [BANIDO]" : "";
            const when = new Date(p.createdAt * 1000).toISOString().slice(0, 10);
            console.log(`  ${p.playerId} | ${p.playerName || "(sem nome)"} | ${p.accountType} | lvl ${p.level} | ${when}${banned}`);
          }
          if (offset + rows.length < total) {
            console.log(`  ... use: players ${limit} ${offset + limit}  (próxima página)`);
          }
          console.log("");
          break;
        }
        case "unban": {
          const playerId = parts[1];
          if (!playerId) { console.log("Uso: unban <playerId>"); break; }
          const count = banStore.unbanPlayer(playerId);
          console.log(count > 0
            ? `✓ Player ${playerId} desbanido (${count} ban(s) removido(s)).`
            : `Nenhum ban ativo encontrado para ${playerId}.`);
          break;
        }

        case "list": {
          const all = parts[1] === "all";
          const bans = banStore.listBans(!all);
          if (bans.length === 0) { console.log("Nenhum ban encontrado."); break; }
          console.log(`\n${bans.length} ban(s):`);
          for (const b of bans) {
            const status = b.active ? "ATIVO" : "inativo";
            const when = new Date(b.createdAt * 1000).toISOString();
            console.log(`  [${status}] player=${b.playerId} | ${b.reason} | devices=${b.deviceIds.length} ips=${b.ips.length} | ${when}`);
          }
          console.log("");
          break;
        }

        case "find": {
          const playerId = parts[1];
          if (!playerId) { console.log("Uso: find <playerId>"); break; }
          const fp = banStore.fingerprints.get(String(playerId));
          if (!fp) { console.log(`Nenhum fingerprint para ${playerId}.`); break; }
          console.log(`\nDispositivos de ${playerId}:`);
          for (const d of fp.devices) {
            console.log(`  - platform=${d.platform || "?"} model=${d.model || "?"}`);
            console.log(`    deviceId=${d.deviceId || "?"}`);
            console.log(`    hardwareId=${d.hardwareId || "?"}`);
            console.log(`    ip=${d.ip || "?"} | visto ${d.seenCount}x | último=${new Date(d.lastSeen * 1000).toISOString()}`);
          }
          const banned = banStore.isPlayerBanned(playerId);
          console.log(banned ? `  Status: BANIDO (${banned.reason})` : "  Status: livre");
          console.log("");
          break;
        }

        default:
          console.log(`Comando desconhecido: '${cmd}'. Digite 'help'.`);
      }
    } catch (e) {
      console.error("[ADMIN] Erro ao executar comando:", e.message);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    logger.info("[ADMIN] Console encerrado.");
  });
}

// ===== START SERVER =====
const httpServer = http.createServer(app);
registrarRotasPush(app, {
  config,
  logger,
  pushStore,
  fcm,
  jwtAuth,
  serverAuth,
  rateLimiter,
  isPlayerOnline: (playerId) => {
    if (config.push?.suprimirSeOnlineNoChat !== true) return false;
    return chatClients.has(Number(playerId)) || chatClients.has(String(playerId));
  },
});
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let registeredPlayerId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "chat_join") {
      const { token, deviceId, playerName } = msg;
      if (!token || !deviceId || !playerName) {
        ws.send(JSON.stringify({ type: "error", error: "Missing fields" }));
        return;
      }
      const validation = authStore.validateSession(token, deviceId);
      if (!validation.valid) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid session" }));
        ws.close();
        return;
      }

      registeredPlayerId = validation.playerId;

      if (chatClients.has(registeredPlayerId)) {
        const existingClient = chatClients.get(registeredPlayerId);
        if (existingClient.ws.readyState === 1) {
          existingClient.ws.send(JSON.stringify({
            type:   "session_displaced",
            reason: "Another device logged into your account",
          }));
        }
        setTimeout(() => existingClient.ws.close(), 100);
      }

      chatClients.set(registeredPlayerId, { ws, playerName });
      logger.info(`[Chat] Player joined: ${playerName} (${registeredPlayerId})`);

      ws.send(JSON.stringify({ type: "chat_joined", onlineCount: chatClients.size }));
      broadcastChatMeta();
      return;
    }

    if (!registeredPlayerId) {
      ws.send(JSON.stringify({ type: "error", error: "Not registered" }));
      return;
    }

    if (msg.type === "chat_message") {
      const text = (msg.text || "").trim();
      if (!text || text.length === 0) return;
      if (text.length > 200) {
        ws.send(JSON.stringify({ type: "error", error: "Message too long" }));
        return;
      }

      const client = chatClients.get(registeredPlayerId);
      const payload = JSON.stringify({
        type:       "chat_message",
        playerId:   registeredPlayerId,
        playerName: client.playerName,
        text,
        timestamp:  nowSeconds(),
      });

      console.log(`[Chat] ${client.playerName}: ${text}`);

      for (const [, c] of chatClients) {
        if (c.ws.readyState === 1)
          c.ws.send(payload);
      }
    }
  });

  ws.on("close", () => {
    if (registeredPlayerId && chatClients.has(registeredPlayerId)) {
      const client = chatClients.get(registeredPlayerId);
      logger.info(`[Chat] Player left: ${client.playerName}`);
      chatClients.delete(registeredPlayerId);
      broadcastChatMeta();
    }
  });

  ws.on("error", (err) => {
    logger.warn(`[WS] WebSocket error: ${err.message}`);
  });
});

function broadcastChatMeta() {
  const payload = JSON.stringify({
    type:        "chat_meta",
    onlineCount: chatClients.size,
  });
  for (const [, c] of chatClients) {
    if (c.ws.readyState === 1)
      c.ws.send(payload);
  }
}

httpServer.listen(config.port, config.host, () => {
  logger.info("=".repeat(60));
  logger.info(`${config.serverName} started`);
  logger.info(`Listening on ${config.host}:${config.port}`);
  logger.info(`Public URL: ${config.publicBaseUrl}`);
  logger.info(`Log level: ${config.logLevel}`);
  logger.info(`Token TTL: ${config.tokenTTLSeconds}s`);
  logger.info(`Heartbeat TTL: ${config.heartbeatTTLSeconds}s`);
  logger.info(`Allowed client builds: ${config.allowedClientBuilds.join(", ")}`);
  logger.info(`Rate limit: ${config.rateLimit.maxRequests} req/${config.rateLimit.windowSeconds}s`);
  logger.info("=".repeat(60));

  startBackgroundJobs();
  startAdminConsole(); 
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  store.flush();
  pushStore.flush();   // ✅ NOVO
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  store.flush();
  pushStore.flush();   // ✅ NOVO
  process.exit(0);
});