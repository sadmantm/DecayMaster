const Database = require("better-sqlite3");
const db = new Database("./data/accounts.db");

// Forçar sincronização dos dados do WAL para o arquivo principal
db.pragma("wal_checkpoint(TRUNCATE)");

console.log("✓ Checkpoint realizado! Os dados foram sincronizados.");

db.close();
