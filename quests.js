"use strict";

/**
 * Sistema de missões do master.
 *
 * Definições: data/quests.json      → mecânica (ações, alvos, quantidades,
 *                                      recompensas, rotação) + textos em português.
 *             data/quests.en.json   → títulos e descrições em inglês.
 *             data/quests.es.json   → títulos e descrições em espanhol.
 *             Os três são recarregados sozinhos quando mudam. Texto que falta
 *             numa tradução cai no português.
 * Progresso:  tabela quest_progress no accounts.db, uma linha por
 *             (jogador, missão, período). O PERÍODO faz o reset sozinho:
 *             "2026-10-19" (diária), "2026-W43" (semanal), "2026-10" (mensal),
 *             "initial" (nunca reseta). Nenhum cron apagando progresso.
 * Rotação:    tabela quest_rotation, uma linha por (categoria, período).
 *             O sorteio é gravado na primeira consulta do período e fica
 *             congelado: editar o quests.json no meio da semana NÃO troca as
 *             missões ativas. Missões novas entram no próximo sorteio; missões
 *             removidas do arquivo somem na hora.
 *
 * Idioma:     fica gravado na conta (accounts.language). O cliente manda
 *             "language" no login e em POST /auth/language quando o jogador
 *             troca o idioma. Daí em diante TODO snapshot sai nesse idioma,
 *             inclusive o do servidor de partida, que não precisa saber de
 *             idioma nenhum. Aceita "pt", "en", "es" (também "pt-BR",
 *             "en-US"...) ou o índice do SettingsManager (0 = pt, 1 = en,
 *             2 = es). A mecânica é a mesma em todos: só os textos mudam.
 *
 * Fluxo:
 *   cliente (login)     → POST /auth/email | /auth/guest | /auth/login/guest |
 *                         /auth/google | /auth/validate-session   { ..., language }
 *                         → a resposta de sucesso ganha "quests" (snapshot)
 *   cliente (opções)    → POST /auth/language      { language } → grava + snapshot
 *   servidor de partida → POST /quests/load        { serverId, accountId }
 *                         (no join, a cada expiresAt e quando o jogador troca de idioma)
 *   servidor de partida → POST /quests/report      (em lote) → progresso + resgate
 *   cliente (menu)      → GET  /quests/me          → snapshot (só leitura)
 *   painel              → /admin/api/quests/...    (registrarRotasAdminMissoes)
 *
 * Quem pontua é SÓ o servidor de partida (X-Server-Key). O cliente nunca
 * informa progresso.
 *
 * Janelas depois da virada de período:
 *   - progresso do período anterior: aceito por questGraceSeconds (padrão 10 min);
 *   - resgate de missão do período anterior JÁ CONCLUÍDA: aceito por
 *     questClaimGraceSeconds (padrão 24 h). O snapshot lista essas missões em
 *     "pendingClaims" para o servidor de partida pedir o resgate.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATEGORIAS = ["initial", "daily", "weekly", "monthly"];
const ROTATIVAS = ["daily", "weekly", "monthly"];
const KINDS_MOEDA = ["dc", "ds", "xp"];

const IDIOMAS = ["pt", "en", "es"]; // mesma ordem do dropdown de idioma no Unity
const IDIOMA_BASE = "pt";
const ROTULOS_PADRAO = {
  pt: { initial: "Tutorial", daily: "Diárias", weekly: "Semanais", monthly: "Mensais" },
  en: { initial: "Tutorial", daily: "Daily", weekly: "Weekly", monthly: "Monthly" },
  es: { initial: "Tutorial", daily: "Diarias", weekly: "Semanales", monthly: "Mensuales" },
};

// Limites da UI do jogo.
const MAX_RECOMPENSAS = 3;
const MAX_DESCRICAO = 41;

// O servidor de partida marca mudanças numa máscara de 64 bits por jogador.
const MAX_MISSOES_POR_JOGADOR = 64;
const MAX_ENTRADAS_POR_RELATORIO = 1000;
const RETENCAO_PROGRESSO_SEG = 90 * 86400;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** "pt-BR", "EN", 1, "1" → código suportado. Qualquer outra coisa → null. */
function normalizarIdioma(v) {
  if (typeof v === "number" || (typeof v === "string" && /^\d$/.test(v))) {
    return IDIOMAS[Number(v)] || null;
  }
  if (typeof v !== "string") return null;
  const curto = v.trim().toLowerCase().split(/[-_]/)[0];
  return IDIOMAS.includes(curto) ? curto : null;
}

/** Escrita atômica: grava ao lado e renomeia (o watcher nunca lê arquivo pela metade). */
function gravarJsonAtomico(arquivo, obj) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, arquivo);
}

class QuestStore {
  constructor(db, config, logger, authStore) {
    this.db = db;
    this.logger = logger;
    this.authStore = authStore;

    const dir = path.join(process.cwd(), "data");
    this.arquivo = path.join(dir, "quests.json");
    this.arquivosTraducao = {};
    for (const lang of IDIOMAS) {
      if (lang !== IDIOMA_BASE) this.arquivosTraducao[lang] = path.join(dir, `quests.${lang}.json`);
    }

    // Fuso do reset. -180 = UTC-3 (Brasília): diárias viram à meia-noite local.
    this.offsetSeg = Math.round((config.questUtcOffsetMinutes ?? -180) * 60);

    // Relatórios de PROGRESSO do período anterior ainda são aceitos por este
    // tempo: o flush do servidor pode chegar alguns segundos depois da virada.
    this.toleranciaSeg = config.questGraceSeconds ?? 600;

    // RESGATE de missão do período anterior que já estava concluída.
    this.toleranciaClaimSeg = Math.max(this.toleranciaSeg, config.questClaimGraceSeconds ?? 86400);

    // true = só servidores serverType "official" pontuam missões.
    this.somenteOficiais = config.questsOnlyOfficialServers === true;

    // DC é a moeda paga: por padrão NENHUMA missão pode dar DC.
    this.permitirDC = config.questsAllowPremiumRewards === true;

    // Idioma usado quando o jogador não informa um válido.
    this.idiomaPadrao = normalizarIdioma(config.questDefaultLanguage) || IDIOMA_BASE;

    this.def = QuestStore._defVazia();
    this.ultimaCarga = { erros: [], avisos: [], em: 0 };
    this._cacheRotacao = new Map();

    this._initSchema();
    this.reload();
    this._observarArquivos();
  }

  static _defVazia() {
    return {
      porId: new Map(),
      porCategoria: { initial: [], daily: [], weekly: [], monthly: [] },
      rotacao: {},
      rotulos: JSON.parse(JSON.stringify(ROTULOS_PADRAO)),
      initialSequential: false,
      initialDesde: 0,
    };
  }

  // ===== SCHEMA =====

  _initSchema() {
    // "progresso" (e não "current") porque CURRENT é palavra-chave do SQLite.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quest_progress (
        playerId    INTEGER NOT NULL,
        questId     TEXT    NOT NULL,
        period      TEXT    NOT NULL,
        progresso   INTEGER NOT NULL DEFAULT 0,
        completedAt INTEGER,
        rewardedAt  INTEGER,
        updatedAt   INTEGER NOT NULL,
        PRIMARY KEY (playerId, questId, period),
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_quest_progress_updated ON quest_progress(updatedAt);
      CREATE INDEX IF NOT EXISTS idx_quest_progress_period ON quest_progress(period, questId);

      CREATE TABLE IF NOT EXISTS quest_rotation (
        category  TEXT    NOT NULL,
        period    TEXT    NOT NULL,
        questIds  TEXT    NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (category, period)
      );
    `);

    // MAX(): o valor nunca regride. Um relatório atrasado ou repetido é inofensivo.
    this._stmtUpsert = this.db.prepare(`
      INSERT INTO quest_progress (playerId, questId, period, progresso, completedAt, rewardedAt, updatedAt)
      SELECT ?, ?, ?, ?, ?, NULL, ?
      WHERE EXISTS (SELECT 1 FROM accounts WHERE playerId = ?)
      ON CONFLICT(playerId, questId, period) DO UPDATE SET
        progresso   = MAX(progresso, excluded.progresso),
        completedAt = COALESCE(completedAt, excluded.completedAt),
        updatedAt   = excluded.updatedAt
    `);

    // O WHERE é a trava: só UMA chamada consegue mudar rewardedAt de NULL.
    this._stmtClaim = this.db.prepare(`
      UPDATE quest_progress SET rewardedAt = ?
      WHERE playerId = ? AND questId = ? AND period = ?
        AND rewardedAt IS NULL AND progresso >= ?
    `);

    this._stmtCreditarDC = this.db.prepare(
      `UPDATE accounts SET balanceDC = balanceDC + ? WHERE playerId = ?`,
    );
    this._stmtCreditarDS = this.db.prepare(
      `UPDATE accounts SET balanceDS = balanceDS + ? WHERE playerId = ?`,
    );

    this._stmtLerJogador = this.db.prepare(`
      SELECT questId, period, progresso, rewardedAt FROM quest_progress
      WHERE playerId = ? AND period IN (?, ?, ?, ?)
    `);

    // Concluídas e não resgatadas dos períodos anteriores (para pendingClaims).
    this._stmtLerPendentes = this.db.prepare(`
      SELECT questId, period, progresso FROM quest_progress
      WHERE playerId = ? AND period IN (?, ?, ?)
        AND rewardedAt IS NULL AND completedAt IS NOT NULL
    `);

    // Idioma preferido da conta. Contas antigas ficam NULL até o próximo login.
    const colunas = this.db.prepare(`PRAGMA table_info(accounts)`).all();
    if (colunas.length > 0 && !colunas.some((c) => c.name === "language")) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN language TEXT`);
      this.logger.info("[Quests] Coluna accounts.language criada.");
    }

    this._stmtConta = this.db.prepare(`SELECT createdAt, language FROM accounts WHERE playerId = ?`);
    this._stmtDefinirIdioma = this.db.prepare(
      `UPDATE accounts SET language = ? WHERE playerId = ? AND (language IS NULL OR language != ?)`,
    );

    this._stmtLerRotacao = this.db.prepare(
      `SELECT questIds FROM quest_rotation WHERE category = ? AND period = ?`,
    );
    // OR IGNORE: se dois processos sortearem juntos, vale o primeiro gravado.
    this._stmtGravarRotacao = this.db.prepare(
      `INSERT OR IGNORE INTO quest_rotation (category, period, questIds, createdAt) VALUES (?, ?, ?, ?)`,
    );
  }

  // ===== DEFINIÇÕES =====

  /** Lê os arquivos do disco. Lança se algum JSON estiver quebrado. */
  _lerArquivos() {
    if (!fs.existsSync(this.arquivo)) return null;
    const raw = JSON.parse(fs.readFileSync(this.arquivo, "utf8"));
    const traducoes = {};
    for (const [lang, arq] of Object.entries(this.arquivosTraducao)) {
      traducoes[lang] = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, "utf8")) : null;
    }
    return { raw, traducoes };
  }

  /**
   * Valida e monta as definições. Não toca em this.def.
   * erros  = missões ignoradas (ou o arquivo inteiro, no painel);
   * avisos = coisas que funcionam, mas merecem atenção (tradução faltando etc.).
   */
  _compilar(raw, traducoes) {
    const erros = [];
    const avisos = [];
    const def = QuestStore._defVazia();

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { def, erros: ["quests.json precisa ser um objeto"], avisos };
    }

    const acoes = raw.actions || {};
    const alvos = raw.targets || {};

    def.initialSequential = raw.initialSequential === true;
    def.initialDesde = Number.isInteger(raw.initialOnlyForAccountsCreatedAfter)
      ? raw.initialOnlyForAccountsCreatedAfter
      : 0;

    for (const cat of CATEGORIAS) {
      const n = raw.rotation ? raw.rotation[cat] : undefined;
      if (Number.isInteger(n) && n > 0) def.rotacao[cat] = n;
    }

    // Rótulos das categorias: padrão < arquivo.
    const aplicarRotulos = (lang, obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const cat of CATEGORIAS) {
        if (typeof obj[cat] === "string" && obj[cat].trim()) def.rotulos[lang][cat] = obj[cat].trim();
      }
    };
    aplicarRotulos(IDIOMA_BASE, raw.categoryLabels);
    for (const [lang, tr] of Object.entries(traducoes || {})) {
      if (tr) aplicarRotulos(lang, tr.categories);
    }

    // "target"/"item" aceitam um nome do bloco "targets" ou um ItemID numérico.
    // "*" ou ausente = qualquer alvo (só para objetivo, nunca para recompensa).
    const resolverItem = (valor, ctx, permiteQualquer) => {
      if (permiteQualquer && (valor === undefined || valor === null || valor === "*")) return 0;
      if (Number.isInteger(valor) && valor > 0) return valor;
      const id = alvos[valor];
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`${ctx}: '${valor}' não tem ItemID válido em "targets"`);
      }
      return id;
    };

    const textoDe = (tr, id) => {
      const t = tr && tr.quests && tr.quests[id];
      if (!t || typeof t !== "object") return null;
      const title = typeof t.title === "string" ? t.title.trim() : "";
      const description = typeof t.description === "string" ? t.description.trim() : "";
      return title ? { title, description } : null;
    };

    const faltando = {};
    const longas = [];

    for (const q of raw.quests || []) {
      const ctx = `missão '${q && q.id}'`;
      try {
        if (!q || typeof q.id !== "string" || !/^[A-Za-z0-9_]{1,48}$/.test(q.id))
          throw new Error(`${ctx}: id inválido (letras, números e _; até 48)`);
        if (def.porId.has(q.id)) throw new Error(`${ctx}: id duplicado`);
        if (!CATEGORIAS.includes(q.category))
          throw new Error(`${ctx}: category deve ser ${CATEGORIAS.join("|")}`);

        const actionId = acoes[q.action];
        if (!Number.isInteger(actionId) || actionId <= 0 || actionId > 65535)
          throw new Error(`${ctx}: action '${q.action}' não existe em "actions"`);

        if (!Number.isInteger(q.amount) || q.amount <= 0)
          throw new Error(`${ctx}: amount deve ser inteiro > 0`);
        if (typeof q.title !== "string" || q.title.trim() === "")
          throw new Error(`${ctx}: title obrigatório`);

        const lista = q.rewards || [];
        if (!Array.isArray(lista)) throw new Error(`${ctx}: rewards deve ser uma lista`);
        if (lista.length > MAX_RECOMPENSAS)
          throw new Error(`${ctx}: ${lista.length} recompensas (máximo ${MAX_RECOMPENSAS})`);

        const rewards = [];
        for (const r of lista) {
          if (!r || !Number.isInteger(r.amount) || r.amount <= 0)
            throw new Error(`${ctx}: recompensa com amount inválido`);

          if (r.item !== undefined) {
            rewards.push({ kind: "item", itemId: resolverItem(r.item, ctx, false), amount: r.amount });
          } else if (KINDS_MOEDA.includes(r.currency)) {
            if (r.currency === "dc" && !this.permitirDC)
              throw new Error(`${ctx}: recompensa em DC (moeda paga) não é permitida`);
            rewards.push({ kind: r.currency, itemId: 0, amount: r.amount });
          } else {
            throw new Error(
              `${ctx}: recompensa precisa de "item" ou "currency" (${KINDS_MOEDA.join("|")})`,
            );
          }
        }

        // Textos por idioma. O português vem do próprio quests.json.
        const base = {
          title: q.title.trim(),
          description: typeof q.description === "string" ? q.description.trim() : "",
        };
        const textos = { [IDIOMA_BASE]: base };
        for (const lang of IDIOMAS) {
          if (lang === IDIOMA_BASE) continue;
          const t = textoDe(traducoes && traducoes[lang], q.id);
          if (t) textos[lang] = t;
          else (faltando[lang] ||= []).push(q.id);
        }
        for (const [lang, t] of Object.entries(textos)) {
          if (t.description.length > MAX_DESCRICAO) longas.push(`${q.id} [${lang}] (${t.description.length})`);
        }

        const quest = Object.freeze({
          id: q.id,
          category: q.category,
          title: base.title,
          description: base.description,
          textos: Object.freeze(textos),
          actionId,
          targetId: resolverItem(q.target, ctx, true),
          amount: q.amount,
          rewards: Object.freeze(rewards),
        });

        def.porId.set(quest.id, quest);
        def.porCategoria[quest.category].push(quest);
      } catch (e) {
        erros.push(e.message);
      }
    }

    for (const [lang, ids] of Object.entries(faltando)) {
      avisos.push(
        `quests.${lang}.json: ${ids.length} missão(ões) sem tradução (usam o português): ` +
          ids.slice(0, 8).join(", ") + (ids.length > 8 ? "…" : ""),
      );
    }
    if (longas.length) {
      avisos.push(
        `Descrição acima de ${MAX_DESCRICAO} caracteres: ` + longas.slice(0, 8).join(", ") + (longas.length > 8 ? "…" : ""),
      );
    }
    for (const [lang, tr] of Object.entries(traducoes || {})) {
      if (!tr) {
        avisos.push(`quests.${lang}.json não existe: jogadores em ${lang} recebem o português.`);
        continue;
      }
      const orfas = Object.keys(tr.quests || {}).filter((id) => !def.porId.has(id));
      if (orfas.length) {
        avisos.push(`quests.${lang}.json tem ${orfas.length} tradução(ões) sem missão: ${orfas.slice(0, 8).join(", ")}${orfas.length > 8 ? "…" : ""}`);
      }
    }

    // Iniciais e diárias nunca aparecem juntas, então conta a maior das duas.
    const ativas = (c) =>
      c === "initial"
        ? def.porCategoria[c].length
        : Math.min(def.porCategoria[c].length, def.rotacao[c] || Infinity);
    const pior = Math.max(ativas("initial"), ativas("daily")) + ativas("weekly") + ativas("monthly");
    if (pior > MAX_MISSOES_POR_JOGADOR) {
      avisos.push(
        `Até ${pior} missões ativas por jogador; o limite é ${MAX_MISSOES_POR_JOGADOR}. O excedente não será enviado.`,
      );
    }

    return { def, erros, avisos };
  }

  reload() {
    let lido;
    try {
      lido = this._lerArquivos();
    } catch (e) {
      // JSON quebrado no meio de uma edição: mantém o que estava rodando.
      this.logger.error(`[Quests] Falha ao ler as definições: ${e.message}. Definições anteriores mantidas.`);
      this.ultimaCarga = { erros: [`Falha ao ler: ${e.message}`], avisos: [], em: nowSeconds() };
      return -1;
    }

    if (!lido) {
      this.logger.warn(`[Quests] ${this.arquivo} não encontrado. Nenhuma missão ativa.`);
      this.def = QuestStore._defVazia();
      this._cacheRotacao.clear();
      this.ultimaCarga = { erros: ["quests.json não encontrado"], avisos: [], em: nowSeconds() };
      return 0;
    }

    const { def, erros, avisos } = this._compilar(lido.raw, lido.traducoes);
    for (const e of erros) this.logger.error(`[Quests] ${e} — missão ignorada.`);
    for (const a of avisos) this.logger.warn(`[Quests] ${a}`);

    this.def = def;
    this.ultimaCarga = { erros, avisos, em: nowSeconds() };
    // O cache guarda objetos da definição antiga; a rotação gravada no banco
    // é relida e filtrada pelo pool novo na próxima consulta.
    this._cacheRotacao.clear();

    const c = def.porCategoria;
    this.logger.info(
      `[Quests] ${def.porId.size} missões carregadas ` +
        `(iniciais ${c.initial.length}, diárias ${c.daily.length}, ` +
        `semanais ${c.weekly.length}, mensais ${c.monthly.length}).`,
    );
    return def.porId.size;
  }

  /**
   * Painel: valida tudo e só grava se não houver NENHUM erro (no painel, uma
   * missão inválida bloqueia o salvamento em vez de ser ignorada).
   */
  salvarDefinicoes(raw, traducoes) {
    const tr = {};
    for (const lang of Object.keys(this.arquivosTraducao)) {
      const t = traducoes && traducoes[lang];
      tr[lang] = t && typeof t === "object" ? { ...t, language: lang } : { language: lang, categories: {}, quests: {} };
    }

    const { erros, avisos } = this._compilar(raw, tr);
    if (erros.length) return { ok: false, erros, avisos };

    gravarJsonAtomico(this.arquivo, raw);
    for (const [lang, arq] of Object.entries(this.arquivosTraducao)) gravarJsonAtomico(arq, tr[lang]);

    const count = this.reload();
    return { ok: true, count, avisos };
  }

  _observarArquivos() {
    let timer = null;
    const aoMudar = (atual, anterior) => {
      if (atual.mtimeMs === anterior.mtimeMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.logger.info("[Quests] Arquivos de missões alterados — recarregando.");
        this.reload();
      }, 1000);
    };
    for (const arq of [this.arquivo, ...Object.values(this.arquivosTraducao)]) {
      const w = fs.watchFile(arq, { interval: 5000 }, aoMudar);
      if (w && typeof w.unref === "function") w.unref();
    }
  }

  // ===== PERÍODOS =====

  _local(seg) {
    const d = new Date((seg + this.offsetSeg) * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() || 7 };
  }

  periodo(cat, seg = nowSeconds()) {
    if (cat === "initial") return "initial";

    const l = this._local(seg);
    if (cat === "daily") return `${l.y}-${pad2(l.m)}-${pad2(l.d)}`;
    if (cat === "monthly") return `${l.y}-${pad2(l.m)}`;

    // Semana ISO (segunda a domingo). A quinta-feira define o ano da semana.
    const quinta = new Date(Date.UTC(l.y, l.m - 1, l.d + 4 - l.dow));
    const inicioAno = Date.UTC(quinta.getUTCFullYear(), 0, 1);
    const semana = Math.ceil(((quinta.getTime() - inicioAno) / 86400000 + 1) / 7);
    return `${quinta.getUTCFullYear()}-W${pad2(semana)}`;
  }

  /** Unix (s) em que o período atual da categoria começou. 0 para "initial". */
  inicioEm(cat, seg = nowSeconds()) {
    if (cat === "initial") return 0;

    const l = this._local(seg);
    let inicioLocalMs;
    if (cat === "daily") inicioLocalMs = Date.UTC(l.y, l.m - 1, l.d);
    else if (cat === "weekly") inicioLocalMs = Date.UTC(l.y, l.m - 1, l.d - (l.dow - 1)); // segunda
    else inicioLocalMs = Date.UTC(l.y, l.m - 1, 1); // dia 1

    return inicioLocalMs / 1000 - this.offsetSeg;
  }

  /** Unix (s) em que o período atual da categoria termina. 0 = nunca. */
  expiraEm(cat, seg = nowSeconds()) {
    if (cat === "initial") return 0;

    const l = this._local(seg);
    let fimLocalMs;
    if (cat === "daily") fimLocalMs = Date.UTC(l.y, l.m - 1, l.d + 1);
    else if (cat === "weekly") fimLocalMs = Date.UTC(l.y, l.m - 1, l.d + (8 - l.dow)); // próxima segunda
    else fimLocalMs = Date.UTC(l.y, l.m, 1); // dia 1 do próximo mês

    return fimLocalMs / 1000 - this.offsetSeg;
  }

  /** Período imediatamente anterior ao atual da categoria. */
  periodoAnterior(cat, seg = nowSeconds()) {
    if (cat === "initial") return "initial";
    return this.periodo(cat, this.inicioEm(cat, seg) - 1);
  }

  /** Período imediatamente seguinte ao atual da categoria. */
  periodoSeguinte(cat, seg = nowSeconds()) {
    if (cat === "initial") return "initial";
    return this.periodo(cat, this.expiraEm(cat, seg));
  }

  /**
   * Em que janela o período informado está:
   *   "atual"    → progresso e resgate liberados;
   *   "anterior" → dentro da tolerância de progresso: progresso e resgate liberados;
   *   "resgate"  → período anterior, só resgate de missão já concluída;
   *   null       → rejeitado.
   */
  _janela(cat, period, seg) {
    if (cat === "initial") return period === "initial" ? "atual" : null;
    if (period === this.periodo(cat, seg)) return "atual";
    if (period !== this.periodoAnterior(cat, seg)) return null;

    const desdeVirada = seg - this.inicioEm(cat, seg);
    if (desdeVirada <= this.toleranciaSeg) return "anterior";
    if (desdeVirada <= this.toleranciaClaimSeg) return "resgate";
    return null;
  }

  // ===== ROTAÇÃO =====

  /**
   * Missões ativas da categoria no período. Igual para todos os jogadores.
   *
   * Na primeira consulta do período o sorteio é feito e gravado em
   * quest_rotation; dali em diante vale o que está gravado, mesmo que o
   * quests.json mude. O sorteio ordena o pool por hash(categoria|período|id),
   * então não depende da posição das missões no arquivo.
   */
  ativas(cat, period) {
    const pool = this.def.porCategoria[cat];
    const n = this.def.rotacao[cat];
    if (cat === "initial" || !n) return pool;

    const chave = `${cat}|${period}`;
    let sel = this._cacheRotacao.get(chave);
    if (sel) return sel;

    let salvo = this._stmtLerRotacao.get(cat, period);
    if (!salvo) {
      if (pool.length === 0) return pool; // nada para sortear; não grava rotação vazia

      const peso = (q) =>
        crypto.createHash("sha256").update(`${chave}|${q.id}`).digest().readUInt32LE(0);
      const sorteados = pool
        .map((q) => ({ id: q.id, p: peso(q) }))
        .sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : 1))
        .slice(0, n)
        .map((x) => x.id);

      this._stmtGravarRotacao.run(cat, period, JSON.stringify(sorteados), nowSeconds());
      salvo = this._stmtLerRotacao.get(cat, period); // relê: vale o primeiro gravado
    }

    let ids;
    try {
      ids = new Set(JSON.parse(salvo.questIds));
    } catch (e) {
      this.logger.error(`[Quests] Rotação corrompida em ${chave}: ${e.message}`);
      ids = new Set();
    }

    // Mantém a ordem do arquivo. Missão removida do quests.json some daqui.
    sel = pool.filter((q) => ids.has(q.id));

    if (this._cacheRotacao.size > 64) this._cacheRotacao.clear();
    this._cacheRotacao.set(chave, sel);
    return sel;
  }

  // ===== SNAPSHOT =====

  /** Texto da missão no idioma pedido, com o português como reserva. */
  _texto(q, lang) {
    return q.textos[lang] || q.textos[IDIOMA_BASE];
  }

  /**
   * Grava o idioma preferido da conta. Retorna o código gravado, ou null se o
   * valor não é um idioma suportado (nesse caso nada muda).
   */
  definirIdioma(playerId, idioma) {
    const lang = normalizarIdioma(idioma);
    if (!lang || !Number.isInteger(playerId) || playerId <= 0) return null;
    this._stmtDefinirIdioma.run(lang, playerId, lang);
    return lang;
  }

  /** Idioma gravado na conta, ou o padrão do master. */
  idiomaDaConta(playerId) {
    const conta = this._stmtConta.get(playerId);
    return (conta && normalizarIdioma(conta.language)) || this.idiomaPadrao;
  }

  /**
   * Definições ativas + progresso do jogador. null se a conta não existe.
   * Idioma: o pedido explicitamente > o gravado na conta > o padrão do master.
   */
  snapshot(playerId, seg = nowSeconds(), idioma) {
    const conta = this._stmtConta.get(playerId);
    if (!conta) return null;

    const lang = normalizarIdioma(idioma) || normalizarIdioma(conta.language) || this.idiomaPadrao;

    const periodos = {
      initial: "initial",
      daily: this.periodo("daily", seg),
      weekly: this.periodo("weekly", seg),
      monthly: this.periodo("monthly", seg),
    };

    const linhas = this._stmtLerJogador.all(
      playerId, periodos.initial, periodos.daily, periodos.weekly, periodos.monthly,
    );
    const porChave = new Map();
    for (const r of linhas) porChave.set(`${r.questId}|${r.period}`, r);

    const iniciais = this.ativas("initial", "initial");
    const mostrarIniciais =
      iniciais.length > 0 &&
      !(this.def.initialDesde > 0 && conta.createdAt < this.def.initialDesde) &&
      // Somem só quando TODAS foram RECOMPENSADAS: uma concluída sem
      // recompensa ainda precisa voltar ao servidor para ser resgatada.
      !iniciais.every((q) => {
        const r = porChave.get(`${q.id}|initial`);
        return r && r.rewardedAt != null;
      });

    const categories = [];
    const progress = [];
    let total = 0;

    for (const cat of CATEGORIAS) {
      if (cat === "initial" && !mostrarIniciais) continue;

      // Iniciais e diárias dividem o mesmo botão: com iniciais, nada de diárias
      // (nem progresso escondido nelas).
      if (cat === "daily" && mostrarIniciais) continue;

      let quests = this.ativas(cat, periodos[cat]);
      if (quests.length === 0) continue;

      if (total + quests.length > MAX_MISSOES_POR_JOGADOR) {
        quests = quests.slice(0, MAX_MISSOES_POR_JOGADOR - total);
        if (quests.length === 0) break;
      }
      total += quests.length;

      categories.push({
        category: cat,
        label: this.def.rotulos[lang][cat],
        period: periodos[cat],
        expiresAt: this.expiraEm(cat, seg),
        sequential: cat === "initial" && this.def.initialSequential,
        quests: quests.map((q) => {
          const t = this._texto(q, lang);
          return {
            id: q.id,
            title: t.title,
            description: t.description,
            actionId: q.actionId,
            targetId: q.targetId,
            amount: q.amount,
            rewards: q.rewards,
          };
        }),
      });

      for (const q of quests) {
        const r = porChave.get(`${q.id}|${periodos[cat]}`);
        if (r) {
          progress.push({
            id: q.id,
            current: Math.min(r.progresso, q.amount),
            rewarded: r.rewardedAt != null,
          });
        }
      }
    }

    return {
      version: 1,
      language: lang,
      categories,
      progress,
      pendingClaims: this._pendentes(playerId, seg, lang),
    };
  }

  /**
   * Missões do período ANTERIOR concluídas e ainda não resgatadas, dentro da
   * janela de resgate. O servidor de partida pede o resgate delas com
   * { questId, period, current: amount, claim: true }.
   */
  _pendentes(playerId, seg, lang = this.idiomaPadrao) {
    const anteriores = {};
    for (const cat of ROTATIVAS) {
      const p = this.periodoAnterior(cat, seg);
      anteriores[cat] = this._janela(cat, p, seg) ? p : null;
    }
    if (!anteriores.daily && !anteriores.weekly && !anteriores.monthly) return [];

    // "-" nunca casa com um período real; preenche as categorias fora da janela.
    const linhas = this._stmtLerPendentes.all(
      playerId, anteriores.daily || "-", anteriores.weekly || "-", anteriores.monthly || "-",
    );

    const pendentes = [];
    for (const r of linhas) {
      const q = this.def.porId.get(r.questId);
      if (!q || q.category === "initial" || anteriores[q.category] !== r.period) continue;
      if (r.progresso < q.amount) continue;
      if (!this.ativas(q.category, r.period).includes(q)) continue;

      pendentes.push({
        id: q.id,
        category: q.category,
        period: r.period,
        title: this._texto(q, lang).title,
        amount: q.amount,
        rewards: q.rewards,
        expiresAt: this.inicioEm(q.category, seg) + this.toleranciaClaimSeg,
      });
    }
    return pendentes;
  }

  // ===== RELATÓRIO DO SERVIDOR DE PARTIDA =====

  /**
   * entries: [{ accountId, questId, period, current, claim }]
   * current é ABSOLUTO. claim=true pede o resgate (o servidor só pede com o
   * jogador online e vivo, para poder entregar os itens).
   * Período anterior fora da tolerância de progresso: só o resgate é aceito,
   * e só se a missão já estava concluída no banco.
   * Tudo numa transação: rápido no SQLite e sem resgate pela metade.
   */
  aplicarRelatorio(entries, seg = nowSeconds()) {
    let applied = 0;
    let rejected = 0;
    const rewards = [];

    const tx = this.db.transaction(() => {
      for (const e of entries) {
        if (
          !e ||
          !Number.isInteger(e.accountId) || e.accountId <= 0 ||
          typeof e.questId !== "string" ||
          typeof e.period !== "string" ||
          !Number.isInteger(e.current) || e.current < 0
        ) {
          rejected++;
          continue;
        }

        const q = this.def.porId.get(e.questId);
        const janela = q ? this._janela(q.category, e.period, seg) : null;
        if (!q || !janela || !this.ativas(q.category, e.period).includes(q)) {
          rejected++;
          continue;
        }

        if (janela === "resgate") {
          // Sem progresso novo: o período já fechou.
          if (e.claim !== true) {
            rejected++;
            continue;
          }
          const c = this._stmtClaim.run(seg, e.accountId, q.id, e.period, q.amount);
          if (c.changes === 1) {
            applied++;
            rewards.push(this._concederRecompensas(e.accountId, q, e.period));
          } else {
            rejected++; // não concluída, já resgatada ou conta inexistente
          }
          continue;
        }

        const valor = Math.min(e.current, q.amount);
        const r = this._stmtUpsert.run(
          e.accountId, q.id, e.period, valor, valor >= q.amount ? seg : null, seg, e.accountId,
        );
        if (r.changes === 0) {
          rejected++; // conta inexistente
          continue;
        }
        applied++;

        if (e.claim === true) {
          const c = this._stmtClaim.run(seg, e.accountId, q.id, e.period, q.amount);
          if (c.changes === 1) rewards.push(this._concederRecompensas(e.accountId, q, e.period));
        }
      }
    });

    tx();
    return { applied, rejected, rewards };
  }

  /**
   * Moedas e XP são creditados aqui. Itens voltam para o servidor entregar.
   * 'credited' e o level up voltam só para o servidor AVISAR o jogador (toast).
   */
  _concederRecompensas(playerId, q, period) {
    const items = [];
    const credited = [];
    let level = 0;
    let levelsGained = 0;

    for (const r of q.rewards) {
      if (r.kind === "item") {
        items.push({ kind: "item", itemId: r.itemId, amount: r.amount });
      } else if (r.kind === "dc") {
        this._stmtCreditarDC.run(r.amount, playerId);
        credited.push({ kind: "dc", itemId: 0, amount: r.amount });
      } else if (r.kind === "ds") {
        this._stmtCreditarDS.run(r.amount, playerId);
        credited.push({ kind: "ds", itemId: 0, amount: r.amount });
      } else if (r.kind === "xp") {
        // addXP lança objetos; sem o catch, o throw desfaria o lote inteiro.
        try {
          const res = this.authStore.addXP(playerId, r.amount);
          credited.push({ kind: "xp", itemId: 0, amount: r.amount });
          level = res.level;                 // a última chamada tem o nível final
          levelsGained += res.levelsGained;  // várias recompensas de XP somam
        } catch (err) {
          this.logger.error(`[Quests] XP de '${q.id}' para ${playerId} falhou: ${err.message || err}`);
        }
      }
    }

    // level/levelsGained sempre inteiros (nunca null): o JsonUtility não lida bem com null em int.
    return { accountId: playerId, questId: q.id, period, items, credited, level, levelsGained };
  }

  // ===== ADMINISTRAÇÃO (painel) =====

  /** Arquivos crus + estado atual, para o editor do painel. */
  estadoAdmin(seg = nowSeconds()) {
    let raw = null;
    const traducoes = {};
    let erroLeitura = null;
    try {
      const lido = this._lerArquivos();
      if (lido) {
        raw = lido.raw;
        Object.assign(traducoes, lido.traducoes);
      }
    } catch (e) {
      erroLeitura = e.message;
    }

    const categorias = {};
    for (const cat of CATEGORIAS) {
      const pool = this.def.porCategoria[cat];
      const period = this.periodo(cat, seg);
      categorias[cat] = {
        period,
        inicio: this.inicioEm(cat, seg),
        expiresAt: this.expiraEm(cat, seg),
        proximo: this.periodoSeguinte(cat, seg),
        rotacao: this.def.rotacao[cat] || 0,
        pool: pool.length,
        ativas: this.ativas(cat, period).map((q) => q.id),
        manual: cat !== "initial" && this._rotacaoManual(cat, period),
      };
    }

    return {
      raw,
      traducoes,
      erroLeitura,
      carga: this.ultimaCarga,
      categorias,
      idiomas: IDIOMAS,
      idiomaBase: IDIOMA_BASE,
      limites: { recompensas: MAX_RECOMPENSAS, descricao: MAX_DESCRICAO, missoesPorJogador: MAX_MISSOES_POR_JOGADOR },
      permitirDC: this.permitirDC,
      janelas: { progressoSeg: this.toleranciaSeg, resgateSeg: this.toleranciaClaimSeg },
      offsetMin: this.offsetSeg / 60,
    };
  }

  /** true se a rotação gravada difere do sorteio automático (escolhida no painel). */
  _rotacaoManual(cat, period) {
    const salvo = this._stmtLerRotacao.get(cat, period);
    if (!salvo) return false;
    const n = this.def.rotacao[cat];
    const chave = `${cat}|${period}`;
    const peso = (q) => crypto.createHash("sha256").update(`${chave}|${q.id}`).digest().readUInt32LE(0);
    const auto = this.def.porCategoria[cat]
      .map((q) => ({ id: q.id, p: peso(q) }))
      .sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : 1))
      .slice(0, n)
      .map((x) => x.id)
      .sort();
    let gravado;
    try { gravado = JSON.parse(salvo.questIds).slice().sort(); } catch { return true; }
    return JSON.stringify(auto) !== JSON.stringify(gravado);
  }

  /** Painel: fixa à mão as missões de um período. */
  definirRotacao(cat, period, ids) {
    if (!ROTATIVAS.includes(cat)) throw new Error("categoria sem rotação");
    if (typeof period !== "string" || !period) throw new Error("período obrigatório");
    if (!Array.isArray(ids) || ids.length === 0) throw new Error("escolha ao menos uma missão");
    const pool = new Set(this.def.porCategoria[cat].map((q) => q.id));
    const invalidas = ids.filter((id) => !pool.has(id));
    if (invalidas.length) throw new Error(`fora do pool de ${cat}: ${invalidas.join(", ")}`);

    this.db
      .prepare(`INSERT OR REPLACE INTO quest_rotation (category, period, questIds, createdAt) VALUES (?, ?, ?, ?)`)
      .run(cat, period, JSON.stringify([...new Set(ids)]), nowSeconds());
    this._cacheRotacao.clear();
    return this.ativas(cat, period).map((q) => q.id);
  }

  /** Painel: descarta a rotação gravada; a próxima consulta sorteia de novo. */
  resortearRotacao(cat, period) {
    if (!ROTATIVAS.includes(cat)) throw new Error("categoria sem rotação");
    this.db.prepare(`DELETE FROM quest_rotation WHERE category = ? AND period = ?`).run(cat, period);
    this._cacheRotacao.clear();
    return this.ativas(cat, period).map((q) => q.id);
  }

  /** Painel: quantos jogadores começaram, concluíram e resgataram cada missão do período. */
  estatisticas(cat, period) {
    if (!CATEGORIAS.includes(cat)) throw new Error("categoria inválida");
    const per = cat === "initial" ? "initial" : period || this.periodo(cat);

    const linhas = this.db.prepare(`
      SELECT questId,
             COUNT(*)                                            AS jogadores,
             SUM(CASE WHEN completedAt IS NOT NULL THEN 1 ELSE 0 END) AS concluiram,
             SUM(CASE WHEN rewardedAt  IS NOT NULL THEN 1 ELSE 0 END) AS resgataram,
             AVG(progresso)                                      AS mediaProgresso,
             MAX(updatedAt)                                      AS ultimo
      FROM quest_progress WHERE period = ? GROUP BY questId
    `).all(per);
    const porId = new Map(linhas.map((l) => [l.questId, l]));

    const unicos = this.db
      .prepare(`SELECT COUNT(DISTINCT playerId) AS n FROM quest_progress WHERE period = ?`)
      .get(per).n;

    const ativas = new Set(this.ativas(cat, per).map((q) => q.id));
    const quests = this.def.porCategoria[cat]
      .filter((q) => cat === "initial" || ativas.has(q.id) || porId.has(q.id))
      .map((q) => {
        const l = porId.get(q.id) || {};
        return {
          id: q.id,
          title: q.title,
          amount: q.amount,
          ativa: cat === "initial" || ativas.has(q.id),
          jogadores: l.jogadores || 0,
          concluiram: l.concluiram || 0,
          resgataram: l.resgataram || 0,
          mediaProgresso: l.mediaProgresso || 0,
          ultimo: l.ultimo || null,
        };
      });

    return { category: cat, period: per, jogadoresUnicos: unicos, quests };
  }

  /** Painel: linhas de progresso de um jogador (mais recentes primeiro). */
  progressoJogador(playerId, limite = 300) {
    return this.db.prepare(`
      SELECT questId, period, progresso, completedAt, rewardedAt, updatedAt
      FROM quest_progress WHERE playerId = ? ORDER BY updatedAt DESC LIMIT ?
    `).all(playerId, limite).map((r) => {
      const q = this.def.porId.get(r.questId);
      return { ...r, title: q ? q.title : null, category: q ? q.category : null, amount: q ? q.amount : null };
    });
  }

  /**
   * Painel: define o progresso à mão (pode diminuir). Não concede recompensa:
   * itens só o servidor de partida entrega. Uma missão concluída aqui é
   * resgatada no próximo relatório com claim do jogador.
   */
  definirProgresso(playerId, questId, period, valor) {
    const q = this.def.porId.get(questId);
    if (!q) throw new Error(`missão '${questId}' não existe`);
    if (!this._stmtConta.get(playerId)) throw new Error("conta não encontrada");
    const per = q.category === "initial" ? "initial" : period || this.periodo(q.category);
    const v = Math.max(0, Math.min(q.amount, Math.floor(Number(valor) || 0)));
    const agora = nowSeconds();

    this.db.prepare(`
      INSERT INTO quest_progress (playerId, questId, period, progresso, completedAt, rewardedAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(playerId, questId, period) DO UPDATE SET
        progresso   = excluded.progresso,
        completedAt = CASE WHEN excluded.progresso >= ? THEN COALESCE(completedAt, excluded.updatedAt) ELSE NULL END,
        updatedAt   = excluded.updatedAt
    `).run(playerId, q.id, per, v, v >= q.amount ? agora : null, agora, q.amount);

    return { questId: q.id, period: per, progresso: v, amount: q.amount };
  }

  /**
   * Painel: apaga progresso. { questId, period } apaga uma linha;
   * { category: "initial" } refaz o tutorial inteiro do jogador.
   * Uma missão já resgatada que for apagada pode ser concluída e resgatada de novo.
   */
  resetarProgresso(playerId, { questId, period, category } = {}) {
    if (category === "initial") {
      return this.db.prepare(`DELETE FROM quest_progress WHERE playerId = ? AND period = 'initial'`).run(playerId).changes;
    }
    if (typeof questId !== "string" || typeof period !== "string") throw new Error("questId e period obrigatórios");
    return this.db
      .prepare(`DELETE FROM quest_progress WHERE playerId = ? AND questId = ? AND period = ?`)
      .run(playerId, questId, period).changes;
  }

  /** Apaga progresso e rotações de períodos antigos. "initial" nunca é apagado. */
  cleanup() {
    const corte = nowSeconds() - RETENCAO_PROGRESSO_SEG;
    const r = this.db
      .prepare(`DELETE FROM quest_progress WHERE period != 'initial' AND updatedAt < ?`)
      .run(corte);
    const rot = this.db.prepare(`DELETE FROM quest_rotation WHERE createdAt < ?`).run(corte);
    if (rot.changes > 0) this._cacheRotacao.clear();

    return r.changes + rot.changes;
  }
}

// ===== ROTAS DO JOGO =====

// Rotas de login cuja resposta de sucesso ganha o snapshot de missões.
// "/auth/google" não existe no app.js atual; fica aqui para quando o login Google entrar.
const ROTAS_LOGIN = ["/auth/email", "/auth/guest", "/auth/login/guest", "/auth/google", "/auth/validate-session"];

/**
 * IMPORTANTE: chame ANTES de registrar as rotas /auth/* no app.js (a ordem do
 * app.use importa) e DEPOIS do express.json().
 */
function registrarRotasMissoes(app, { logger, questStore, store, serverAuth, jwtAuth, rateLimiter }) {
  const servidorPontua = (serverId) => {
    if (!questStore.somenteOficiais) return true;
    const s = store.getServer(serverId);
    return !!s && s.serverType === "official";
  };

  /**
   * Missões já no login. Não mexe nas rotas de auth: intercepta o res.json
   * delas e, quando a resposta é um sucesso com playerId, grava o "language"
   * enviado no body e acrescenta "quests" (o snapshot no idioma da conta).
   * Qualquer falha aqui é só registrada: o login nunca quebra por causa disso.
   */
  app.use(ROTAS_LOGIN, (req, res, next) => {
    if (req.method !== "POST") return next();

    const idioma = req.body ? req.body.language : undefined;
    const jsonOriginal = res.json.bind(res);

    res.json = (body) => {
      try {
        const sucesso =
          res.statusCode < 400 &&
          body && body.ok === true && body.valid !== false &&
          Number.isInteger(body.playerId) && body.playerId > 0;

        if (sucesso) {
          if (idioma !== undefined) questStore.definirIdioma(body.playerId, idioma);
          const quests = questStore.snapshot(body.playerId);
          if (quests) body = { ...body, quests };
        }
      } catch (error) {
        logger.error("[Quests] snapshot no login falhou:", error);
      }
      return jsonOriginal(body);
    };

    next();
  });

  // Cliente: o jogador trocou o idioma nas opções. Grava e devolve o snapshot traduzido.
  // Depois disso, avise o servidor de partida (QuestIdiomaMudouMsg) se estiver numa partida.
  app.post("/auth/language", rateLimiter.middleware(), jwtAuth, (req, res) => {
    const lang = questStore.definirIdioma(req.playerId, (req.body || {}).language);
    if (!lang) {
      return res.status(400).json({ ok: false, error: "language deve ser pt, en ou es (ou 0, 1, 2)" });
    }
    try {
      res.json({ ok: true, language: lang, quests: questStore.snapshot(req.playerId) });
    } catch (error) {
      logger.error("[Quests] /auth/language error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // Servidor de partida: no join, a cada expiresAt e quando o jogador troca de idioma.
  // Sem "lang", usa o idioma gravado na conta.
  app.post("/quests/load", serverAuth, (req, res) => {
    const { serverId, accountId, lang } = req.body || {};

    if (typeof serverId !== "string" || !Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ ok: false, error: "serverId (string) e accountId (inteiro > 0) obrigatórios" });
    }

    // enabled:false (com 200) diz ao servidor para não tentar de novo.
    if (!servidorPontua(serverId)) {
      return res.json({ ok: true, enabled: false, reason: "server_not_official" });
    }

    try {
      const snapshot = questStore.snapshot(accountId, undefined, lang);
      if (!snapshot) return res.json({ ok: true, enabled: false, reason: "account_not_found" });
      res.json({ ok: true, enabled: true, snapshot });
    } catch (error) {
      logger.error("[Quests] load error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // Servidor de partida, em lote.
  app.post("/quests/report", serverAuth, (req, res) => {
    const { serverId, entries } = req.body || {};

    if (typeof serverId !== "string") {
      return res.status(400).json({ ok: false, error: "serverId obrigatório" });
    }
    if (!Array.isArray(entries) || entries.length > MAX_ENTRADAS_POR_RELATORIO) {
      return res.status(400).json({
        ok: false,
        error: `entries deve ser um array (máx. ${MAX_ENTRADAS_POR_RELATORIO})`,
      });
    }
    if (!servidorPontua(serverId)) {
      return res.status(403).json({ ok: false, error: "Servidor não pontua missões" });
    }

    try {
      const r = questStore.aplicarRelatorio(entries);
      if (r.rejected > 0) logger.debug(`[Quests] ${serverId}: ${r.rejected} entradas rejeitadas`);
      res.json({ ok: true, ...r });
    } catch (error) {
      logger.error("[Quests] report error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // Cliente, para exibir no menu (somente leitura). Idioma da conta; ?lang= força outro.
  app.get("/quests/me", rateLimiter.middleware(), jwtAuth, (req, res) => {
    try {
      const snapshot = questStore.snapshot(req.playerId, undefined, req.query.lang);
      if (!snapshot) return res.status(404).json({ ok: false, error: "Conta não encontrada" });
      res.json({ ok: true, snapshot });
    } catch (error) {
      logger.error("[Quests] me error:", error);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });
}

// ===== ROTAS DO PAINEL =====

/**
 * Rotas usadas pela aba "Missões" do painel. Todas exigem adminAuth.
 * Chamada de dentro do registrarRotasAdmin (admin-routes.js), que é onde
 * adminAuth e audit existem. audit(req, action, target, details) recebe
 * details como objeto (o próprio audit serializa).
 */
function registrarRotasAdminMissoes(app, { logger, questStore, adminAuth, audit, prefix = "/admin/api" }) {
  if (typeof adminAuth !== "function") {
    throw new Error("registrarRotasAdminMissoes: adminAuth é obrigatório (as rotas alteram missões e progresso)");
  }
  const P = `${prefix}/quests`;
  const auditar = (req, target, details) => {
    try {
      if (typeof audit === "function") audit(req, "quests", target, details);
    } catch (e) {
      logger.warn(`[Quests] auditoria falhou: ${e.message}`);
    }
  };
  const falha = (res, e, status = 400) => res.status(status).json({ ok: false, error: e.message || String(e) });
  const idJogador = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error("playerId inválido");
    return n;
  };

  app.get(P, adminAuth, (req, res) => {
    try {
      res.json({ ok: true, ...questStore.estadoAdmin() });
    } catch (e) {
      logger.error("[Quests] admin estado:", e);
      falha(res, e, 500);
    }
  });

  // Salva quests.json + traduções. Qualquer erro bloqueia o salvamento.
  app.put(P, adminAuth, (req, res) => {
    const { raw, traducoes } = req.body || {};
    try {
      const r = questStore.salvarDefinicoes(raw, traducoes);
      if (!r.ok) return res.status(422).json({ ok: false, error: `${r.erros.length} erro(s) de validação`, erros: r.erros, avisos: r.avisos });
      auditar(req, "definicoes", { missoes: r.count });
      res.json({ ok: true, count: r.count, avisos: r.avisos });
    } catch (e) {
      logger.error("[Quests] admin salvar:", e);
      falha(res, e, 500);
    }
  });

  app.post(`${P}/reload`, adminAuth, (req, res) => {
    const count = questStore.reload();
    auditar(req, "reload", { count });
    res.json({ ok: true, count, carga: questStore.ultimaCarga });
  });

  // Prévia do que o jogador recebe (mecânica do disco carregado, idioma escolhido).
  app.get(`${P}/preview`, adminAuth, (req, res) => {
    try {
      const snap = questStore.snapshot(idJogador(req.query.playerId), undefined, req.query.lang);
      if (!snap) return falha(res, new Error("conta não encontrada"), 404);
      res.json({ ok: true, snapshot: snap });
    } catch (e) {
      falha(res, e);
    }
  });

  app.put(`${P}/rotation`, adminAuth, (req, res) => {
    const { category, period, questIds } = req.body || {};
    try {
      const ativas = questStore.definirRotacao(category, period, questIds);
      auditar(req, `${category}|${period}`, { acao: "rotacao_manual", questIds: ativas });
      res.json({ ok: true, ativas });
    } catch (e) {
      falha(res, e);
    }
  });

  app.delete(`${P}/rotation`, adminAuth, (req, res) => {
    const { category, period } = req.body || {};
    try {
      const ativas = questStore.resortearRotacao(category, period);
      auditar(req, `${category}|${period}`, { acao: "resortear", questIds: ativas });
      res.json({ ok: true, ativas });
    } catch (e) {
      falha(res, e);
    }
  });

  app.get(`${P}/stats`, adminAuth, (req, res) => {
    try {
      res.json({ ok: true, ...questStore.estatisticas(req.query.category, req.query.period) });
    } catch (e) {
      falha(res, e);
    }
  });

  app.get(`${P}/player/:id`, adminAuth, (req, res) => {
    try {
      const id = idJogador(req.params.id);
      const snapshot = questStore.snapshot(id, undefined, req.query.lang);
      if (!snapshot) return falha(res, new Error("conta não encontrada"), 404);
      res.json({ ok: true, snapshot, linhas: questStore.progressoJogador(id) });
    } catch (e) {
      falha(res, e);
    }
  });

  app.patch(`${P}/player/:id`, adminAuth, (req, res) => {
    const { questId, period, progresso } = req.body || {};
    try {
      const id = idJogador(req.params.id);
      const r = questStore.definirProgresso(id, questId, period, progresso);
      auditar(req, String(id), { acao: "progresso", ...r });
      res.json({ ok: true, ...r });
    } catch (e) {
      falha(res, e);
    }
  });

  app.delete(`${P}/player/:id`, adminAuth, (req, res) => {
    try {
      const id = idJogador(req.params.id);
      const removidas = questStore.resetarProgresso(id, req.body || {});
      auditar(req, String(id), { acao: "resetar", ...(req.body || {}), removidas });
      res.json({ ok: true, removidas });
    } catch (e) {
      falha(res, e);
    }
  });
}

module.exports = { QuestStore, registrarRotasMissoes, registrarRotasAdminMissoes, normalizarIdioma };