const crypto = require("crypto");

// ===== UTILITY FUNCTIONS =====

function generateGuid() {
  return crypto.randomUUID();
}

function generateJoinToken() {
  return crypto.randomBytes(32).toString("hex");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function validateRequired(fields, data) {
  const missing = fields.filter(
    (f) => data[f] === undefined || data[f] === null,
  );
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(", ")}`;
  }
  return null;
}

function validateTypes(typeMap, data) {
  for (const [field, expectedType] of Object.entries(typeMap)) {
    if (data[field] !== undefined && typeof data[field] !== expectedType) {
      return `Field '${field}' must be a ${expectedType}`;
    }
  }
  return null;
}

// ===== LOGGER =====

class Logger {
  constructor(level) {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.currentLevel = this.levels[level] || this.levels.info;
  }

  debug(...args) {
    if (this.currentLevel <= this.levels.debug) {
      console.log("[DEBUG]", ...args);
    }
  }

  info(...args) {
    if (this.currentLevel <= this.levels.info) {
      console.log("[INFO]", ...args);
    }
  }

  warn(...args) {
    if (this.currentLevel <= this.levels.warn) {
      console.warn("[WARN]", ...args);
    }
  }

  error(...args) {
    if (this.currentLevel <= this.levels.error) {
      console.error("[ERROR]", ...args);
    }
  }
}

// ===== CONFIG LOADER =====

function loadConfig() {
  const fs = require("fs");
  const path = require("path");

  const configPath = path.join(process.cwd(), "master.config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  let config;
  try {
    const configData = fs.readFileSync(configPath, "utf8");
    config = JSON.parse(configData);
  } catch (error) {
    throw new Error(`Failed to parse configuration file: ${error.message}`);
  }

  const required = [
    "serverName",
    "host",
    "port",
    "publicBaseUrl",
    "tokenTTLSeconds",
    "heartbeatTTLSeconds",
    "rateLimit",
    "allowedClientBuilds",
    "latestClientBuild",
    "logLevel",
    "serverKey",
  ];
  
  for (const field of required) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`Missing required configuration field: ${field}`);
    }
  }
  
  if (!config.rateLimit.windowSeconds || !config.rateLimit.maxRequests) {
    throw new Error("rateLimit must have windowSeconds and maxRequests");
  }
  
  if (
    !config.latestClientBuild.version ||
    typeof config.latestClientBuild.sizeMB !== "number" ||
    !Array.isArray(config.latestClientBuild.changelog)
  ) {
    throw new Error(
      "latestClientBuild must have version (string), sizeMB (number), and changelog (array)",
    );
  }

  if (typeof config.tokenTTLSeconds !== "number") {
    throw new Error("tokenTTLSeconds must be a number");
  }
  if (typeof config.heartbeatTTLSeconds !== "number") {
    throw new Error("heartbeatTTLSeconds must be a number");
  }
  if (!Array.isArray(config.allowedClientBuilds)) {
    throw new Error("allowedClientBuilds must be an array");
  }
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
    throw new Error("logLevel must be one of: debug, info, warn, error");
  }

  return config;
}

// ===== MIDDLEWARE =====

function serverAuthMiddleware(config, logger) {
  return (req, res, next) => {
    const providedKey = req.headers["x-server-key"];

    if (!providedKey) {
      logger.warn("Server auth failed: missing X-Server-Key header");
      return res.status(401).json({
        ok: false,
        error: "Missing X-Server-Key header",
      });
    }

    if (providedKey !== config.serverKey) {
      logger.warn("Server auth failed: invalid X-Server-Key");
      return res.status(401).json({
        ok: false,
        error: "Invalid server key",
      });
    }

    next();
  };
}

// ===== RATE LIMITER =====

class RateLimiter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.requests = new Map();
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const now = nowSeconds();
      const windowStart = now - this.config.rateLimit.windowSeconds;

      let history = this.requests.get(ip) || [];
      const validRequests = history.filter((ts) => ts > windowStart);
      this.requests.set(ip, validRequests);

      if (validRequests.length >= this.config.rateLimit.maxRequests) {
        this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
        return res.status(429).json({
          ok: false,
          error: "Rate limit exceeded",
          details: `Max ${this.config.rateLimit.maxRequests} requests per ${this.config.rateLimit.windowSeconds} seconds`,
        });
      }

      validRequests.push(now);
      this.requests.set(ip, validRequests);
      next();
    };
  }

  cleanup() {
    const now = nowSeconds();
    const windowStart = now - this.config.rateLimit.windowSeconds;
    let cleaned = 0;

    for (const [ip, history] of this.requests.entries()) {
      const validRequests = history.filter((ts) => ts > windowStart);
      if (validRequests.length === 0) {
        this.requests.delete(ip);
        cleaned++;
      } else {
        this.requests.set(ip, validRequests);
      }
    }

    return cleaned;
  }
}

module.exports = {
  generateGuid,
  generateJoinToken,
  nowSeconds,
  validateRequired,
  validateTypes,
  Logger,
  loadConfig,
  serverAuthMiddleware,
  RateLimiter,
};
