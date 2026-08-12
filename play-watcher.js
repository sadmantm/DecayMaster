"use strict";

/**
 * play-watcher.js
 *
 * Consulta periodicamente a Google Play Android Publisher API para descobrir
 * qual release está efetivamente publicado numa track (production por padrão).
 * Quando detecta uma versão nova e aprovada, atualiza:
 *
 *   - config.allowedClientBuilds   (append da nova, mantendo N anteriores)
 *   - config.latestClientBuild     (version + changelog vindos do release notes)
 *
 * Atualiza tanto o objeto `config` em memória (as rotas leem dele a cada
 * request, então o efeito é imediato) quanto o master.config.json em disco
 * (escrita atômica via tmp + rename), pra sobreviver a restart.
 *
 * Não escreve nada no Play. Só leitura.
 */

const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

class PlayWatcher {
  /**
   * @param {object}   deps
   * @param {object}   deps.config        objeto de config já carregado (mutado in-place)
   * @param {object}   deps.logger
   * @param {function} [deps.onNewVersion] callback(info) quando a versão muda
   */
  constructor({ config, logger, onNewVersion }) {
    this.config = config;
    this.logger = logger;
    this.onNewVersion = onNewVersion || (() => {});

    this.opts = config.playWatcher || {};
    this.timer = null;
    this.authClient = null;
    this.consecutiveErrors = 0;
    this.running = false;

    // telemetria pro console admin
    this.lastCheckAt = null;
    this.lastOkAt = null;
    this.lastError = null;
    this.lastSeenVersionCode = null;
  }

  // ===== AUTH =====

  async _getAuthClient() {
    if (this.authClient) return this.authClient;

    const keyFile = path.resolve(process.cwd(), this.opts.serviceAccountFile);
    if (!fs.existsSync(keyFile)) {
      throw new Error(`Service account não encontrada: ${keyFile}`);
    }

    const auth = new GoogleAuth({ keyFile, scopes: [SCOPE] });
    this.authClient = await auth.getClient();
    return this.authClient;
  }

  async _request(method, url) {
    const client = await this._getAuthClient();
    const res = await client.request({ url, method, timeout: 15000 });
    return res.data;
  }

  // ===== LEITURA DA TRACK =====

  /**
   * A Publisher API não expõe leitura de track fora de um "edit".
   * Então: cria edit -> lê track -> descarta edit. O edit é descartado
   * sempre (finally), pra não deixar rascunho pendurado no Play Console.
   */
  async fetchTrack() {
    const pkg = this.opts.packageName;
    const track = this.opts.track || "production";

    if (!pkg) throw new Error("playWatcher.packageName não configurado");

    let editId = null;
    try {
      const edit = await this._request("POST", `${API_BASE}/applications/${pkg}/edits`);
      editId = edit.id;
      return await this._request(
        "GET",
        `${API_BASE}/applications/${pkg}/edits/${editId}/tracks/${track}`,
      );
    } finally {
      if (editId) {
        try {
          await this._request("DELETE", `${API_BASE}/applications/${pkg}/edits/${editId}`);
        } catch (e) {
          this.logger.debug(`[Play] falha ao descartar edit ${editId}: ${e.message}`);
        }
      }
    }
  }

  /**
   * Escolhe o release que conta como "no ar".
   *
   * completed  -> 100% dos usuários, vale sempre.
   * inProgress -> rollout gradual; só vale se já passou de minUserFraction.
   * draft / halted -> ignorados de propósito (draft = ainda não aprovado,
   *                   halted = rollout pausado, provavelmente por bug).
   */
  _pickRelease(trackData) {
    const releases = Array.isArray(trackData?.releases) ? trackData.releases : [];
    const minFraction = this.opts.minUserFraction ?? 1.0;

    let best = null;

    for (const r of releases) {
      const fraction = typeof r.userFraction === "number" ? r.userFraction : 1;

      if (r.status === "completed") {
        // ok
      } else if (r.status === "inProgress" && fraction >= minFraction) {
        // ok
      } else {
        continue;
      }

      const codes = (r.versionCodes || []).map(Number).filter(Number.isFinite);
      if (codes.length === 0) continue;
      const versionCode = Math.max(...codes);

      if (!best || versionCode > best.versionCode) {
        best = {
          versionCode,
          name: r.name || null,
          status: r.status,
          userFraction: fraction,
          releaseNotes: r.releaseNotes || [],
        };
      }
    }

    return best;
  }

  /**
   * versionCode (42) -> versionName ("1.4.0").
   * A API só garante o versionCode; o versionName aparece no campo `name`,
   * que por padrão o Play preenche como "1.4.0 (42)". A regex extrai o
   * primeiro grupo x.y[.z]. Se seu fluxo usa nomes customizados de release,
   * preencha playWatcher.versionNameOverrides.
   */
  _resolveVersionName(release) {
    const overrides = this.opts.versionNameOverrides || {};
    const override = overrides[String(release.versionCode)];
    if (override) return override;
  
    // formato do Play: "{versionCode} ({versionName})"
    const match = String(release.name || "").match(/\(([^)]+)\)/);
    return match ? match[1].trim() : null;
  }

  _extractChangelog(release) {
    const lang = this.opts.changelogLanguage || "pt-BR";
  
    this.logger.debug(`[Play] releaseNotes bruto: ${JSON.stringify(release.releaseNotes)}`);
  
    const notes =
      release.releaseNotes.find((n) => n.language === lang) ||
      release.releaseNotes.find((n) => String(n.language).startsWith(lang.slice(0, 2))) ||
      release.releaseNotes[0];
  
    if (!notes || !notes.text) {
      this.logger.warn(`[Play] changelog não encontrado (releaseNotes=${release.releaseNotes?.length || 0} idiomas, lang configurado="${lang}")`);
      return null;
    }
  
    return String(notes.text)
      .split("\n")
      .map((l) => l.replace(/^[-•*]\s*/, "").trim())
      .filter((l) => l.length > 0);
  }
  // ===== APLICAÇÃO =====

  _applyVersion(versionName, release) {
    const keep = this.opts.keepPreviousBuilds ?? 2;
    const anterior = this.config.latestClientBuild.version;

    // remove duplicata e coloca a nova no fim (fim = mais recente)
    const lista = this.config.allowedClientBuilds.filter((v) => v !== versionName);
    lista.push(versionName);

    // mantém as `keep` anteriores + a nova
    const novaLista = lista.slice(-(keep + 1));
    const removidas = lista.filter((v) => !novaLista.includes(v));

    const changelog = this._extractChangelog(release);

    const novoLatest = {
      ...this.config.latestClientBuild,
      version: versionName,
      changelog: changelog || this.config.latestClientBuild.changelog,
    };

    // 1) memória — as rotas leem config.* a cada request, efeito é imediato
    this.config.allowedClientBuilds = novaLista;
    this.config.latestClientBuild = novoLatest;

    // 2) disco — relê o arquivo e só patcheia os dois campos, pra não
    //    persistir nada que tenha sido mutado em runtime por outra parte
    this._persist(novaLista, novoLatest);

    this.logger.info(
      `[Play] ⬆ Nova versão em produção: ${anterior} -> ${versionName} ` +
      `(versionCode ${release.versionCode}, status ${release.status})`,
    );
    this.logger.info(`[Play] allowedClientBuilds agora: ${novaLista.join(", ")}`);
    if (removidas.length > 0) {
      this.logger.warn(`[Play] builds bloqueadas a partir de agora: ${removidas.join(", ")}`);
    }

    try {
      this.onNewVersion({
        version: versionName,
        anterior,
        versionCode: release.versionCode,
        allowedClientBuilds: novaLista,
        latestClientBuild: novoLatest,
        removidas,
      });
    } catch (e) {
      this.logger.error("[Play] erro no callback onNewVersion:", e.message);
    }
  }

  _persist(allowedClientBuilds, latestClientBuild) {
    const configPath = path.join(process.cwd(), "master.config.json");
    const tmpPath = `${configPath}.tmp`;

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      raw.allowedClientBuilds = allowedClientBuilds;
      raw.latestClientBuild = latestClientBuild;

      // escrita atômica: se o processo morrer no meio, o config original
      // continua íntegro (rename é atômico no mesmo filesystem)
      fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2), "utf8");
      fs.renameSync(tmpPath, configPath);

      this.logger.info("[Play] master.config.json atualizado em disco");
    } catch (e) {
      this.logger.error(`[Play] FALHA ao persistir config: ${e.message}`);
      this.logger.error("[Play] a versão está aplicada em memória mas será perdida no restart");
      try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // ===== CICLO =====

  async check({ manual = false } = {}) {
    this.lastCheckAt = Math.floor(Date.now() / 1000);

    const trackData = await this.fetchTrack();
    const release = this._pickRelease(trackData);

    this.lastOkAt = this.lastCheckAt;
    this.lastError = null;

    if (!release) {
      const msg = "nenhum release publicado encontrado na track";
      this.logger.debug(`[Play] ${msg}`);
      return { changed: false, reason: msg };
    }

    this.lastSeenVersionCode = release.versionCode;

    const versionName = this._resolveVersionName(release);
    if (!versionName) {
      this.logger.warn(
        `[Play] não consegui extrair versionName do release "${release.name}" ` +
        `(versionCode ${release.versionCode}). ` +
        `Adicione em playWatcher.versionNameOverrides: {"${release.versionCode}": "x.y.z"}`,
      );
      return { changed: false, reason: "version_name_unresolved", release };
    }

    const jaAtual =
      this.config.latestClientBuild.version === versionName &&
      this.config.allowedClientBuilds.includes(versionName);

    if (jaAtual) {
      if (manual) this.logger.info(`[Play] já está atualizado (${versionName})`);
      return { changed: false, reason: "up_to_date", version: versionName };
    }

    this._applyVersion(versionName, release);
    return { changed: true, version: versionName, versionCode: release.versionCode };
  }

  start() {
    if (this.opts.enabled === false) {
      this.logger.info("[Play] watcher desabilitado por config");
      return;
    }
    if (this.running) return;
    this.running = true;

    const baseMs = Math.max(60, this.opts.intervalSeconds || 300) * 1000;

    const tick = async () => {
      try {
        await this.check();
        this.consecutiveErrors = 0;
      } catch (e) {
        this.consecutiveErrors++;
        this.lastError = e.message;

        const status = e.response?.status;
        if (status === 401 || status === 403) {
          this.logger.error(
            `[Play] ${status} — service account sem permissão no Play Console ` +
            `(ou permissão ainda propagando, leva até 24h na primeira vez)`,
          );
        } else {
          this.logger.error(`[Play] erro na verificação (#${this.consecutiveErrors}): ${e.message}`);
        }

        // token pode ter azedado; força renovação no próximo ciclo
        if (status === 401) this.authClient = null;
      }

      // backoff exponencial em cima de erro, teto de 16x, + jitter
      const factor = Math.pow(2, Math.min(this.consecutiveErrors, 4));
      const delay = baseMs * factor + Math.floor(Math.random() * 15000);

      this.timer = setTimeout(tick, delay);
      if (this.timer.unref) this.timer.unref();
    };

    // 10s de atraso inicial pra não competir com o boot
    this.timer = setTimeout(tick, 10000);
    if (this.timer.unref) this.timer.unref();

    this.logger.info(
      `[Play] watcher iniciado: ${this.opts.packageName} / track ${this.opts.track || "production"} ` +
      `a cada ${baseMs / 1000}s`,
    );
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }

  status() {
    return {
      enabled: this.opts.enabled !== false,
      running: this.running,
      packageName: this.opts.packageName,
      track: this.opts.track || "production",
      intervalSeconds: this.opts.intervalSeconds || 300,
      currentVersion: this.config.latestClientBuild.version,
      allowedClientBuilds: this.config.allowedClientBuilds,
      lastSeenVersionCode: this.lastSeenVersionCode,
      lastCheckAt: this.lastCheckAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

module.exports = { PlayWatcher };
