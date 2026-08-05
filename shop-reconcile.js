// ============================================================================
// shop-reconcile.js — Reconciliação de pedidos DC Coin
//
// Consulta o Mercado Pago periodicamente e credita pedidos pagos, SEM depender
// de webhook. É o caminho principal quando o master não tem HTTPS.
//
// Uso no server.js:
//
//   const { iniciarReconciliacao, reconcileOrderNow } = require("./shop-reconcile");
//   ...
//   iniciarReconciliacao({ shopStore, logger, onCredited });
//
// Requer que shop-dc.js exporte findPaymentByOrderId (ver instruções).
// ============================================================================

const { processPayment, findPaymentByOrderId } = require("./shop-dc");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Quanto tempo depois da criação a gente ainda tenta reconciliar um pedido.
// 72h cobre Pix pago no dia seguinte, boleto, e fim de semana.
const RECONCILE_WINDOW_SECONDS = 72 * 60 * 60;

// Quantos pedidos consultamos por ciclo. Segura a mão na API do MP:
// cada pedido é 1 ou 2 requests, e o rate limit deles não é generoso.
const BATCH_SIZE = 15;

// Pausa entre consultas dentro do mesmo ciclo.
const DELAY_BETWEEN_CHECKS_MS = 250;

const TICK_INTERVAL_MS = 60000;

/**
 * Backoff por idade do pedido. Pedido novo tem chance alta de estar sendo pago
 * agora; pedido de ontem quase certamente não vai mudar mais.
 * @returns {number} intervalo mínimo entre checagens, em segundos
 */
function intervalForAge(ageSeconds) {
  if (ageSeconds < 3600) return 60;          // 1ª hora:    a cada 1 min
  if (ageSeconds < 6 * 3600) return 300;     // até 6h:     a cada 5 min
  if (ageSeconds < 24 * 3600) return 1800;   // até 24h:    a cada 30 min
  return 7200;                               // até 72h:    a cada 2h
}

// ============================================================================
// MIGRAÇÃO — colunas de controle do job
// ============================================================================

function ensureColumns(db, logger) {
  const cols = db.prepare(`PRAGMA table_info(dc_orders)`).all().map((c) => c.name);

  if (!cols.includes("lastCheckedAt")) {
    db.exec(`ALTER TABLE dc_orders ADD COLUMN lastCheckedAt INTEGER`);
    logger.info("[Reconcile] Coluna lastCheckedAt adicionada");
  }
  if (!cols.includes("checkCount")) {
    db.exec(`ALTER TABLE dc_orders ADD COLUMN checkCount INTEGER NOT NULL DEFAULT 0`);
    logger.info("[Reconcile] Coluna checkCount adicionada");
  }
}

// ============================================================================
// SELEÇÃO DE CANDIDATOS
// ============================================================================

/**
 * Pedidos que ainda podem virar crédito.
 *
 * Inclui 'expired' de propósito: 'expired' significa que o LINK de checkout
 * caducou, não que o pagamento não pode chegar. Um Pix gerado no minuto 29
 * costuma ter validade própria de horas — e sem webhook, esse pedido só é
 * creditado se a gente continuar olhando.
 *
 * 'review' fica de fora: ali houve divergência de valor/estorno e o crédito
 * é decisão humana.
 */
function selectCandidates(db) {
  const now = nowSeconds();

  const rows = db
    .prepare(
      `SELECT orderId, playerId, paymentId, createdAt, status, checkCount, lastCheckedAt
       FROM dc_orders
       WHERE creditedAt IS NULL
         AND status IN ('pending', 'expired')
         AND createdAt > ?
       ORDER BY createdAt DESC`,
    )
    .all(now - RECONCILE_WINDOW_SECONDS);

  const due = [];

  for (const row of rows) {
    const age = now - row.createdAt;
    const since = row.lastCheckedAt ? now - row.lastCheckedAt : Infinity;

    if (since >= intervalForAge(age)) due.push(row);
    if (due.length >= BATCH_SIZE) break;
  }

  return due;
}

function markChecked(db, orderId) {
  db.prepare(
    `UPDATE dc_orders
     SET lastCheckedAt = ?, checkCount = checkCount + 1
     WHERE orderId = ?`,
  ).run(nowSeconds(), orderId);
}

// ============================================================================
// RECONCILIAÇÃO DE UM PEDIDO
// ============================================================================

async function reconcileOne(order, { shopStore, logger, onCredited }) {
  // Se já sabemos o paymentId (o pedido passou por 'pending' com Pix gerado),
  // consultamos direto. Senão, procuramos pelo external_reference.
  let paymentId = order.paymentId;

  if (!paymentId) {
    const payment = await findPaymentByOrderId(order.orderId);
    if (!payment) return { checked: true, found: false };
    paymentId = payment.id;
  }

  const result = await processPayment(paymentId, { shopStore, logger, onCredited });
  return { checked: true, found: true, ...result };
}

/**
 * Reconcilia um pedido específico sob demanda.
 * Útil no console de admin: quando um jogador abre ticket dizendo que pagou.
 */
async function reconcileOrderNow(orderId, { shopStore, logger, onCredited }) {
  const order = shopStore.getOrder(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  if (order.creditedAt) return { ok: true, alreadyCredited: true };

  try {
    const result = await reconcileOne(order, { shopStore, logger, onCredited });
    markChecked(shopStore.db, orderId);
    return { ok: true, ...result };
  } catch (error) {
    logger.error(`[Reconcile] Falha em ${orderId}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// CICLO PRINCIPAL
// ============================================================================

let running = false;

async function tick({ shopStore, logger, onCredited }) {
  // Guard de reentrância: se um ciclo demorou mais que o intervalo (MP lento,
  // rede ruim), o próximo é descartado em vez de empilhar consultas.
  if (running) {
    logger.debug("[Reconcile] Ciclo anterior ainda rodando — pulando");
    return;
  }

  running = true;

  try {
    const candidates = selectCandidates(shopStore.db);
    if (candidates.length === 0) return;

    logger.debug(`[Reconcile] Verificando ${candidates.length} pedido(s)`);

    let credited = 0;

    for (const order of candidates) {
      try {
        const result = await reconcileOne(order, { shopStore, logger, onCredited });
        if (result.credited) credited++;
      } catch (error) {
        // Um pedido problemático não pode derrubar o ciclo inteiro.
        // 404 do MP = pagamento nunca foi criado (usuário abriu e desistiu).
        if (error.status === 404) {
          logger.debug(`[Reconcile] Pagamento inexistente para ${order.orderId}`);
        } else {
          logger.warn(`[Reconcile] Erro em ${order.orderId}: ${error.message}`);
        }
      } finally {
        // Marca mesmo em erro, senão um pedido quebrado é reconsultado
        // a cada ciclo pra sempre.
        markChecked(shopStore.db, order.orderId);
      }

      if (DELAY_BETWEEN_CHECKS_MS > 0) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_CHECKS_MS));
      }
    }

    if (credited > 0) {
      logger.info(`[Reconcile] ✓ ${credited} pedido(s) creditado(s) neste ciclo`);
    }
  } catch (error) {
    logger.error("[Reconcile] Erro no ciclo:", error.message);
  } finally {
    running = false;
  }
}

function iniciarReconciliacao({ shopStore, logger, onCredited }) {
  ensureColumns(shopStore.db, logger);

  // Primeiro ciclo com atraso curto: pega pedidos que ficaram pendentes
  // enquanto o master estava desligado.
  const kickoff = setTimeout(() => tick({ shopStore, logger, onCredited }), 5000);
  if (kickoff.unref) kickoff.unref();

  const timer = setInterval(() => tick({ shopStore, logger, onCredited }), TICK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  logger.info(
    `[Reconcile] Job iniciado (ciclo ${TICK_INTERVAL_MS / 1000}s, janela ${RECONCILE_WINDOW_SECONDS / 3600}h)`,
  );

  return timer;
}

// ============================================================================
// RELATÓRIO — para o console de admin
// ============================================================================

function relatorioPedidos(shopStore, hours = 24) {
  const since = nowSeconds() - hours * 3600;

  const rows = shopStore.db
    .prepare(
      `SELECT status, COUNT(*) AS total, SUM(priceCents) AS cents
       FROM dc_orders WHERE createdAt > ? GROUP BY status`,
    )
    .all(since);

  const stuck = shopStore.db
    .prepare(
      `SELECT orderId, playerId, packageId, status, checkCount, createdAt
       FROM dc_orders
       WHERE creditedAt IS NULL AND status IN ('review', 'expired') AND createdAt > ?
       ORDER BY createdAt DESC LIMIT 20`,
    )
    .all(since);

  return { rows, stuck, hours };
}

module.exports = {
  iniciarReconciliacao,
  reconcileOrderNow,
  relatorioPedidos,
};