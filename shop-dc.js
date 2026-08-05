// ============================================================================
// shop-dc.js — Compra de DC Coin via Mercado Pago (Checkout Pro)
//
// Uso no master (server.js):
//
//   const { ShopStore, registrarRotasLoja } = require("./shop-dc");
//   const shopStore = new ShopStore(authStore.db, config, logger);
//   ...
//   registrarRotasLoja(app, { config, logger, shopStore, authStore, jwtAuth, serverAuth, rateLimiter });
//
// .env necessário:
//   MP_ACCESS_TOKEN=APP_USR-...     (secreto, NUNCA vai pro cliente)
//   MP_PUBLIC_KEY=APP_USR-...       (pode ir pro cliente)
//   MP_WEBHOOK_SECRET=...           (assinatura secreta, em "Suas integrações")
// ============================================================================

require("dotenv").config();

const crypto = require("crypto");

const MP_API = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

// Janela em que o link de pagamento continua válido. O usuário pode fechar o
// jogo, pagar o Pix no banco e voltar depois — o crédito acontece pelo webhook,
// independente do cliente estar aberto.
const ORDER_TTL_SECONDS = 30 * 60;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// MP espera ISO-8601 com offset explícito (não aceita o "Z" do toISOString()).
function mpDate(ms) {
  return new Date(ms).toISOString().replace("Z", "+00:00");
}

// ============================================================================
// CATÁLOGO — fonte da verdade fica AQUI, no servidor.
// O cliente só manda packageId. Preço/quantidade nunca vêm do cliente.
// ============================================================================

const DC_PACKAGES = [
  { packageId: "dc_60",   amountDC: 60,   bonusDC: 0, priceCents: 490 },
  { packageId: "dc_300",  amountDC: 300,  bonusDC: 0, priceCents: 1990 },
  { packageId: "dc_680",  amountDC: 680,  bonusDC: 0, priceCents: 3990 },
  { packageId: "dc_1280", amountDC: 1280, bonusDC: 0, priceCents: 6990 },
  { packageId: "dc_2800", amountDC: 2800, bonusDC: 0, priceCents: 14990 },
  { packageId: "dc_5800", amountDC: 5800, bonusDC: 0, priceCents: 29990 },
];

function getPackage(packageId) {
  return DC_PACKAGES.find((p) => p.packageId === packageId) || null;
}

function packageToPublic(p) {
  return {
    packageId: p.packageId,
    amountDC: p.amountDC,
    bonusDC: p.bonusDC,
    totalDC: p.amountDC + p.bonusDC,
    priceCents: p.priceCents,
    currency: "BRL",
    priceLabel: `R$ ${(p.priceCents / 100).toFixed(2).replace(".", ",")}`,
  };
}

// ============================================================================
// STORE
// ============================================================================

class ShopStore {
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dc_orders (
        orderId       TEXT PRIMARY KEY,
        playerId      INTEGER NOT NULL,
        packageId     TEXT NOT NULL,
        amountDC      INTEGER NOT NULL,
        bonusDC       INTEGER NOT NULL DEFAULT 0,
        priceCents    INTEGER NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'BRL',
        status        TEXT NOT NULL,
        preferenceId  TEXT,
        initPoint     TEXT,
        paymentId     TEXT,
        paymentMethod TEXT,
        paidAmount    REAL,
        failReason    TEXT,
        createdAt     INTEGER NOT NULL,
        expiresAt     INTEGER NOT NULL,
        creditedAt    INTEGER,
        FOREIGN KEY (playerId) REFERENCES accounts(playerId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dc_orders_player ON dc_orders(playerId);
      CREATE INDEX IF NOT EXISTS idx_dc_orders_status ON dc_orders(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_orders_payment
        ON dc_orders(paymentId) WHERE paymentId IS NOT NULL;

      CREATE TABLE IF NOT EXISTS dc_ledger (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        playerId  INTEGER NOT NULL,
        delta     INTEGER NOT NULL,
        balance   INTEGER NOT NULL,
        source    TEXT NOT NULL,
        refId     TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dc_ledger_player ON dc_ledger(playerId);
    `);
  }

  createOrder(playerId, pkg) {
    const now = nowSeconds();
    const orderId = `dc_${playerId}_${now}_${crypto.randomBytes(4).toString("hex")}`;

    this.db
      .prepare(
        `INSERT INTO dc_orders
           (orderId, playerId, packageId, amountDC, bonusDC, priceCents, currency,
            status, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, 'BRL', 'pending', ?, ?)`,
      )
      .run(
        orderId,
        playerId,
        pkg.packageId,
        pkg.amountDC,
        pkg.bonusDC,
        pkg.priceCents,
        now,
        now + ORDER_TTL_SECONDS,
      );

    return this.getOrder(orderId);
  }

  attachPreference(orderId, preferenceId, initPoint) {
    this.db
      .prepare(`UPDATE dc_orders SET preferenceId = ?, initPoint = ? WHERE orderId = ?`)
      .run(preferenceId, initPoint, orderId);
  }

  getOrder(orderId) {
    return this.db.prepare(`SELECT * FROM dc_orders WHERE orderId = ?`).get(orderId);
  }

  getOrderByPaymentId(paymentId) {
    return this.db
      .prepare(`SELECT * FROM dc_orders WHERE paymentId = ?`)
      .get(String(paymentId));
  }

  listPlayerOrders(playerId, limit = 20) {
    return this.db
      .prepare(
        `SELECT orderId, packageId, amountDC, bonusDC, priceCents, status,
                paymentMethod, createdAt, expiresAt, creditedAt, initPoint
         FROM dc_orders WHERE playerId = ?
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(playerId, limit);
  }

  listPendingOrders(playerId) {
    return this.db
      .prepare(
        `SELECT orderId, packageId, initPoint, expiresAt
         FROM dc_orders
         WHERE playerId = ? AND status = 'pending' AND expiresAt > ?
         ORDER BY createdAt DESC`,
      )
      .all(playerId, nowSeconds());
  }

  markFailed(orderId, status, reason, paymentId, paymentMethod) {
    this.db
      .prepare(
        `UPDATE dc_orders
         SET status = ?, failReason = ?, paymentId = COALESCE(?, paymentId),
             paymentMethod = COALESCE(?, paymentMethod)
         WHERE orderId = ? AND creditedAt IS NULL`,
      )
      .run(status, reason || null, paymentId ? String(paymentId) : null, paymentMethod || null, orderId);
  }

  /**
   * Credita o pacote de forma IDEMPOTENTE.
   *
   * O guard é o UPDATE condicional em `creditedAt IS NULL`: se o webhook chegar
   * duas vezes (o MP reenvia), o segundo UPDATE afeta 0 linhas e a função sai
   * sem creditar de novo. Tudo dentro de uma transação do SQLite.
   *
   * @returns {{credited: boolean, balanceDC?: number, totalDC?: number}}
   */
  creditOrder(orderId, payment) {
    const tx = this.db.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) return { credited: false, reason: "order_not_found" };
      if (order.creditedAt) return { credited: false, reason: "already_credited" };

      const totalDC = order.amountDC + order.bonusDC;

      const res = this.db
        .prepare(
          `UPDATE dc_orders
           SET status = 'approved', creditedAt = ?, paymentId = ?,
               paymentMethod = ?, paidAmount = ?
           WHERE orderId = ? AND creditedAt IS NULL`,
        )
        .run(
          nowSeconds(),
          String(payment.id),
          payment.payment_method_id || payment.payment_type_id || null,
          payment.transaction_amount ?? null,
          orderId,
        );

      if (res.changes !== 1) return { credited: false, reason: "race_lost" };

      this.db
        .prepare(`UPDATE accounts SET balanceDC = balanceDC + ? WHERE playerId = ?`)
        .run(totalDC, order.playerId);

      const balanceDC = this.db
        .prepare(`SELECT balanceDC FROM accounts WHERE playerId = ?`)
        .get(order.playerId).balanceDC;

      this.db
        .prepare(
          `INSERT INTO dc_ledger (playerId, delta, balance, source, refId, createdAt)
           VALUES (?, ?, ?, 'mercadopago', ?, ?)`,
        )
        .run(order.playerId, totalDC, balanceDC, orderId, nowSeconds());

      return { credited: true, balanceDC, totalDC, playerId: order.playerId };
    });

    return tx();
  }

  expireStaleOrders() {
    const res = this.db
      .prepare(
        `UPDATE dc_orders SET status = 'expired'
         WHERE status = 'pending' AND creditedAt IS NULL AND expiresAt < ?`,
      )
      .run(nowSeconds());
    return res.changes;
  }
}

// ============================================================================
// CLIENTE MERCADO PAGO (fetch nativo — Node 18+)
// ============================================================================

async function mpRequest(pathname, { method = "GET", body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${MP_API}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta não-JSON: mantém null e deixa o erro abaixo falar */
  }

  if (!res.ok) {
    const err = new Error(
      `MP ${method} ${pathname} -> ${res.status}: ${json?.message || text?.slice(0, 300)}`,
    );
    err.status = res.status;
    err.mpBody = json;
    throw err;
  }

  return json;
}

function createPreference(order, pkg, baseUrl) {
  const total = pkg.amountDC + pkg.bonusDC;

  return mpRequest("/checkout/preferences", {
    method: "POST",
    idempotencyKey: order.orderId, // evita preferência duplicada em retry
    body: {
      items: [
        {
          id: pkg.packageId,
          title: `${total} DC Coin`,
          description: pkg.bonusDC > 0
            ? `${pkg.amountDC} DC + ${pkg.bonusDC} de bônus`
            : `${pkg.amountDC} DC Coin`,
          category_id: "virtual_goods",
          quantity: 1,
          currency_id: "BRL",
          unit_price: pkg.priceCents / 100,
        },
      ],
      // external_reference é o fio que liga o pagamento do MP ao nosso pedido.
      external_reference: order.orderId,
      notification_url: `${baseUrl}/webhooks/mercadopago`,
      back_urls: {
        success: `${baseUrl}/shop/dc/return?order=${order.orderId}&r=success`,
        pending: `${baseUrl}/shop/dc/return?order=${order.orderId}&r=pending`,
        failure: `${baseUrl}/shop/dc/return?order=${order.orderId}&r=failure`,
      },
      auto_return: "approved",
      statement_descriptor: "DCGAME",
      binary_mode: false, // false: permite "pending" (Pix aguardando, boleto)
      expires: true,
      expiration_date_from: mpDate(order.createdAt * 1000),
      expiration_date_to: mpDate(order.expiresAt * 1000),
      metadata: {
        player_id: order.playerId,
        order_id: order.orderId,
        package_id: pkg.packageId,
      },
    },
  });
}

function getPayment(paymentId) {
  return mpRequest(`/v1/payments/${paymentId}`);
}

// Fallback quando o webhook não chegou: procura o pagamento pelo nosso orderId.
async function findPaymentByOrderId(orderId) {
  const res = await mpRequest(
    `/v1/payments/search?external_reference=${encodeURIComponent(orderId)}&sort=date_created&criteria=desc&limit=10`,
  );
  const results = res?.results || [];
  return results.find((p) => p.status === "approved") || results[0] || null;
}

// ============================================================================
// VALIDAÇÃO DA ASSINATURA DO WEBHOOK
// manifest = id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// ============================================================================

function verifyWebhookSignature(req, logger) {
  if (!MP_WEBHOOK_SECRET) {
    logger.warn("[Shop] MP_WEBHOOK_SECRET não configurado — assinatura NÃO validada");
    return true; // permite rodar em dev; em produção configure o secret
  }

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (!signature) return false;

  let ts = null;
  let hash = null;
  for (const part of String(signature).split(",")) {
    const [k, v] = part.split("=", 2);
    if (!k || !v) continue;
    const key = k.trim();
    if (key === "ts") ts = v.trim();
    else if (key === "v1") hash = v.trim();
  }
  if (!ts || !hash) return false;

  // O data.id do manifest é o da QUERY STRING, não o do body.
  const dataId = req.query["data.id"] || req.query.id || req.body?.data?.id || "";

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ""};ts:${ts};`;
  const expected = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
  } catch {
    return false;
  }
}

// ============================================================================
// PROCESSAMENTO DO PAGAMENTO (usado pelo webhook e pela reconciliação)
// ============================================================================

async function processPayment(paymentId, { shopStore, logger, onCredited }) {
  const payment = await getPayment(paymentId);

  const orderId = payment.external_reference;
  if (!orderId) {
    logger.warn(`[Shop] Pagamento ${paymentId} sem external_reference — ignorado`);
    return { handled: false };
  }

  const order = shopStore.getOrder(orderId);
  if (!order) {
    logger.warn(`[Shop] Pedido ${orderId} não encontrado (pagamento ${paymentId})`);
    return { handled: false };
  }

  if (order.creditedAt) {
    logger.debug(`[Shop] Pedido ${orderId} já creditado — webhook duplicado`);
    return { handled: true, alreadyCredited: true };
  }

  // ── Anti-fraude: o valor pago tem que bater com o preço do pacote ──────────
  const expected = order.priceCents / 100;
  const paid = Number(payment.transaction_amount);

  if (payment.status === "approved" && Math.abs(paid - expected) > 0.01) {
    logger.error(
      `[Shop] VALOR DIVERGENTE no pedido ${orderId}: esperado R$${expected}, pago R$${paid}. Não creditado.`,
    );
    shopStore.markFailed(orderId, "review", "amount_mismatch", paymentId, payment.payment_method_id);
    return { handled: true, credited: false, reason: "amount_mismatch" };
  }

  if (payment.currency_id && payment.currency_id !== order.currency) {
    logger.error(`[Shop] Moeda divergente no pedido ${orderId}: ${payment.currency_id}`);
    shopStore.markFailed(orderId, "review", "currency_mismatch", paymentId, payment.payment_method_id);
    return { handled: true, credited: false, reason: "currency_mismatch" };
  }

  switch (payment.status) {
    case "approved": {
      const result = shopStore.creditOrder(orderId, payment);
      if (result.credited) {
        logger.info(
          `[Shop] ✓ Pedido ${orderId} creditado: +${result.totalDC} DC para player ${result.playerId} (saldo ${result.balanceDC}) via ${payment.payment_method_id}`,
        );
        onCredited?.(result.playerId, result.totalDC, result.balanceDC, orderId);
      }
      return { handled: true, ...result };
    }

    case "pending":
    case "in_process":
    case "authorized":
      // Pix gerado mas não pago ainda, ou cartão em análise. Só anota o paymentId.
      shopStore.db
        .prepare(
          `UPDATE dc_orders SET paymentId = ?, paymentMethod = ?
           WHERE orderId = ? AND creditedAt IS NULL`,
        )
        .run(String(payment.id), payment.payment_method_id || null, orderId);
      logger.debug(`[Shop] Pedido ${orderId} aguardando pagamento (${payment.status})`);
      return { handled: true, credited: false, pending: true };

    case "rejected":
      shopStore.markFailed(orderId, "rejected", payment.status_detail, paymentId, payment.payment_method_id);
      return { handled: true, credited: false };

    case "cancelled":
      shopStore.markFailed(orderId, "cancelled", payment.status_detail, paymentId, payment.payment_method_id);
      return { handled: true, credited: false };

    case "refunded":
    case "charged_back":
      // Não estorna DC automaticamente — pode já ter sido gasto.
      // Marca para revisão manual pelo console de admin.
      shopStore.markFailed(orderId, "review", payment.status, paymentId, payment.payment_method_id);
      logger.warn(`[Shop] ⚠ ${payment.status} no pedido ${orderId} — revisar manualmente`);
      return { handled: true, credited: false };

    default:
      logger.warn(`[Shop] Status desconhecido "${payment.status}" no pedido ${orderId}`);
      return { handled: true, credited: false };
  }
}

// ============================================================================
// ROTAS
// ============================================================================

function registrarRotasLoja(app, deps) {
  const { config, logger, shopStore, jwtAuth, rateLimiter, onCredited } = deps;

  if (!MP_ACCESS_TOKEN) {
    logger.error("[Shop] MP_ACCESS_TOKEN ausente no .env — /shop/dc/checkout vai falhar");
  }

  const baseUrl = String(config.publicBaseUrl || "").replace(/\/+$/, "");

  // ── Catálogo ──────────────────────────────────────────────────────────────
  app.get("/shop/dc/packages", rateLimiter.middleware(), (req, res) => {
    res.json({
      ok: true,
      currency: "BRL",
      publicKey: MP_PUBLIC_KEY || null,
      packages: DC_PACKAGES.map(packageToPublic),
    });
  });

  // ── Cria o pedido e a preferência de pagamento ─────────────────────────────
  app.post("/shop/dc/checkout", jwtAuth, rateLimiter.middleware(), async (req, res) => {
    const { packageId } = req.body || {};

    if (!packageId || typeof packageId !== "string") {
      return res.status(400).json({ ok: false, error: "packageId é obrigatório" });
    }

    const pkg = getPackage(packageId);
    if (!pkg) {
      return res.status(404).json({ ok: false, error: "Pacote não encontrado" });
    }

    // Reaproveita pedido pendente do mesmo pacote em vez de criar outro link.
    const reusable = shopStore
      .listPendingOrders(req.playerId)
      .find((o) => o.packageId === packageId && o.initPoint);

    if (reusable) {
      logger.debug(`[Shop] Reaproveitando pedido pendente ${reusable.orderId}`);
      return res.json({
        ok: true,
        orderId: reusable.orderId,
        payUrl: `${baseUrl}/shop/dc/pay/${reusable.orderId}`,
        initPoint: reusable.initPoint,
        expiresAt: reusable.expiresAt,
        reused: true,
      });
    }

    let order;
    try {
      order = shopStore.createOrder(req.playerId, pkg);
      const pref = await createPreference(order, pkg, baseUrl);
      shopStore.attachPreference(order.orderId, pref.id, pref.init_point);

      logger.info(
        `[Shop] Checkout criado: player ${req.playerId} | ${pkg.packageId} | R$${(pkg.priceCents / 100).toFixed(2)} | ${order.orderId}`,
      );

      res.json({
        ok: true,
        orderId: order.orderId,
        payUrl: `${baseUrl}/shop/dc/pay/${order.orderId}`,
        initPoint: pref.init_point,
        preferenceId: pref.id,
        expiresAt: order.expiresAt,
        totalDC: pkg.amountDC + pkg.bonusDC,
        priceCents: pkg.priceCents,
      });
    } catch (error) {
      if (order) shopStore.markFailed(order.orderId, "failed", "preference_error");
      logger.error("[Shop] Falha ao criar preferência:", error.message);
      res.status(502).json({ ok: false, error: "Não foi possível iniciar o pagamento" });
    }
  });

  // ── Redirect estável para o checkout ──────────────────────────────────────
  // O init_point do MP é longo e muda; esse link curto é o que o jogo abre e o
  // que o usuário pode reabrir depois se fechou o app no meio.
  app.get("/shop/dc/pay/:orderId", (req, res) => {
    const order = shopStore.getOrder(req.params.orderId);

    if (!order || !order.initPoint) {
      return res.status(404).send("Pedido não encontrado.");
    }
    if (order.creditedAt) {
      return res.redirect(`${baseUrl}/shop/dc/return?order=${order.orderId}&r=success`);
    }
    if (order.expiresAt < nowSeconds()) {
      return res.status(410).send("Este link de pagamento expirou. Gere outro no jogo.");
    }

    res.redirect(302, order.initPoint);
  });

  // ── Página de retorno (back_urls) ─────────────────────────────────────────
  app.get("/shop/dc/return", (req, res) => {
    const r = req.query.r || "success";
    const msg =
      r === "success"
        ? { t: "Pagamento recebido!", d: "Volte ao jogo — seus DC Coin já estão sendo creditados." }
        : r === "pending"
          ? { t: "Pagamento pendente", d: "Assim que o pagamento for confirmado, os DC Coin entram automaticamente. Você já pode voltar ao jogo." }
          : { t: "Pagamento não concluído", d: "Nada foi cobrado. Você pode tentar novamente pelo jogo." };

    res.type("html").send(`<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${msg.t}</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#12141a;color:#f2f4f8;font-family:system-ui,-apple-system,sans-serif;padding:24px}
 .c{max-width:420px;text-align:center}
 h1{font-size:1.5rem;margin:0 0 12px}
 p{opacity:.75;line-height:1.55;margin:0 0 24px}
 a{display:inline-block;background:#e8b24a;color:#12141a;text-decoration:none;
   font-weight:600;padding:14px 28px;border-radius:10px}
</style></head><body><div class="c">
<h1>${msg.t}</h1><p>${msg.d}</p><a href="dcgame://shop/dc">Voltar ao jogo</a>
</div></body></html>`);
  });

  // ── Status do pedido (polling do cliente) ─────────────────────────────────
  app.get("/shop/dc/orders/:orderId", jwtAuth, async (req, res) => {
    const order = shopStore.getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }
    if (order.playerId !== req.playerId) {
      return res.status(403).json({ ok: false, error: "Pedido de outro jogador" });
    }

    // Rede de segurança: se o webhook não chegou (URL fora do ar, firewall,
    // retry ainda em fila), o próprio polling do cliente puxa o status do MP.
    // 'expired' entra aqui também: o link caducou, mas um Pix gerado antes
    // pode ter sido pago depois. Sem webhook, esta é uma das duas vias de
    // crédito (a outra é o job de reconciliação).
    if (!order.creditedAt && (order.status === "pending" || order.status === "expired")) {
      try {
        const payment = order.paymentId
          ? { id: order.paymentId }
          : await findPaymentByOrderId(order.orderId);

        if (payment?.id) {
          await processPayment(payment.id, { shopStore, logger, onCredited });
        }
      } catch (error) {
        logger.warn(`[Shop] Reconciliação falhou para ${order.orderId}: ${error.message}`);
      }
    }

    const fresh = shopStore.getOrder(req.params.orderId);

    res.json({
      ok: true,
      order: {
        orderId: fresh.orderId,
        packageId: fresh.packageId,
        status: fresh.status,
        credited: !!fresh.creditedAt,
        totalDC: fresh.amountDC + fresh.bonusDC,
        priceCents: fresh.priceCents,
        paymentMethod: fresh.paymentMethod,
        expiresAt: fresh.expiresAt,
        payUrl: fresh.initPoint ? `${baseUrl}/shop/dc/pay/${fresh.orderId}` : null,
      },
    });
  });

  // ── Pedidos pendentes (o jogo checa isso ao abrir a loja) ─────────────────
  app.get("/shop/dc/orders", jwtAuth, (req, res) => {
    const onlyPending = req.query.status === "pending";
    res.json({
      ok: true,
      orders: onlyPending
        ? shopStore.listPendingOrders(req.playerId)
        : shopStore.listPlayerOrders(req.playerId),
    });
  });

  // ── WEBHOOK ───────────────────────────────────────────────────────────────
  // Sempre responde 200 rápido (fora de assinatura inválida): erro faz o MP
  // reenviar, e reenvio é inofensivo porque o crédito é idempotente.
  app.post("/webhooks/mercadopago", async (req, res) => {
    if (!verifyWebhookSignature(req, logger)) {
      logger.warn("[Shop] Webhook com assinatura inválida — rejeitado");
      return res.status(401).json({ ok: false });
    }

    const type = req.body?.type || req.query.type || req.query.topic;
    const dataId = req.body?.data?.id || req.query["data.id"] || req.query.id;

    res.status(200).json({ ok: true }); // ACK imediato

    if (type !== "payment" || !dataId) {
      logger.debug(`[Shop] Webhook ignorado (type=${type})`);
      return;
    }

    try {
      await processPayment(dataId, { shopStore, logger, onCredited });
    } catch (error) {
      logger.error(`[Shop] Erro ao processar pagamento ${dataId}:`, error.message);
    }
  });

  logger.info("[Shop] Rotas de DC Coin registradas");
}

// ============================================================================
// JOB DE LIMPEZA
// ============================================================================

function iniciarJobsDaLoja({ shopStore, logger }) {
  const timer = setInterval(() => {
    const expired = shopStore.expireStaleOrders();
    if (expired > 0) logger.debug(`[Shop] ${expired} pedido(s) expirado(s)`);
  }, 300000);

  if (timer.unref) timer.unref();
}

module.exports = {
  ShopStore,
  registrarRotasLoja,
  iniciarJobsDaLoja,
  processPayment,
  findPaymentByOrderId,
  getPayment,
  DC_PACKAGES,
};