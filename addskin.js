#!/usr/bin/env node

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Cores para output no terminal
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function log(color, ...args) {
  console.log(color + args.join(" ") + colors.reset);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function showUsage() {
  console.log(`
${colors.bright}Uso:${colors.reset}
  node add-skin.js <playerId> <skinId> <category> [expiresInDays]

${colors.bright}Parâmetros:${colors.reset}
  playerId        - ID do jogador (número de 8 dígitos)
  skinId          - ID da skin (string)
  category        - Categoria da skin: weapon, character, ou world
  expiresInDays   - (Opcional) Dias até expirar. Se não informado, skin permanente

${colors.bright}Exemplos:${colors.reset}
  ${colors.cyan}# Adicionar skin permanente${colors.reset}
  node add-skin.js 12345678 golden_ak47 weapon

  ${colors.cyan}# Adicionar skin temporária (7 dias)${colors.reset}
  node add-skin.js 12345678 vip_character character 7

  ${colors.cyan}# Adicionar skin de mundo (30 dias)${colors.reset}
  node add-skin.js 12345678 desert_map world 30
`);
}

function validateCategory(category) {
  const validCategories = ["weapon", "character", "world"];
  return validCategories.includes(category);
}

function addSkin(playerId, skinId, category, expiresInDays) {
  const dbDir = path.join(process.cwd(), "data");
  const dbPath = path.join(dbDir, "accounts.db");

  if (!fs.existsSync(dbPath)) {
    log(colors.red, "❌ Erro: Banco de dados não encontrado em", dbPath);
    log(
      colors.yellow,
      "   Certifique-se de executar este script na pasta raiz do servidor.",
    );
    process.exit(1);
  }

  const db = new Database(dbPath);

  try {
    // Verificar se o jogador existe
    const player = db
      .prepare(
        "SELECT playerId, playerName, accountType FROM accounts WHERE playerId = ?",
      )
      .get(playerId);

    if (!player) {
      log(colors.red, `❌ Erro: Jogador com ID ${playerId} não encontrado.`);
      process.exit(1);
    }

    log(colors.cyan, "\n📋 Informações do Jogador:");
    log(colors.reset, `   ID: ${player.playerId}`);
    log(colors.reset, `   Nome: ${player.playerName || "(sem nome definido)"}`);
    log(colors.reset, `   Tipo: ${player.accountType}`);

    // Verificar se a skin já existe
    const existingSkin = db
      .prepare(
        "SELECT id, expiresAt FROM skins WHERE playerId = ? AND skinId = ? AND category = ?",
      )
      .get(playerId, skinId, category);

    if (existingSkin) {
      log(colors.yellow, `\n⚠️  Atenção: Jogador já possui essa skin!`);
      if (existingSkin.expiresAt) {
        const expiryDate = new Date(existingSkin.expiresAt * 1000);
        log(colors.yellow, `   Expira em: ${expiryDate.toLocaleString()}`);
      } else {
        log(colors.yellow, `   Skin permanente`);
      }

      const readline = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      readline.question("\nDeseja atualizar a skin? (s/n): ", (answer) => {
        if (answer.toLowerCase() === "s") {
          // Calcular nova data de expiração
          let expiresAt = null;
          if (expiresInDays) {
            expiresAt = nowSeconds() + expiresInDays * 86400;
          }

          db.prepare("UPDATE skins SET expiresAt = ? WHERE id = ?").run(
            expiresAt,
            existingSkin.id,
          );

          log(colors.green, "\n✅ Skin atualizada com sucesso!");
          if (expiresAt) {
            const expiryDate = new Date(expiresAt * 1000);
            log(
              colors.green,
              `   Nova expiração: ${expiryDate.toLocaleString()}`,
            );
          } else {
            log(colors.green, `   Agora é permanente`);
          }
        } else {
          log(colors.yellow, "\n❌ Operação cancelada.");
        }
        readline.close();
        db.close();
      });
      return;
    }

    // Adicionar nova skin
    let expiresAt = null;
    if (expiresInDays) {
      expiresAt = nowSeconds() + expiresInDays * 86400;
    }

    const result = db
      .prepare(
        "INSERT INTO skins (playerId, skinId, category, expiresAt) VALUES (?, ?, ?, ?)",
      )
      .run(playerId, skinId, category, expiresAt);

    log(colors.green, "\n✅ Skin adicionada com sucesso!");
    log(colors.reset, `   Skin ID: ${skinId}`);
    log(colors.reset, `   Categoria: ${category}`);

    if (expiresAt) {
      const expiryDate = new Date(expiresAt * 1000);
      log(colors.reset, `   Expira em: ${expiryDate.toLocaleString()}`);
      log(colors.reset, `   Dias restantes: ${expiresInDays}`);
    } else {
      log(colors.reset, `   Tipo: Permanente`);
    }

    // Mostrar todas as skins do jogador
    const allSkins = db
      .prepare(
        "SELECT skinId, category, expiresAt FROM skins WHERE playerId = ?",
      )
      .all(playerId);

    log(colors.cyan, `\n📦 Total de skins do jogador: ${allSkins.length}`);
    allSkins.forEach((skin, index) => {
      const expiry = skin.expiresAt
        ? new Date(skin.expiresAt * 1000).toLocaleDateString()
        : "Permanente";
      log(
        colors.reset,
        `   ${index + 1}. ${skin.skinId} (${skin.category}) - ${expiry}`,
      );
    });
  } catch (error) {
    log(colors.red, "\n❌ Erro ao adicionar skin:", error.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Parse argumentos
const args = process.argv.slice(2);

if (args.length < 3 || args[0] === "--help" || args[0] === "-h") {
  showUsage();
  process.exit(0);
}

const playerId = parseInt(args[0]);
const skinId = args[1];
const category = args[2];
const expiresInDays = args[3] ? parseInt(args[3]) : null;

// Validações
if (isNaN(playerId) || playerId < 10000000 || playerId > 99999999) {
  log(colors.red, "❌ Erro: playerId deve ser um número de 8 dígitos.");
  process.exit(1);
}

if (!skinId || skinId.length < 3) {
  log(colors.red, "❌ Erro: skinId deve ter pelo menos 3 caracteres.");
  process.exit(1);
}

if (!validateCategory(category)) {
  log(
    colors.red,
    "❌ Erro: category deve ser 'weapon', 'character' ou 'world'.",
  );
  process.exit(1);
}

if (expiresInDays !== null && (isNaN(expiresInDays) || expiresInDays < 1)) {
  log(colors.red, "❌ Erro: expiresInDays deve ser um número positivo.");
  process.exit(1);
}

// Executar
addSkin(playerId, skinId, category, expiresInDays);
