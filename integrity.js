// integrity.js — verificação do Play Integrity (classic request) no master
const crypto = require("crypto");
const { GoogleAuth } = require("google-auth-library");

const API = "https://playintegrity.googleapis.com/v1";

class IntegrityService {
  constructor(config, logger) {
    const c = config.integrity || {};
    this.logger = logger;
    this.modo = ["off", "log", "enforce"].includes(c.mode) ? c.mode : "log";
    this.packageName = c.packageName || null;
    this.nivelDispositivo = c.deviceLevel || "MEETS_DEVICE_INTEGRITY";
    this.exigirLicenca = c.requireLicensed === true;
    this.recallHabilitado = c.deviceRecall === true;
    this.recallValidadeMeses = c.recallValidityMonths ?? 24;
    this.plataformasIsentas = (c.exemptPlatforms || []).map((p) => String(p).toLowerCase());
    this.nonceTtlMs = (c.nonceTtlSeconds ?? 300) * 1000;
    this._nonces = new Map(); // nonce -> expiraEm (ms)

    if (this.modo !== "off" && !this.packageName) {
      throw new Error("integrity.packageName é obrigatório quando integrity.mode != 'off'");
    }

    this.auth = new GoogleAuth({
      keyFile: c.serviceAccountFile || undefined,
      scopes: ["https://www.googleapis.com/auth/playintegrity"],
    });

    setInterval(() => this._limparNonces(), 60_000).unref();
  }

  /** Integridade é obrigatória para esta plataforma? (plataforma vem do cliente: isentar = brecha) */
  exige(platform) {
    return this.modo === "enforce"
      && !this.plataformasIsentas.includes(String(platform || "").toLowerCase());
  }

  criarNonce() {
    if (this._nonces.size > 50_000) this._limparNonces();
    const nonce = crypto.randomBytes(32).toString("base64url"); // URL-safe, sem padding
    this._nonces.set(nonce, Date.now() + this.nonceTtlMs);
    return nonce;
  }

  _consumirNonce(nonce) {
    const exp = this._nonces.get(nonce);
    if (!exp) return false;
    this._nonces.delete(nonce); // uso único: impede replay de token capturado
    return Date.now() <= exp;
  }

  _limparNonces() {
    const agora = Date.now();
    for (const [n, exp] of this._nonces) if (exp < agora) this._nonces.delete(n);
  }

  async _post(url, data) {
    const client = await this.auth.getClient();
    const r = await client.request({ url, method: "POST", data, timeout: 8000 });
    return r.data;
  }

  _mesesDesde(yyyymm) {
    const v = Number(yyyymm);
    if (!v) return Infinity;
    const ano = Math.floor(v / 100), mes = v % 100;
    const d = new Date();
    return (d.getUTCFullYear() - ano) * 12 + (d.getUTCMonth() + 1 - mes);
  }

  /**
   * Decodifica e avalia o token enviado no login.
   * Retorna { ok, avaliado, motivos[], recallBanido, erroInfra, token }.
   */
  async verificarRequisicao(body) {
    const base = { ok: false, avaliado: false, motivos: [], recallBanido: false, erroInfra: false, token: null };
    if (this.modo === "off") return { ...base, ok: true };

    const token = typeof body?.integrityToken === "string" ? body.integrityToken : null;
    const nonce = typeof body?.integrityNonce === "string" ? body.integrityNonce : null;

    if (!token || !nonce) return { ...base, motivos: ["SEM_TOKEN"] };
    if (token.length > 20000) return { ...base, motivos: ["TOKEN_INVALIDO"] };
    if (!this._consumirNonce(nonce)) return { ...base, motivos: ["NONCE_INVALIDO"] };

    let p;
    try {
      const data = await this._post(
        `${API}/${encodeURIComponent(this.packageName)}:decodeIntegrityToken`,
        { integrity_token: token },
      );
      p = data?.tokenPayloadExternal;
    } catch (e) {
      const status = e?.response?.status;
      // 400 = token forjado/corrompido. 401/403/5xx/timeout = problema NOSSO ou do Google.
      if (status === 400) return { ...base, motivos: ["TOKEN_REJEITADO"] };
      this.logger.warn(`[Integrity] decode falhou (${status || "rede"}): ${e.message}`);
      return { ...base, motivos: ["GOOGLE_INDISPONIVEL"], erroInfra: true };
    }

    if (!p) return { ...base, motivos: ["PAYLOAD_VAZIO"] };

    const motivos = [];
    const rd = p.requestDetails || {};
    if (rd.requestPackageName !== this.packageName) motivos.push("PACOTE_ERRADO");
    if (rd.nonce !== nonce) motivos.push("NONCE_DIVERGENTE");

    const ts = Number(rd.timestampMillis);
    if (!ts || Math.abs(Date.now() - ts) > 5 * 60 * 1000) motivos.push("TOKEN_VELHO");

    const appVerdict = p.appIntegrity?.appRecognitionVerdict;
    if (appVerdict !== "PLAY_RECOGNIZED") motivos.push(`APP_${appVerdict || "SEM_VEREDITO"}`);

    const dev = p.deviceIntegrity || {};
    const veredDev = dev.deviceRecognitionVerdict || [];
    if (!veredDev.includes(this.nivelDispositivo)) motivos.push("DISPOSITIVO_NAO_CONFIAVEL");

    const lic = p.accountDetails?.appLicensingVerdict;
    if (this.exigirLicenca && lic !== "LICENSED") motivos.push(`LICENCA_${lic || "SEM_VEREDITO"}`);

    // bitFirst = "aparelho banido por cheat". Ignora marcações muito antigas
    // (aparelho pode ter sido revendido).
    const rv = dev.deviceRecall?.values || {};
    const rw = dev.deviceRecall?.writeDates || {};
    const recallBanido = rv.bitFirst === true
      && this._mesesDesde(rw.yyyymmFirst) <= this.recallValidadeMeses;

    return {
      ok: motivos.length === 0,
      avaliado: true,
      motivos,
      recallBanido,
      erroInfra: false,
      token,
    };
  }

  /** Grava bits no aparelho dono do token (token verificado há menos de 14 dias). */
  async escreverRecall(token, valores) {
    if (!this.recallHabilitado || !token) return false;
    try {
      await this._post(
        `${API}/${encodeURIComponent(this.packageName)}/deviceRecall:write`,
        { integrityToken: token, newValues: valores },
      );
      return true;
    } catch (e) {
      this.logger.warn(`[Integrity] deviceRecall:write falhou (${e?.response?.status || "rede"}): ${e.message}`);
      return false;
    }
  }
}

module.exports = { IntegrityService };