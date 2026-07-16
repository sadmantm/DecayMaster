const { nowSeconds } = require("./config");

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

  updateHeartbeat(serverId, playersOnline, status) {
    const server = this.servers.get(serverId);
    if (!server) return null;
  
    server.lastHeartbeatAt = nowSeconds();
    server.playersOnline = playersOnline;
  
    // ✅ Padronizado com o valor que o /join verifica ("Cheio").
    // Antes setava "FULL", que nenhuma outra parte do sistema reconhecia.
    if (playersOnline >= server.maxPlayers) {
      server.status = "Cheio";
    } else if (status) {
      server.status = status;
    }
  
    // ✅ Debounce: heartbeats chegam a cada ~20s por servidor; não precisamos
    // de writeFileSync bloqueante a cada um. Estado de servidor é efêmero
    // (re-registro automático cobre perda), então atraso de até 10s é seguro.
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

module.exports = { DataStore };
