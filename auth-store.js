const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { nowSeconds } = require("./config");
const path = require("path");
const fs = require("fs");

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
    const sessionId = require("crypto").randomUUID();

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

module.exports = { AuthStore };