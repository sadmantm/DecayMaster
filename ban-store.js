const { nowSeconds } = require("./config");
const fs = require("fs");
const path = require("path");

class BanStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // ⚠️ Match por IP causa falso positivo em CGNAT / IP compartilhado
    // (operadoras móveis BR, lan house, mesma casa). Deixe true só se
    // aceitar esse risco. deviceId + hardwareId já cobrem a maioria.
    this.banByIp = true;

    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this.bansFile = path.join(dataDir, "bans.json");
    // fingerprints por playerId — histórico de dispositivos vistos
    this.fingerprintsFile = path.join(dataDir, "fingerprints.json");

    this.bans = this._load(this.bansFile);              // banId -> banRecord
    this.fingerprints = this._load(this.fingerprintsFile); // playerId -> fpRecord
  }

  _load(filePath) {
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

module.exports = { BanStore };