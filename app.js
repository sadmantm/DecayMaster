const express = require("express");
const { loadConfig, Logger } = require("./config");
const { DataStore } = require("./store");
const { AuthStore } = require("./auth-store");
const {
  generateGuid,
  generateJoinToken,
  nowSeconds,
  validateRequired,
  validateTypes,
  serverAuthMiddleware,
  RateLimiter,
} = require("./config");
const { WebSocketServer } = require("ws");
const http = require("http");
const { BanStore } = require("./ban-store");

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
const app = express();

// Extrai o fingerprint do dispositivo a partir do body + IP real.
// Colocar perto do topo, após a definição de jwtAuth.
function extractFingerprint(req) {
  return {
    deviceId: req.body.deviceId || null,
    hardwareId: req.body.hardwareId || null,   // <- novo campo do client
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
  };

  store.registerServer(serverData);
  logger.info(
    `Server registered: ${serverId} (${name}) [${serverType}] (${ip}:${port})`,
  );
  res.json({ ok: true });
});

// Server heartbeat
app.post("/servers/heartbeat", serverAuth, (req, res) => {
  const { serverId, playersOnline, status } = req.body;

  const validation = validateRequired(["serverId", "playersOnline"], req.body);
  if (validation) {
    return res.status(400).json({ ok: false, error: validation });
  }

  const validStatuses = ["Online", "Cheio", "Offline", "Manutenção"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      error: `Status must be one of: ${validStatuses.join(", ")}`,
    });
  }

  const server = store.updateHeartbeat(serverId, playersOnline, status);
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
  const servers = store.getActiveServers(region);
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

  logger.info("Background cleanup jobs started");
}

function kickFromChat(playerId, reason = "Você foi banido") {
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
const chatClients = new Map(); // playerId → { ws, playerName }

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
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  store.flush();
  process.exit(0);
});