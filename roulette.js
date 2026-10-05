"use strict";

/**
 * Roleta controlada 100% pelo master.
 *
 * O cliente manda só { rouletteId, useFreeSpin }. Preço, moeda, slots, chances,
 * pity, giro grátis e reembolso de duplicata são decididos aqui.
 *
 * Config: data/roulette.json (recarregável via POST /roulette/reload).
 * Estado por jogador: tabela roulette_progress. Auditoria: roulette_spins.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RARITIES = ["common", "rare", "legendary"];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isInt(v, min = -Infinity) {
  return Number.isInteger(v) && v >= min;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Média, mediana, p90 e máximo de uma lista numérica (usado no simulador). */
function resumir(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
  return {
    media: s.reduce((a, b) => a + b, 0) / s.length,
    mediana: q(0.5),
    p90: q(0.9),
    min: s[0],
    max: s[s.length - 1],
  };
}

/** Sorteio ponderado com crypto (não usa Math.random). */
function pickWeighted(weights) {
  const entries = RARITIES
    .map((k) => [k, Math.round((weights[k] || 0) * 10000)])
    .filter(([, w]) => w > 0);

  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  if (total <= 0) return null;

  let roll = crypto.randomInt(total);
  for (const [k, w] of entries) {
    if (roll < w) return k;
    roll -= w;
  }
  return entries[entries.length - 1][0];
}

class RouletteStore {
  /**
   * @param db          instância better-sqlite3 (authStore.db)
   * @param logger      Logger do master
   * @param skinCatalog SkinCatalogStore — valida que toda skin da roleta existe em skins.json
   */
  constructor(db, { logger, skinCatalog, filePath } = {}) {
    this.db = db;
    this.logger = logger;
    this.skinCatalog = skinCatalog;
    this.filePath = filePath || path.join(process.cwd(), "data", "roulette.json");

    this.roulettes = new Map();
    this.activeId = null;

    this._initSchema();
    this._prepare();
    this.reload();
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roulette_progress (
        playerId            INTEGER NOT NULL,
        rouletteId          TEXT    NOT NULL,
        totalSpins          INTEGER NOT NULL DEFAULT 0,
        freeSpinProgress    INTEGER NOT NULL DEFAULT 0,
        freeSpinsAvailable  INTEGER NOT NULL DEFAULT 0,
        spinsSinceLegendary INTEGER NOT NULL DEFAULT 0,
        updatedAt           INTEGER NOT NULL,
        PRIMARY KEY (playerId, rouletteId),
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS roulette_spins (
        spinId         INTEGER PRIMARY KEY AUTOINCREMENT,
        playerId       INTEGER NOT NULL,
        rouletteId     TEXT    NOT NULL,
        slotIndex      INTEGER NOT NULL,
        skinId         INTEGER NOT NULL,
        rarity         TEXT    NOT NULL,
        wasFree        INTEGER NOT NULL,
        charged        INTEGER NOT NULL,
        currency       TEXT    NOT NULL,
        alreadyOwned   INTEGER NOT NULL,
        refundAmount   INTEGER NOT NULL,
        refundCurrency TEXT,
        pityTriggered  INTEGER NOT NULL,
        createdAt      INTEGER NOT NULL,
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_roulette_spins_player
        ON roulette_spins(playerId, createdAt);
    `);
  }

  _prepare() {
    const p = (sql) => this.db.prepare(sql);

    this._stmt = {
      account: p(`SELECT balanceDC, balanceDS FROM accounts WHERE playerId = ?`),
      owned: p(`SELECT skinId FROM skins WHERE playerId = ?`),
      insertSkin: p(
        `INSERT OR IGNORE INTO skins (playerId, skinId, acquiredAt, expiresAt) VALUES (?, ?, ?, 0)`,
      ),

      // Débito condicional: o WHERE é a trava anti-race (mesmo padrão do buySkin).
      debit: {
        DC: p(`UPDATE accounts SET balanceDC = balanceDC - ? WHERE playerId = ? AND balanceDC >= ?`),
        DS: p(`UPDATE accounts SET balanceDS = balanceDS - ? WHERE playerId = ? AND balanceDS >= ?`),
      },
      credit: {
        DC: p(`UPDATE accounts SET balanceDC = balanceDC + ? WHERE playerId = ?`),
        DS: p(`UPDATE accounts SET balanceDS = balanceDS + ? WHERE playerId = ?`),
      },

      getProgress: p(
        `SELECT totalSpins, freeSpinProgress, freeSpinsAvailable, spinsSinceLegendary
         FROM roulette_progress WHERE playerId = ? AND rouletteId = ?`,
      ),
      upsertProgress: p(
        `INSERT INTO roulette_progress
           (playerId, rouletteId, totalSpins, freeSpinProgress, freeSpinsAvailable, spinsSinceLegendary, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(playerId, rouletteId) DO UPDATE SET
           totalSpins          = excluded.totalSpins,
           freeSpinProgress    = excluded.freeSpinProgress,
           freeSpinsAvailable  = excluded.freeSpinsAvailable,
           spinsSinceLegendary = excluded.spinsSinceLegendary,
           updatedAt           = excluded.updatedAt`,
      ),
      logSpin: p(
        `INSERT INTO roulette_spins
           (playerId, rouletteId, slotIndex, skinId, rarity, wasFree, charged, currency,
            alreadyOwned, refundAmount, refundCurrency, pityTriggered, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
    };
  }

  // ── Config ────────────────────────────────────────────────────────────────

  /**
   * Valida um roulette.json inteiro SEM aplicar.
   * Usado pelo reload (tolerante: carrega o que for válido) e pelo painel (estrito).
   */
  validarRaw(raw) {
    const erros = [];
    const avisos = [];
    const map = new Map();

    if (!raw || typeof raw !== "object") {
      return { erros: ["o arquivo deve ser um objeto JSON"], avisos, map, activeId: null };
    }
    if (raw.roulettes !== undefined && !Array.isArray(raw.roulettes)) {
      erros.push("roulettes deve ser um array");
    }

    for (const r of Array.isArray(raw.roulettes) ? raw.roulettes : []) {
      try {
        const parsed = this._parse(r, avisos);
        if (map.has(parsed.rouletteId)) throw new Error("rouletteId duplicado");
        map.set(parsed.rouletteId, parsed);
      } catch (e) {
        erros.push(`'${(r && r.rouletteId) || "?"}': ${e.message || e}`);
      }
    }

    let activeId = null;
    if (raw.activeRouletteId != null && raw.activeRouletteId !== "") {
      if (map.has(raw.activeRouletteId)) activeId = raw.activeRouletteId;
      else erros.push(`activeRouletteId '${raw.activeRouletteId}' não existe ou é inválida`);
    }

    return { erros, avisos, map, activeId };
  }

  /** Recarrega do disco. Roletas inválidas são ignoradas; JSON quebrado mantém a config anterior. */
  reload() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(`[Roulette] ${this.filePath} não encontrado. Roleta desativada.`);
        this.roulettes = new Map();
        this.activeId = null;
        return 0;
      }

      const v = this.validarRaw(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      for (const a of v.avisos) this.logger.warn(`[Roulette] ${a}`);
      for (const e of v.erros) this.logger.error(`[Roulette] ${e}`);

      this.roulettes = v.map;
      this.activeId = v.activeId;
      this.logger.info(`[Roulette] ${v.map.size} roleta(s) carregada(s). Ativa: ${v.activeId || "nenhuma"}.`);
      return v.map.size;
    } catch (e) {
      this.logger.error("[Roulette] Falha ao carregar roulette.json (config anterior mantida):", e);
      return this.roulettes.size;
    }
  }

  /** Conteúdo cru do arquivo, do jeito que o admin edita. Lança se o JSON estiver quebrado. */
  lerRaw() {
    if (!fs.existsSync(this.filePath)) return { activeRouletteId: null, roulettes: [] };
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (e) {
      throw new Error(`roulette.json não é um JSON válido: ${e.message}`);
    }
  }

  /** Validação ESTRITA: qualquer roleta inválida recusa o arquivo inteiro. Grava atômico e aplica. */
  salvarRaw(raw) {
    const v = this.validarRaw(raw);
    if (v.erros.length) throw { status: 400, message: v.erros.join(" | ") };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);

    this.roulettes = v.map;
    this.activeId = v.activeId;
    this.logger.info(`[Roulette] roulette.json salvo pelo painel. Ativa: ${v.activeId || "nenhuma"}.`);
    return { count: v.map.size, activeId: v.activeId, avisos: v.avisos };
  }

  _parse(r, avisos = []) {
    const fail = (m) => {
      throw new Error(m);
    };

    if (!r || typeof r.rouletteId !== "string" || !r.rouletteId.trim()) fail("rouletteId obrigatório");
    if (!isInt(r.price, 0)) fail("price deve ser inteiro >= 0");
    const currency = r.currency === "DS" ? "DS" : "DC";

    // Chances base (pesos). São normalizadas pra exibição no cliente.
    const chances = {};
    for (const k of RARITIES) {
      const v = r.chances && r.chances[k] !== undefined ? r.chances[k] : 0;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`chances.${k} inválido`);
      chances[k] = v;
    }

    // Slots
    if (!Array.isArray(r.slots) || r.slots.length === 0) fail("slots vazio");

    const seen = new Set();
    const slots = [];
    const byRarity = { common: [], rare: [], legendary: [] };

    for (const s of r.slots) {
      if (!s || !isInt(s.slotIndex, 0)) fail(`slotIndex inválido: ${JSON.stringify(s)}`);
      if (seen.has(s.slotIndex)) fail(`slotIndex ${s.slotIndex} duplicado`);
      if (!isInt(s.skinId, 0)) fail(`skinId inválido no slot ${s.slotIndex}`);
      if (!RARITIES.includes(s.rarity)) fail(`rarity inválida no slot ${s.slotIndex} (use ${RARITIES.join("/")})`);
      if (this.skinCatalog && !this.skinCatalog.get(s.skinId)) {
        fail(`skin ${s.skinId} (slot ${s.slotIndex}) não existe em skins.json`);
      }

      seen.add(s.slotIndex);
      const slot = { slotIndex: s.slotIndex, skinId: s.skinId, rarity: s.rarity };
      slots.push(slot);
      byRarity[s.rarity].push(slot);
    }
    slots.sort((a, b) => a.slotIndex - b.slotIndex);

    if (slots.length !== 10) {
        avisos.push(`'${r.rouletteId}' tem ${slots.length} slots (o cliente tem 10).`);
      }

    // Só raridades com item contam pra normalização.
    const present = RARITIES.filter((k) => byRarity[k].length > 0);
    const total = present.reduce((acc, k) => acc + chances[k], 0);
    if (total <= 0) fail("a soma das chances das raridades presentes é 0");

    const displayChances = {};
    for (const k of RARITIES) {
      displayChances[k] = byRarity[k].length > 0 ? round2((chances[k] / total) * 100) : 0;
    }

    // Pity
    const pr = r.pity || {};
    let hardAt = pr.hardAt === undefined ? 0 : pr.hardAt;
    const softStart = pr.softStart === undefined ? 0 : pr.softStart;
    const softStepWeight = pr.softStepWeight === undefined ? 0 : pr.softStepWeight;

    if (!isInt(hardAt, 0)) fail("pity.hardAt deve ser inteiro >= 0");
    if (!isInt(softStart, 0)) fail("pity.softStart deve ser inteiro >= 0");
    if (typeof softStepWeight !== "number" || softStepWeight < 0) fail("pity.softStepWeight inválido");
    if (hardAt > 0 && softStart > 0 && softStart >= hardAt) fail("pity.softStart deve ser menor que pity.hardAt");

    if (hardAt > 0 && byRarity.legendary.length === 0) {
        avisos.push(`'${r.rouletteId}' tem pity mas nenhum lendário — pity desativado.`);
        hardAt = 0;
      }

    // Giro grátis
    const freeSpinThreshold = r.freeSpinThreshold === undefined ? 10 : r.freeSpinThreshold;
    if (!isInt(freeSpinThreshold, 0)) fail("freeSpinThreshold deve ser inteiro >= 0");

    // Reembolso de duplicata
    const dr = r.duplicateRefund || {};
    const duplicateRefund = { currency: dr.currency === "DC" ? "DC" : "DS" };
    for (const k of RARITIES) {
      const v = dr[k] === undefined ? 0 : dr[k];
      if (!isInt(v, 0)) fail(`duplicateRefund.${k} deve ser inteiro >= 0`);
      duplicateRefund[k] = v;
    }

    return {
      rouletteId: r.rouletteId,
      title: typeof r.title === "string" ? r.title : "",
      description: typeof r.description === "string" ? r.description : "",
      price: r.price,
      currency,
      chances,
      displayChances,
      featuredSkinId: isInt(r.featuredSkinId, 0) ? r.featuredSkinId : -1,
      freeSpinThreshold,
      pity: { hardAt, softStart, softStepWeight },
      preferUnowned: r.preferUnowned === true,
      duplicateRefund,
      slots,
      byRarity,
    };
  }

  getActive() {
    return this.activeId ? this.roulettes.get(this.activeId) || null : null;
  }

  // ── Estado do jogador ─────────────────────────────────────────────────────

  _getProgress(playerId, rouletteId) {
    return (
      this._stmt.getProgress.get(playerId, rouletteId) || {
        totalSpins: 0,
        freeSpinProgress: 0,
        freeSpinsAvailable: 0,
        spinsSinceLegendary: 0,
      }
    );
  }

  getConfigForPlayer(playerId) {
    const r = this.getActive();
    if (!r) return null;
    return this._toPublic(r, this._getProgress(playerId, r.rouletteId));
  }

  /** Formato que o RouletteConfigDto da Unity espera. */
  _toPublic(r, p) {
    return {
      rouletteId: r.rouletteId,
      title: r.title,
      description: r.description,
      spinPrice: r.price,
      currency: r.currency,
      chanceCommon: r.displayChances.common,
      chanceRare: r.displayChances.rare,
      chanceLegendary: r.displayChances.legendary,
      featuredSkinId: r.featuredSkinId,
      freeSpinThreshold: r.freeSpinThreshold,
      freeSpinProgress: p.freeSpinProgress,
      freeSpinsAvailable: p.freeSpinsAvailable,
      pityThreshold: r.pity.hardAt,
      spinsSinceLegendary: p.spinsSinceLegendary,
      slots: r.slots.map((s) => ({ slotIndex: s.slotIndex, skinId: s.skinId, rarity: s.rarity })),
    };
  }

  // ── Sorteio ───────────────────────────────────────────────────────────────

  /**
   * 1) Pity duro: no giro N sem lendário (N = hardAt), lendário garantido.
   * 2) Senão, sorteia a raridade por peso. Com pity suave, o peso do lendário
   *    sobe softStepWeight a cada giro depois de softStart.
   * 3) Dentro da raridade, sorteio uniforme entre os slots
   *    (preferUnowned = prioriza skins que o jogador ainda não tem).
   */
  _roll(r, progress, owned) {
    const n = progress.spinsSinceLegendary + 1; // número deste giro na sequência sem lendário
    const hasLegendary = r.byRarity.legendary.length > 0;

    let rarity;
    let pityTriggered = false;

    if (hasLegendary && r.pity.hardAt > 0 && n >= r.pity.hardAt) {
      rarity = "legendary";
      pityTriggered = true;
    } else {
      const w = {};
      for (const k of RARITIES) w[k] = r.byRarity[k].length > 0 ? r.chances[k] : 0;

      if (hasLegendary && r.pity.softStart > 0 && n > r.pity.softStart) {
        w.legendary += (n - r.pity.softStart) * r.pity.softStepWeight;
      }

      rarity = pickWeighted(w) || RARITIES.find((k) => r.byRarity[k].length > 0);
    }

    const pool = r.byRarity[rarity];
    let candidates = pool;

    if (r.preferUnowned) {
      const fresh = pool.filter((s) => !owned.has(s.skinId));
      if (fresh.length > 0) candidates = fresh;
    }

    return {
      slot: candidates[crypto.randomInt(candidates.length)],
      rarity,
      pityTriggered,
    };
  }

  // ── Simulador (painel) ────────────────────────────────────────────────────

  /**
   * 1) Distribuição: N giros seguidos de um jogador, com pity aplicado.
   * 2) Coleção: M jogadores começando do zero, girando até ter todas as skins.
   * Não toca no banco.
   */
  simular(rawRoulette, opts = {}) {
    let r;
    try {
      r = this._parse(rawRoulette, []);
    } catch (e) {
      throw { status: 400, message: `Roleta inválida: ${e.message || e}` };
    }

    const spins = Math.max(1000, Math.min(300000, Math.floor(opts.spins) || 100000));
    const players = Math.max(0, Math.min(1000, Math.floor(opts.players ?? 300)));
    const maxPorJogador = Math.max(10, Math.min(5000, Math.floor(opts.maxSpinsPerPlayer) || 2000));

    // ── 1) distribuição ──
    const contagem = { common: 0, rare: 0, legendary: 0 };
    const gaps = [];
    const vazio = new Set();
    const p = { spinsSinceLegendary: 0 };
    let pity = 0;
    let gap = 0;

    for (let i = 0; i < spins; i++) {
      const x = this._roll(r, p, vazio);
      contagem[x.rarity]++;
      if (x.pityTriggered) pity++;
      gap++;
      if (x.rarity === "legendary") {
        gaps.push(gap);
        gap = 0;
        p.spinsSinceLegendary = 0;
      } else {
        p.spinsSinceLegendary++;
      }
    }

    const esperado = {};
    const observado = {};
    for (const k of RARITIES) {
      esperado[k] = r.displayChances[k] / 100;
      observado[k] = contagem[k] / spins;
    }

    // ── 2) coleção completa ──
    let colecao = null;
    const unicas = new Set(r.slots.map((s) => s.skinId)).size;

    if (players > 0) {
      const giros = [], pagos = [], gratis = [], custo = [], reembolso = [];
      let completos = 0;

      for (let j = 0; j < players; j++) {
        const owned = new Set();
        const prog = { spinsSinceLegendary: 0 };
        let n = 0, pg = 0, fr = 0, freeProg = 0, freeAvail = 0, ref = 0;

        while (owned.size < unicas && n < maxPorJogador) {
          if (freeAvail > 0) {
            freeAvail--;
            fr++;
          } else {
            pg++;
            if (r.freeSpinThreshold > 0 && ++freeProg >= r.freeSpinThreshold) {
              freeProg = 0;
              freeAvail++;
            }
          }

          const x = this._roll(r, prog, owned);
          n++;

          if (owned.has(x.slot.skinId)) ref += r.duplicateRefund[x.rarity] || 0;
          else owned.add(x.slot.skinId);

          prog.spinsSinceLegendary = x.rarity === "legendary" ? 0 : prog.spinsSinceLegendary + 1;
        }

        if (owned.size >= unicas) completos++;
        giros.push(n);
        pagos.push(pg);
        gratis.push(fr);
        custo.push(pg * r.price);
        reembolso.push(ref);
      }

      colecao = {
        jogadores: players,
        maxPorJogador,
        completaramPct: completos / players,
        giros: resumir(giros),
        pagos: resumir(pagos),
        gratis: resumir(gratis),
        custo: resumir(custo),
        reembolso: resumir(reembolso),
      };
    }

    return {
      rouletteId: r.rouletteId,
      price: r.price,
      currency: r.currency,
      refundCurrency: r.duplicateRefund.currency,
      unicas,
      distribuicao: {
        spins,
        contagem,
        esperado,
        observado,
        pityPct: pity / spins,
        lendariosObtidos: gaps.length,
        lendarioACada: resumir(gaps),
      },
      colecao,
    };
  }

  // ── Giro ──────────────────────────────────────────────────────────────────

  /**
   * Tudo numa transação IMMEDIATE: débito, sorteio, entrega da skin, reembolso
   * de duplicata, progresso e log. Qualquer throw desfaz tudo (inclusive o débito).
   */
  spin(playerId, rouletteId, useFreeSpin) {
    const r = this.getActive();
    if (!r) throw { status: 404, code: "ROULETTE_UNAVAILABLE", message: "Roleta indisponível" };
    if (r.rouletteId !== rouletteId) {
      throw { status: 409, code: "ROULETTE_CHANGED", message: "A roleta foi atualizada" };
    }

    const tx = this.db.transaction(() => {
      const account = this._stmt.account.get(playerId);
      if (!account) throw { status: 404, code: "ACCOUNT_NOT_FOUND", message: "Conta não encontrada" };

      const p = this._getProgress(playerId, r.rouletteId);
      let charged = 0;

      if (useFreeSpin) {
        if (p.freeSpinsAvailable <= 0) {
          throw { status: 409, code: "NO_FREE_SPINS", message: "Você não tem giros grátis" };
        }
      } else if (r.price > 0) {
        const debit = this._stmt.debit[r.currency].run(r.price, playerId, r.price);
        if (debit.changes === 0) {
          throw {
            status: 402,
            code: "INSUFFICIENT_FUNDS",
            message: "Saldo insuficiente",
            currency: r.currency,
            price: r.price,
          };
        }
        charged = r.price;
      }

      const owned = new Set(this._stmt.owned.all(playerId).map((x) => x.skinId));
      const roll = this._roll(r, p, owned);
      const now = nowSeconds();

      // Entrega. 0 changes = já tinha → duplicata.
      const inserted = this._stmt.insertSkin.run(playerId, roll.slot.skinId, now);
      const alreadyOwned = inserted.changes === 0;

      const refundAmount = 0;
const refundCurrency = null;

      // Giro grátis: só giros pagos contam.
      let freeSpinProgress = p.freeSpinProgress;
      let freeSpinsAvailable = p.freeSpinsAvailable - (useFreeSpin ? 1 : 0);
      if (!useFreeSpin && r.freeSpinThreshold > 0) {
        freeSpinProgress++;
        if (freeSpinProgress >= r.freeSpinThreshold) {
          freeSpinProgress = 0;
          freeSpinsAvailable++;
        }
      }

      // Pity: todo giro conta (grátis inclusive). Lendário zera.
      const spinsSinceLegendary = roll.rarity === "legendary" ? 0 : p.spinsSinceLegendary + 1;

      this._stmt.upsertProgress.run(
        playerId, r.rouletteId, p.totalSpins + 1,
        freeSpinProgress, freeSpinsAvailable, spinsSinceLegendary, now,
      );

      this._stmt.logSpin.run(
        playerId, r.rouletteId, roll.slot.slotIndex, roll.slot.skinId, roll.rarity,
        useFreeSpin ? 1 : 0, charged, r.currency,
        alreadyOwned ? 1 : 0, refundAmount, refundCurrency,
        roll.pityTriggered ? 1 : 0, now,
      );

      const balances = this._stmt.account.get(playerId);

      return {
        result: {
          slotIndex: roll.slot.slotIndex,
          skinId: roll.slot.skinId,
          rarity: roll.rarity,
          wasFree: useFreeSpin,
          charged,
          freeSpinProgress,
          freeSpinsAvailable,
          spinsSinceLegendary,
          pityTriggered: roll.pityTriggered,
          alreadyOwned,
          refundAmount,
          refundCurrency: refundCurrency || "",
        },
        currency: r.currency,
        balanceDC: balances.balanceDC,
        balanceDS: balances.balanceDS,
      };
    });

    return tx.immediate();
  }
}

// ── Rotas ───────────────────────────────────────────────────────────────────

function registrarRotasRoleta(app, { logger, rouletteStore, jwtAuth, serverAuth, rateLimiter }) {
  // Config da roleta ativa + progresso do jogador.
  app.get("/roulette", jwtAuth, (req, res) => {
    try {
      const roulette = rouletteStore.getConfigForPlayer(req.playerId);
      if (!roulette) {
        return res.status(404).json({ ok: false, error: "Roleta indisponível", code: "ROULETTE_UNAVAILABLE" });
      }
      res.json({ ok: true, roulette });
    } catch (error) {
      logger.error("[Roulette] GET error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // Giro. O cliente manda só o id da roleta e se quer usar giro grátis.
  app.post("/roulette/spin", jwtAuth, rateLimiter.middleware(), (req, res) => {
    const { rouletteId, useFreeSpin } = req.body || {};

    if (typeof rouletteId !== "string" || !rouletteId) {
      return res.status(400).json({ ok: false, error: "rouletteId must be a string" });
    }
    if (useFreeSpin !== undefined && typeof useFreeSpin !== "boolean") {
      return res.status(400).json({ ok: false, error: "useFreeSpin must be a boolean" });
    }

    try {
      const out = rouletteStore.spin(req.playerId, rouletteId, useFreeSpin === true);
      const r = out.result;

      logger.info(
        `[Roulette] player ${req.playerId} girou '${rouletteId}' -> skin ${r.skinId} (${r.rarity}, slot ${r.slotIndex})` +
          (r.wasFree ? " | GRÁTIS" : ` | -${r.charged} ${out.currency}`) +
          (r.pityTriggered ? " | PITY" : "") +
          (r.alreadyOwned ? " | DUPLICATA (sem reembolso)" : ""),
      );

      res.json({ ok: true, result: r, balanceDC: out.balanceDC, balanceDS: out.balanceDS });
    } catch (error) {
      if (error && error.status) {
        return res.status(error.status).json({
          ok: false,
          error: error.message,
          code: error.code || null,
          currency: error.currency,
          price: error.price,
        });
      }
      logger.error("[Roulette] Spin error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // Recarrega roulette.json sem reiniciar o master.
  if (serverAuth) {
    app.post("/roulette/reload", serverAuth, (req, res) => {
      const count = rouletteStore.reload();
      res.json({ ok: true, count, activeRouletteId: rouletteStore.activeId });
    });
  }
}

module.exports = { RouletteStore, registrarRotasRoleta };