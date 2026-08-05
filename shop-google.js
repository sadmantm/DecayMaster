// ============================================================================
// shop-google.js — Compra de DC Coin via Google Play Billing (Android / Play Store)
//
// Convive com shop-dc.js (Mercado Pago). A regra é simples:
//   • Build distribuída na Play Store  -> SÓ Google Play Billing
//   • Build de PC / APK fora da Play   -> Mercado Pago (shop-dc.js)
//
// Uso no master (server.js):
//
//   const { GoogleShopStore, registrarRotasGooglePlay, iniciarJobsGooglePlay,
//           bloquearMercadoPagoNaPlayStore } = require("./shop-google");
//
//   const googleShop = new GoogleShopStore(authStore.db, config, logger);
//
//   // ⚠ ANTES de registrarRotasLoja(): bloqueia o checkout MP em clientes Play
//   app.use("/shop/dc/checkout", bloquearMercadoPagoNaPlayStore(config, logger));
//
//   registrarRotasGooglePlay(app, { config, logger, googleShop, jwtAuth, rateLimiter, onCredited });
//   iniciarJobsGooglePlay({ googleShop, logger, onCredited });
//
// .env necessário:
//   PLAY_PACKAGE_NAME=com.suaempresa.dcgame
//   PLAY_SERVICE_ACCOUNT_FILE=./data/play-service-account.json
//   PLAY_ACCOUNT_SALT=<string aleatória longa e secreta>
//   PLAY_RTDN_SECRET=<string aleatória; vai na query do endpoint Pub/Sub>
//   PLAY_ALLOW_TEST_PURCHASES=true    (deixe false em produção)
// ============================================================================

require("dotenv").config();

const crypto = require("crypto");
const { GoogleAuth } = require("google-auth-library");
const { DC_PACKAGES } = require("./shop-dc");

const ANDROID_PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3";

const PLAY_PACKAGE_NAME = process.env.PLAY_PACKAGE_NAME;
const PLAY_SERVICE_ACCOUNT_FILE = process.env.PLAY_SERVICE_ACCOUNT_FILE;
const PLAY_ACCOUNT_SALT = process.env.PLAY_ACCOUNT_SALT || "";
const PLAY_RTDN_SECRET = process.env.PLAY_RTDN_SECRET || "";
const PLAY_ALLOW_TEST_PURCHASES = process.env.PLAY_ALLOW_TEST_PURCHASES === "true";

// purchaseState devolvido por purchases.products.get
const STATE_PURCHASED = 0;
const STATE_CANCELED = 1;
const STATE_PENDING = 2; // Pix/boleto dentro do próprio Play — NÃO creditar ainda

// purchaseType: 0 = teste (licence tester), 1 = promo, 2 = rewarded
const TYPE_TEST = 0;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ============================================================================
// CATÁLOGO
//
// O productId do Play Console tem que ser IGUAL ao packageId daqui.
// Regras do Play: minúsculas, números e underscore. "dc_60" já serve.
//
// O PREÇO não mora aqui: quem define preço no Android é o Play Console
// (por país, por moeda). O servidor continua sendo dono da quantidade de DC.
// ============================================================================

const PLAY_PRODUCTS = DC_PACKAGES.map((p) => ({
  productId: p.packageId,
  packageId: p.packageId,
  amountDC: p.amountDC,
  bonusDC: p.bonusDC,
  totalDC: p.amountDC + p.bonusDC,
}));

function getPlayProduct(productId) {
  return PLAY_PRODUCTS.find((p) => p.productId === productId) || null;
}

// ============================================================================
// IDENTIDADE OFUSCADA
//
// O cliente manda esse hash pro Play (SetObfuscatedAccountId). O Google devolve
// ele de volta na verificação. Se não bater com o playerId que está comprando,
// é token roubado/compartilhado — recusa.
// ============================================================================

function obfuscatedAccountId(playerId) {
  return crypto
    .createHmac("sha256", PLAY_ACCOUNT_SALT || "dev-salt")
    .update(String(playerId))
    .digest("hex"); // 64 chars — exatamente o limite do Google
}

// ============================================================================
// STORE
// ============================================================================

class GoogleShopStore {
  /**
   * @param {import('better-sqlite3').Database} db  mesma conexão do AuthStore
   */
  constructor(db, config, logger) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this._initSchema();
  }

  _initSchema() {
    // A PK é o purchaseToken: é ele que o Google garante único por compra.
    // Isso sozinho já mata replay/duplicidade.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS play_orders (
        purchaseToken TEXT PRIMARY KEY,
        playerId      INTEGER NOT NULL,
        productId     TEXT NOT NULL,
        packageId     TEXT NOT NULL,
        quantity      INTEGER NOT NULL DEFAULT 1,
        totalDC       INTEGER NOT NULL,
        gpOrderId     TEXT,
        status        TEXT NOT NULL,
        purchaseState INTEGER,
        purchaseType  INTEGER,
        acknowledged  INTEGER NOT NULL DEFAULT 0,
        regionCode    TEXT,
        failReason    TEXT,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL,
        creditedAt    INTEGER,
        voidedAt      INTEGER,
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_play_orders_player ON play_orders(playerId);
      CREATE INDEX IF NOT EXISTS idx_play_orders_status ON play_orders(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_play_orders_gporder
        ON play_orders(gpOrderId) WHERE gpOrderId IS NOT NULL;
    `);
  }

  get(purchaseToken) {
    return this.db
      .prepare(`SELECT * FROM play_orders WHERE purchaseToken = ?`)
      .get(purchaseToken);
  }

  upsert(row) {
    const now = nowSeconds();
    const existing = this.get(row.purchaseToken);

    if (existing) {
      this.db
        .prepare(
          `UPDATE play_orders
             SET status = ?, purchaseState = ?, purchaseType = ?,
                 gpOrderId = COALESCE(?, gpOrderId),
                 quantity = ?, totalDC = ?, regionCode = COALESCE(?, regionCode),
                 failReason = ?, updatedAt = ?
           WHERE purchaseToken = ?`,
        )
        .run(
          row.status,
          row.purchaseState ?? null,
          row.purchaseType ?? null,
          row.gpOrderId || null,
          row.quantity,
          row.totalDC,
          row.regionCode || null,
          row.failReason || null,
          now,
          row.purchaseToken,
        );
      return this.get(row.purchaseToken);
    }

    this.db
      .prepare(
        `INSERT INTO play_orders
           (purchaseToken, playerId, productId, packageId, quantity, totalDC,
            gpOrderId, status, purchaseState, purchaseType, regionCode,
            failReason, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.purchaseToken,
        row.playerId,
        row.productId,
        row.packageId,
        row.quantity,
        row.totalDC,
        row.gpOrderId || null,
        row.status,
        row.purchaseState ?? null,
        row.purchaseType ?? null,
        row.regionCode || null,
        row.failReason || null,
        now,
        now,
      );

    return this.get(row.purchaseToken);
  }

  markAcknowledged(purchaseToken) {
    this.db
      .prepare(`UPDATE play_orders SET acknowledged = 1, updatedAt = ? WHERE purchaseToken = ?`)
      .run(nowSeconds(), purchaseToken);
  }

  /**
   * Crédito IDEMPOTENTE — mesmo guard do shop-dc.js: UPDATE condicional em
   * `creditedAt IS NULL`. Se o RTDN e o polling do cliente chegarem juntos,
   * o segundo UPDATE afeta 0 linhas e ninguém credita duas vezes.
   */
  credit(purchaseToken) {
    const tx = this.db.transaction(() => {
      const order = this.get(purchaseToken);
      if (!order) return { credited: false, reason: "not_found" };
      if (order.creditedAt) {
        return { credited: false, reason: "already_credited", totalDC: order.totalDC };
      }
      if (order.voidedAt) return { credited: false, reason: "voided" };

      const res = this.db
        .prepare(
          `UPDATE play_orders SET status = 'credited', creditedAt = ?, updatedAt = ?
           WHERE purchaseToken = ? AND creditedAt IS NULL`,
        )
        .run(nowSeconds(), nowSeconds(), purchaseToken);

      if (res.changes !== 1) return { credited: false, reason: "race_lost" };

      this.db
        .prepare(`UPDATE accounts SET balanceDC = balanceDC + ? WHERE playerId = ?`)
        .run(order.totalDC, order.playerId);

      const balanceDC = this.db
        .prepare(`SELECT balanceDC FROM accounts WHERE playerId = ?`)
        .get(order.playerId).balanceDC;

      this.db
        .prepare(
          `INSERT INTO dc_ledger (playerId, delta, balance, source, refId, createdAt)
           VALUES (?, ?, ?, 'googleplay', ?, ?)`,
        )
        .run(order.playerId, order.totalDC, balanceDC, purchaseToken, nowSeconds());

      return {
        credited: true,
        playerId: order.playerId,
        totalDC: order.totalDC,
        balanceDC,
      };
    });

    return tx();
  }

  /**
   * Estorno / chargeback. Debita o que der, sem deixar o saldo negativo.
   * O que já foi gasto não volta — por isso o log de "residual" pra revisão.
   */
  revoke(purchaseToken, reason) {
    const tx = this.db.transaction(() => {
      const order = this.get(purchaseToken);
      if (!order) return { revoked: false, reason: "not_found" };
      if (order.voidedAt) return { revoked: false, reason: "already_voided" };

      this.db
        .prepare(
          `UPDATE play_orders SET status = 'voided', voidedAt = ?, failReason = ?, updatedAt = ?
           WHERE purchaseToken = ?`,
        )
        .run(nowSeconds(), reason || null, nowSeconds(), purchaseToken);

      if (!order.creditedAt) return { revoked: true, debited: 0, residual: 0 };

      const current = this.db
        .prepare(`SELECT balanceDC FROM accounts WHERE playerId = ?`)
        .get(order.playerId);

      const saldo = current ? current.balanceDC : 0;
      const debitar = Math.min(saldo, order.totalDC);
      const residual = order.totalDC - debitar;

      if (debitar > 0) {
        this.db
          .prepare(`UPDATE accounts SET balanceDC = balanceDC - ? WHERE playerId = ?`)
          .run(debitar, order.playerId);

        this.db
          .prepare(
            `INSERT INTO dc_ledger (playerId, delta, balance, source, refId, createdAt)
             VALUES (?, ?, ?, 'googleplay_refund', ?, ?)`,
          )
          .run(order.playerId, -debitar, saldo - debitar, purchaseToken, nowSeconds());
      }

      return { revoked: true, playerId: order.playerId, debited: debitar, residual };
    });

    return tx();
  }

  listPlayerOrders(playerId, limit = 20) {
    return this.db
      .prepare(
        `SELECT purchaseToken, productId, totalDC, status, gpOrderId,
                createdAt, creditedAt, voidedAt
         FROM play_orders WHERE playerId = ?
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(playerId, limit);
  }

  // Compras confirmadas mas ainda não reconhecidas no Google.
  // O Play REEMBOLSA sozinho depois de 3 dias sem acknowledge — esse job existe
  // pra que uma falha de rede no momento da compra não vire estorno automático.
  listUnacknowledged(maxAgeSeconds = 3600) {
    return this.db
      .prepare(
        `SELECT * FROM play_orders
         WHERE acknowledged = 0 AND creditedAt IS NOT NULL AND voidedAt IS NULL
           AND updatedAt < ?`,
      )
      .all(nowSeconds() - maxAgeSeconds);
  }

  // Compras que ficaram "pending" (Pix/boleto dentro do Play).
  listPending(maxAgeSeconds = 7 * 24 * 3600) {
    return this.db
      .prepare(
        `SELECT * FROM play_orders
         WHERE status = 'pending' AND creditedAt IS NULL AND voidedAt IS NULL
           AND createdAt > ?`,
      )
      .all(nowSeconds() - maxAgeSeconds);
  }

  relatorio(horas = 24) {
    const desde = nowSeconds() - horas * 3600;
    return this.db
      .prepare(
        `SELECT status, COUNT(*) AS total, SUM(totalDC) AS dc
         FROM play_orders WHERE createdAt >= ? GROUP BY status`,
      )
      .all(desde);
  }
}

// ============================================================================
// CLIENTE DA GOOGLE PLAY DEVELOPER API
// ============================================================================

let _auth = null;

function getAuth() {
  if (!_auth) {
    _auth = new GoogleAuth({
      keyFile: PLAY_SERVICE_ACCOUNT_FILE,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return _auth;
}

async function playRequest(pathname, { method = "GET", body } = {}) {
  const client = await getAuth().getClient();
  const { token } = await client.getAccessToken();

  const res = await fetch(`${ANDROID_PUBLISHER}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta não-JSON */
  }

  if (!res.ok) {
    const err = new Error(
      `Play ${method} ${pathname} -> ${res.status}: ${json?.error?.message || text?.slice(0, 300)}`,
    );
    err.status = res.status;
    err.playBody = json;
    throw err;
  }

  return json;
}

function getProductPurchase(productId, purchaseToken) {
  return playRequest(
    `/applications/${PLAY_PACKAGE_NAME}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`,
  );
}

function acknowledgeProductPurchase(productId, purchaseToken, developerPayload) {
  return playRequest(
    `/applications/${PLAY_PACKAGE_NAME}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    { method: "POST", body: { developerPayload: developerPayload || "" } },
  );
}

function consumeProductPurchase(productId, purchaseToken) {
  return playRequest(
    `/applications/${PLAY_PACKAGE_NAME}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
    { method: "POST" },
  );
}

function listVoidedPurchases(startTimeMillis) {
  return playRequest(
    `/applications/${PLAY_PACKAGE_NAME}/purchases/voidedpurchases?startTime=${startTimeMillis}&type=0`,
  );
}

// ============================================================================
// NÚCLEO: verificar + creditar
// ============================================================================

/**
 * Verifica o purchaseToken direto com o Google e credita se for o caso.
 * Chamado pelo cliente (/shop/google/verify), pelo RTDN e pelos jobs.
 *
 * @param {number|null} playerId  quem está reivindicando (null = veio de webhook)
 */
async function verificarECreditar(
  { productId, purchaseToken, playerId },
  { googleShop, logger, onCredited },
) {
  const product = getPlayProduct(productId);
  if (!product) {
    return { ok: false, error: "produto_desconhecido", productId };
  }

  const existing = googleShop.get(purchaseToken);

  // Token já registrado para OUTRO jogador = tentativa de reaproveitar recibo.
  if (existing && playerId != null && existing.playerId !== playerId) {
    logger.warn(
      `[Play] Token de outro jogador: token pertence a ${existing.playerId}, reivindicado por ${playerId}`,
    );
    return { ok: false, error: "token_de_outro_jogador" };
  }

  if (existing?.voidedAt) {
    return { ok: true, state: "voided", credited: false, alreadyCredited: false };
  }

  // ── A verdade vem do Google, nunca do cliente ─────────────────────────────
  let purchase;
  try {
    purchase = await getProductPurchase(productId, purchaseToken);
  } catch (error) {
    if (error.status === 404 || error.status === 400) {
      logger.warn(`[Play] Token inválido/expirado (${error.status}): ${error.message}`);
      return { ok: false, error: "token_invalido" };
    }
    throw error;
  }

  const owner = playerId ?? existing?.playerId ?? null;
  if (owner == null) {
    logger.warn(`[Play] Token sem dono conhecido: ${purchaseToken.slice(0, 16)}…`);
    return { ok: false, error: "sem_dono" };
  }

  // ── Amarração compra ↔ conta ──────────────────────────────────────────────
  const esperado = obfuscatedAccountId(owner);
  if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== esperado) {
    logger.error(
      `[Play] obfuscatedAccountId divergente no token ${purchaseToken.slice(0, 16)}… (player ${owner})`,
    );
    return { ok: false, error: "conta_divergente" };
  }

  // ── Compra de teste em produção ───────────────────────────────────────────
  if (purchase.purchaseType === TYPE_TEST && !PLAY_ALLOW_TEST_PURCHASES) {
    logger.warn(`[Play] Compra de TESTE recusada em produção (player ${owner})`);
    googleShop.upsert({
      purchaseToken,
      playerId: owner,
      productId,
      packageId: product.packageId,
      quantity: 1,
      totalDC: 0,
      gpOrderId: purchase.orderId,
      status: "rejected",
      purchaseState: purchase.purchaseState,
      purchaseType: purchase.purchaseType,
      regionCode: purchase.regionCode,
      failReason: "test_purchase_blocked",
    });
    return { ok: false, error: "compra_de_teste" };
  }

  // Google permite comprar N unidades do mesmo consumível de uma vez.
  const quantity = Math.max(1, purchase.quantity || 1);
  const totalDC = product.totalDC * quantity;

  const status =
    purchase.purchaseState === STATE_PURCHASED
      ? "purchased"
      : purchase.purchaseState === STATE_PENDING
        ? "pending"
        : "canceled";

  googleShop.upsert({
    purchaseToken,
    playerId: owner,
    productId,
    packageId: product.packageId,
    quantity,
    totalDC,
    gpOrderId: purchase.orderId,
    status,
    purchaseState: purchase.purchaseState,
    purchaseType: purchase.purchaseType,
    regionCode: purchase.regionCode,
    failReason: null,
  });

  if (purchase.acknowledgementState === 1) googleShop.markAcknowledged(purchaseToken);

  // ── Pagamento ainda não concluído (Pix/boleto dentro do Play) ─────────────
  if (purchase.purchaseState === STATE_PENDING) {
    logger.debug(`[Play] Compra pendente (player ${owner}, ${productId})`);
    return { ok: true, state: "pending", credited: false, totalDC };
  }

  if (purchase.purchaseState === STATE_CANCELED) {
    return { ok: true, state: "canceled", credited: false };
  }

  // ── Aprovada: credita ─────────────────────────────────────────────────────
  const result = googleShop.credit(purchaseToken);

  if (result.credited) {
    logger.info(
      `[Play] ✓ +${result.totalDC} DC para player ${result.playerId} (saldo ${result.balanceDC}) | ${productId} | order ${purchase.orderId}`,
    );
    onCredited?.(result.playerId, result.totalDC, result.balanceDC, purchase.orderId);
  }

  // ── Acknowledge: sem isso o Google estorna sozinho em 3 dias ──────────────
  if (purchase.acknowledgementState !== 1) {
    try {
      await acknowledgeProductPurchase(productId, purchaseToken, String(owner));
      googleShop.markAcknowledged(purchaseToken);
    } catch (error) {
      // 400 aqui normalmente é "já reconhecida" (o cliente consumiu primeiro).
      logger.warn(`[Play] acknowledge falhou (${error.status}): ${error.message}`);
    }
  }

  return {
    ok: true,
    state: "purchased",
    credited: result.credited,
    alreadyCredited: result.reason === "already_credited",
    totalDC: result.totalDC ?? totalDC,
    balanceDC: result.balanceDC,
  };
}

// ============================================================================
// MIDDLEWARE DE POLÍTICA
//
// Trava dupla contra vender fora do billing do Google numa build da Play:
//   1) o cliente Android compilado nem tem o código do Mercado Pago;
//   2) o servidor recusa /shop/dc/checkout se o cliente se identificar como Play.
// ============================================================================

function bloquearMercadoPagoNaPlayStore(config, logger) {
  return (req, res, next) => {
    const store = String(req.headers["x-store"] || "").toLowerCase();
    const platform = String(req.headers["x-platform"] || "").toLowerCase();

    if (store === "googleplay" || (platform === "android" && store !== "standalone")) {
      logger.warn(
        `[Play] /shop/dc/checkout bloqueado para cliente Play (player ${req.playerId ?? "?"})`,
      );
      return res.status(403).json({
        ok: false,
        error: "Nesta versão do jogo a compra é feita pelo Google Play.",
        provider: "googleplay",
      });
    }

    next();
  };
}

// ============================================================================
// ROTAS
// ============================================================================

function registrarRotasGooglePlay(app, deps) {
  const { logger, googleShop, jwtAuth, rateLimiter, onCredited } = deps;

  if (!PLAY_PACKAGE_NAME || !PLAY_SERVICE_ACCOUNT_FILE) {
    logger.error("[Play] PLAY_PACKAGE_NAME ou PLAY_SERVICE_ACCOUNT_FILE ausentes no .env");
  }
  if (!PLAY_ACCOUNT_SALT) {
    logger.warn("[Play] PLAY_ACCOUNT_SALT não configurado — defina antes de ir pra produção");
  }

  // ── Catálogo Android ──────────────────────────────────────────────────────
  // Sem preço: o preço vem do Play Console e o cliente lê via Unity IAP
  // (localizedPriceString). Aqui só sai a quantidade de DC, que é nossa.
  app.get("/shop/google/products", jwtAuth, rateLimiter.middleware(), (req, res) => {
    res.json({
      ok: true,
      provider: "googleplay",
      packageName: PLAY_PACKAGE_NAME,
      obfuscatedAccountId: obfuscatedAccountId(req.playerId),
      products: PLAY_PRODUCTS.map((p) => ({
        productId: p.productId,
        amountDC: p.amountDC,
        bonusDC: p.bonusDC,
        totalDC: p.totalDC,
      })),
    });
  });

  // ── Verificação da compra (o cliente chama ANTES de consumir) ─────────────
  app.post("/shop/google/verify", jwtAuth, rateLimiter.middleware(), async (req, res) => {
    const { productId, purchaseToken } = req.body || {};

    if (typeof productId !== "string" || typeof purchaseToken !== "string" || !purchaseToken) {
      return res.status(400).json({ ok: false, error: "productId e purchaseToken são obrigatórios" });
    }

    try {
      const result = await verificarECreditar(
        { productId, purchaseToken, playerId: req.playerId },
        { googleShop, logger, onCredited },
      );

      if (!result.ok) return res.status(400).json(result);

      // consumeOk diz ao cliente se ele pode chamar ConfirmPurchase.
      // Só liberamos quando o DC já está no banco (ou a compra morreu).
      const consumeOk =
        result.state === "purchased" || result.state === "canceled" || result.state === "voided";

      res.json({ ...result, consumeOk });
    } catch (error) {
      logger.error(`[Play] Erro em /shop/google/verify: ${error.message}`);
      res.status(502).json({ ok: false, error: "Falha ao validar a compra com o Google" });
    }
  });

  // ── Histórico (a loja consulta ao abrir) ──────────────────────────────────
  app.get("/shop/google/orders", jwtAuth, (req, res) => {
    res.json({ ok: true, orders: googleShop.listPlayerOrders(req.playerId) });
  });

  // ── RTDN (Real-time Developer Notifications, via Pub/Sub push) ────────────
  // É a rede de segurança: reembolso, chargeback e Pix que confirma depois
  // chegam aqui mesmo com o jogo fechado.
  app.post("/webhooks/google/rtdn", async (req, res) => {
    if (PLAY_RTDN_SECRET) {
      const enviado = String(req.query.secret || "");
      const esperado = PLAY_RTDN_SECRET;
      const iguais =
        enviado.length === esperado.length &&
        crypto.timingSafeEqual(Buffer.from(enviado), Buffer.from(esperado));
      if (!iguais) {
        logger.warn("[Play] RTDN com segredo inválido — rejeitado");
        return res.status(401).json({ ok: false });
      }
    }

    // ACK imediato: o Pub/Sub reenvia em caso de erro, e reenvio é inofensivo
    // porque tudo aqui é idempotente.
    res.status(204).end();

    try {
      const encoded = req.body?.message?.data;
      if (!encoded) return;

      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      logger.debug(`[Play] RTDN: ${JSON.stringify(payload).slice(0, 300)}`);

      // Reembolso / chargeback
      if (payload.voidedPurchaseNotification) {
        const { purchaseToken, orderId } = payload.voidedPurchaseNotification;
        const r = googleShop.revoke(purchaseToken, "voided_by_google");
        if (r.revoked) {
          logger.warn(
            `[Play] ⚠ Estorno ${orderId}: -${r.debited} DC do player ${r.playerId}` +
              (r.residual > 0 ? ` (${r.residual} DC já gastos — revisar)` : ""),
          );
        }
        return;
      }

      // Consumível: 1 = comprado (pending virou pago), 2 = cancelado
      if (payload.oneTimeProductNotification) {
        const { purchaseToken, sku, notificationType } = payload.oneTimeProductNotification;

        if (notificationType === 2) {
          googleShop.revoke(purchaseToken, "one_time_product_canceled");
          return;
        }

        await verificarECreditar(
          { productId: sku, purchaseToken, playerId: null },
          { googleShop, logger, onCredited },
        );
      }
    } catch (error) {
      logger.error(`[Play] Erro processando RTDN: ${error.message}`);
    }
  });

  logger.info("[Play] Rotas de Google Play Billing registradas");
}

// ============================================================================
// JOBS
// ============================================================================

function iniciarJobsGooglePlay({ googleShop, logger, onCredited }) {
  // 1) Reconhece compras que ficaram sem acknowledge (3 dias = estorno automático)
  const t1 = setInterval(async () => {
    for (const order of googleShop.listUnacknowledged(3600)) {
      try {
        await acknowledgeProductPurchase(order.productId, order.purchaseToken, String(order.playerId));
        googleShop.markAcknowledged(order.purchaseToken);
        logger.info(`[Play] acknowledge tardio OK: ${order.purchaseToken.slice(0, 16)}…`);
      } catch (error) {
        logger.warn(`[Play] acknowledge tardio falhou: ${error.message}`);
      }
    }
  }, 15 * 60 * 1000);

  // 2) Reconsulta compras pendentes (Pix/boleto dentro do Play)
  const t2 = setInterval(async () => {
    for (const order of googleShop.listPending()) {
      try {
        await verificarECreditar(
          { productId: order.productId, purchaseToken: order.purchaseToken, playerId: order.playerId },
          { googleShop, logger, onCredited },
        );
      } catch (error) {
        logger.warn(`[Play] recheck de pendente falhou: ${error.message}`);
      }
    }
  }, 10 * 60 * 1000);

  // 3) Varredura de estornos — cobre a janela em que o RTDN falhou
  const t3 = setInterval(async () => {
    try {
      const desde = Date.now() - 24 * 3600 * 1000;
      const res = await listVoidedPurchases(desde);
      for (const v of res?.voidedPurchases || []) {
        const r = googleShop.revoke(v.purchaseToken, "voided_scan");
        if (r.revoked && r.debited >= 0) {
          logger.warn(`[Play] ⚠ Estorno detectado na varredura: order ${v.orderId}`);
        }
      }
    } catch (error) {
      logger.warn(`[Play] Varredura de estornos falhou: ${error.message}`);
    }
  }, 60 * 60 * 1000);

  for (const t of [t1, t2, t3]) if (t.unref) t.unref();

  logger.info("[Play] Jobs de Google Play iniciados");
}

module.exports = {
  GoogleShopStore,
  registrarRotasGooglePlay,
  iniciarJobsGooglePlay,
  bloquearMercadoPagoNaPlayStore,
  verificarECreditar,
  obfuscatedAccountId,
  getProductPurchase,
  acknowledgeProductPurchase,
  consumeProductPurchase,
  PLAY_PRODUCTS,
};