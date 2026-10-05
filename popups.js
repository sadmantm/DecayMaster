"use strict";

/**
 * Sistema de pop-ups dinâmicos.
 *
 * - O cliente (Unity) chama GET /popups e recebe a lista ordenada do que deve
 *   mostrar, com uma URL de imagem e um imageHash.
 * - O imageHash é o que faz o cache funcionar: o arquivo no aparelho é salvo
 *   como "<popupId>_<imageHash>.png". Se a imagem mudar no painel, o hash muda,
 *   o cliente não encontra o arquivo, baixa o novo e apaga o antigo.
 * - As imagens podem ser hospedadas aqui mesmo (upload pelo painel, servidas em
 *   /popup-images) ou ser uma URL externa qualquer (CDN, imgur, etc).
 *
 * Os dados ficam em popups.json (mesmo espírito do skins.json / dc-packages.json).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const FREQUENCIAS = ["always", "once", "daily"];
const MIMES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IDIOMAS = ["pt", "en", "es"];

/** Aceita "pt", "pt-BR", "pt_br", "PT"... e devolve "pt". Desconhecido = "". */
function normalizarIdioma(v) {
  const s = String(v || "").trim().toLowerCase().slice(0, 2);
  return IDIOMAS.includes(s) ? s : "";
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sha1 = (v) => crypto.createHash("sha1").update(v).digest("hex");

function erro(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function slugId(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function slugSimples(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "").slice(0, 20);
}

const urlValida = (u) => /^https?:\/\/\S+$/i.test(u);

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

class PopupStore {
  constructor({ config, logger }) {
    this.logger = logger || console;
    this.file = path.resolve(process.cwd(), config.popupsStorePath || "popups.json");
    this.imagesDir = path.resolve(process.cwd(), config.popupImagesDir || "popup-images");
    this.publicBaseUrl = String(config.publicBaseUrl || "").replace(/\/+$/, "");
    this.popups = [];
    this.revision = 1;
    this.carregar();
  }

  carregar() {
    if (!fs.existsSync(this.imagesDir)) fs.mkdirSync(this.imagesDir, { recursive: true });

    if (!fs.existsSync(this.file)) {
      this.popups = [];
      this.logger.info("[Popups] popups.json ainda não existe — catálogo vazio.");
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.popups = Array.isArray(raw) ? raw : raw.popups || [];
      this.revision = Array.isArray(raw) ? 1 : raw.revision || 1;
      this.ordenar();
      this.logger.info(`[Popups] ${this.popups.length} pop-up(s) carregado(s).`);
    } catch (e) {
      this.logger.error(`[Popups] falha ao ler ${this.file}: ${e.message}`);
      this.popups = [];
    }
  }

  flush() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ revision: this.revision, popups: this.popups }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  ordenar() {
    this.popups.sort((a, b) => (a.order || 0) - (b.order || 0) || a.popupId.localeCompare(b.popupId));
  }

  list() {
    return this.popups.map((p) => ({ ...p }));
  }

  get(popupId) {
    return this.popups.find((p) => p.popupId === slugId(popupId)) || null;
  }

  /** Cria ou atualiza. Recalcula o imageHash só quando a imagem realmente mudou. */
  upsert(dados) {
    const popupId = slugId(dados.popupId);
    if (!popupId) throw erro(400, "popupId inválido (use letras, números, - e _)");

    const anterior = this.get(popupId);

    const imageUrl = String(dados.imageUrl || "").trim();
    if (!urlValida(imageUrl)) throw erro(400, "imageUrl precisa ser uma URL http(s)");

    const linkUrl = String(dados.linkUrl || "").trim();
    if (linkUrl && !urlValida(linkUrl)) throw erro(400, "linkUrl precisa ser uma URL http(s)");

    const frequency = FREQUENCIAS.includes(dados.frequency) ? dados.frequency : "always";

    const hashEnviado = String(dados.imageHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
    const mudouImagem =
      !anterior || anterior.imageUrl !== imageUrl || (hashEnviado && hashEnviado !== anterior.imageHash);
    const forcar = dados.forcarAtualizacao === true;

    const updatedAt = mudouImagem || forcar ? nowSeconds() : anterior.updatedAt || nowSeconds();

    let imageHash;
    if (!mudouImagem && !forcar && anterior?.imageHash) imageHash = anterior.imageHash;
    else if (hashEnviado) imageHash = hashEnviado;
    else imageHash = sha1(`${imageUrl}:${updatedAt}`).slice(0, 16);

    const popup = {
      popupId,
      titulo: String(dados.titulo || "").trim().slice(0, 80) || popupId,
      imageUrl,
      imageHash,
      linkUrl,
      buttonText: String(dados.buttonText || "").trim().slice(0, 30),
      frequency,
      order: Number.isFinite(+dados.order) ? Math.trunc(+dados.order) : anterior?.order ?? this.popups.length + 1,
      enabled: dados.enabled !== false,
      startAt: dados.startAt ? Math.trunc(+dados.startAt) : null,
      endAt: dados.endAt ? Math.trunc(+dados.endAt) : null,
      platforms: Array.isArray(dados.platforms) ? dados.platforms.map(slugSimples).filter(Boolean) : [],
      builds: Array.isArray(dados.builds) ? dados.builds.map((b) => String(b).trim()).filter(Boolean) : [],
      languages: Array.isArray(dados.languages)
        ? [...new Set(dados.languages.map(normalizarIdioma).filter(Boolean))]
        : anterior?.languages ?? [],
      createdAt: anterior?.createdAt || nowSeconds(),
      updatedAt,
    };

    if (popup.startAt && popup.endAt && popup.endAt <= popup.startAt) {
      throw erro(400, "endAt precisa ser depois de startAt");
    }

    // trocou de imagem: se a antiga era hospedada aqui, apaga o arquivo órfão
    if (anterior && anterior.imageUrl !== imageUrl) this.apagarImagemLocal(anterior.imageUrl);

    if (anterior) this.popups[this.popups.indexOf(anterior)] = popup;
    else this.popups.push(popup);

    this.revision++;
    this.ordenar();
    this.flush();
    return popup;
  }

  remove(popupId) {
    const p = this.get(popupId);
    if (!p) return false;
    this.popups.splice(this.popups.indexOf(p), 1);
    this.apagarImagemLocal(p.imageUrl);
    this.revision++;
    this.flush();
    return true;
  }

  /** Recebe os ids na ordem desejada e renumera 1..n. */
  reorder(ids) {
    if (!Array.isArray(ids)) throw erro(400, "ids precisa ser um array");
    let n = 1;
    for (const id of ids) {
      const p = this.get(id);
      if (p) p.order = n++;
    }
    for (const p of this.popups) if (!ids.includes(p.popupId)) p.order = n++;
    this.revision++;
    this.ordenar();
    this.flush();
    return this.list();
  }

  /** Força o cliente a rebaixar a imagem mesmo com a mesma URL. */
  touch(popupId) {
    const p = this.get(popupId);
    if (!p) throw erro(404, "pop-up não encontrado");
    p.updatedAt = nowSeconds();
    p.imageHash = sha1(`${p.imageUrl}:${p.updatedAt}`).slice(0, 16);
    this.revision++;
    this.flush();
    return p;
  }

  /** Salva bytes de imagem no disco e devolve a URL pública + hash do conteúdo. */
  salvarImagem(popupId, bytes, contentType) {
    const ext = MIMES[String(contentType || "").toLowerCase().split(";")[0].trim()];
    if (!ext) throw erro(415, "formato não suportado (use png, jpg ou webp)");
    if (!bytes?.length) throw erro(400, "corpo vazio");
    if (bytes.length > MAX_IMAGE_BYTES) throw erro(413, "imagem maior que 8 MB");

    const id = slugId(popupId) || "popup";
    const hash = sha1(bytes).slice(0, 16);
    const nome = `${id}-${hash}${ext}`;
    fs.writeFileSync(path.join(this.imagesDir, nome), bytes);

    return {
      imageUrl: `${this.publicBaseUrl}/popup-images/${nome}`,
      imageHash: hash,
      bytes: bytes.length,
    };
  }

  apagarImagemLocal(url) {
    if (!url || !this.publicBaseUrl || !url.startsWith(`${this.publicBaseUrl}/popup-images/`)) return;
    const nome = path.basename(url.split("?")[0]);
    const alvo = path.join(this.imagesDir, nome);
    // ninguém mais usa esse arquivo?
    if (this.popups.some((p) => p.imageUrl.endsWith(`/popup-images/${nome}`))) return;
    try {
      if (fs.existsSync(alvo)) fs.unlinkSync(alvo);
    } catch (e) {
      this.logger.warn(`[Popups] não consegui apagar ${nome}: ${e.message}`);
    }
  }

  /** O que este cliente deve ver agora. */
  ativosPara({ platform, build, lang } = {}) {
    const agora = nowSeconds();
    const plat = slugSimples(platform);
    const idioma = normalizarIdioma(lang);
    return this.popups.filter(
      (p) =>
        p.enabled !== false &&
        (!p.startAt || p.startAt <= agora) &&
        (!p.endAt || p.endAt > agora) &&
        (!p.platforms?.length || (plat && p.platforms.includes(plat))) &&
        (!p.builds?.length || (build && p.builds.includes(String(build)))) &&
        (!p.languages?.length || (idioma && p.languages.includes(idioma))),
    );
  }
}

const viewPublica = (p) => ({
  popupId: p.popupId,
  imageUrl: p.imageUrl,
  imageHash: p.imageHash,
  linkUrl: p.linkUrl || "",
  buttonText: p.buttonText || "",
  frequency: p.frequency || "always",
  order: p.order || 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Rotas
// ─────────────────────────────────────────────────────────────────────────────

function adminAuthDe(config, logger) {
  return (req, res, next) => {
    const chave = config.adminKey || config.serverKey;
    if (!chave || req.headers["x-admin-key"] !== chave) {
      logger.warn("[Popups] admin auth recusada");
      return res.status(401).json({ ok: false, error: "não autorizado" });
    }
    next();
  };
}

function responderErro(res, logger, e, contexto) {
  if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
  logger.error(`[Popups] ${contexto}:`, e);
  return res.status(500).json({ ok: false, error: "Internal server error" });
}

/**
 * @param app  instância do express
 * @param deps { config, logger, popupStore?, rateLimiter?, audit? }
 *   audit: (action, target, detalhes, req) => void  — opcional
 */
function registrarRotasPopups(app, { config, logger, popupStore, rateLimiter, audit }) {
  const store = popupStore || new PopupStore({ config, logger });
  const admin = adminAuthDe(config, logger);
  const limite = rateLimiter?.middleware ? rateLimiter.middleware() : (req, res, next) => next();
  const registrar = (acao, alvo, det, req) => {
    try {
      audit?.(acao, alvo, det, req);
    } catch { /* auditoria nunca derruba a rota */ }
  };

  // O nome do arquivo já carrega o hash do conteúdo, então cache agressivo é seguro.
  app.use(
    "/popup-images",
    express.static(store.imagesDir, { maxAge: "30d", immutable: true, index: false }),
  );

  // ── público (sem login: a cena de menu pode carregar antes do auth) ──
  app.get("/popups", limite, (req, res) => {
    const lang = normalizarIdioma(req.query.lang);
    const rows = store.ativosPara({ platform: req.query.platform, build: req.query.build, lang });
    res.set("Cache-Control", "no-cache");
    res.json({ ok: true, revision: store.revision, lang, popups: rows.map(viewPublica) });
  });

  // ── admin ──
  app.get("/admin/api/popups", admin, (req, res) => {
    res.json({
      ok: true,
      revision: store.revision,
      baseUrl: store.publicBaseUrl,
      popups: store.list(),
    });
  });

  app.post("/admin/api/popups", admin, (req, res) => {
    try {
      const p = store.upsert(req.body || {});
      logger.info(`[Popups] salvo: ${p.popupId} (hash ${p.imageHash})`);
      registrar("popups", p.popupId, `salvo: ${p.imageUrl}`, req);
      res.json({ ok: true, popup: p, revision: store.revision });
    } catch (e) {
      responderErro(res, logger, e, "upsert");
    }
  });

  app.delete("/admin/api/popups/:id", admin, (req, res) => {
    const removido = store.remove(req.params.id);
    if (!removido) return res.status(404).json({ ok: false, error: "pop-up não encontrado" });
    registrar("popups", req.params.id, "removido", req);
    res.json({ ok: true, revision: store.revision });
  });

  app.post("/admin/api/popups/reorder", admin, (req, res) => {
    try {
      const popups = store.reorder(req.body?.ids);
      registrar("popups", "-", `reordenado: ${(req.body?.ids || []).join(",")}`, req);
      res.json({ ok: true, popups, revision: store.revision });
    } catch (e) {
      responderErro(res, logger, e, "reorder");
    }
  });

  app.post("/admin/api/popups/:id/touch", admin, (req, res) => {
    try {
      const p = store.touch(req.params.id);
      registrar("popups", p.popupId, "forçou novo download", req);
      res.json({ ok: true, popup: p, revision: store.revision });
    } catch (e) {
      responderErro(res, logger, e, "touch");
    }
  });

  /**
   * Upload da imagem: corpo BINÁRIO cru, com Content-Type image/png|jpeg|webp.
   * Mandar como binário (e não base64 dentro de JSON) evita esbarrar no limite
   * do express.json global — ele ignora content-types que não são JSON.
   */
  app.post(
    "/admin/api/popups/:id/image",
    admin,
    express.raw({ type: Object.keys(MIMES), limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      try {
        const r = store.salvarImagem(req.params.id, req.body, req.headers["content-type"]);
        logger.info(`[Popups] imagem enviada para ${req.params.id}: ${r.bytes} bytes`);
        registrar("popups", req.params.id, `upload ${r.bytes}B`, req);
        res.json({ ok: true, ...r });
      } catch (e) {
        responderErro(res, logger, e, "upload");
      }
    },
  );

  logger.info(`[Popups] rotas registradas (imagens em ${store.imagesDir})`);
  return store;
}

module.exports = { PopupStore, registrarRotasPopups, viewPublica, FREQUENCIAS, IDIOMAS };
