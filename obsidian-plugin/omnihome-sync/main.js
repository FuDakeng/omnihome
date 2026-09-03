'use strict';

/* ============================================================
   OmniHome Sync · 万事屋 ↔ Obsidian 双向同步插件（纯 JS / CommonJS）
   无需构建：BRAT 侧载，或整目录复制到 <vault>/.obsidian/plugins/omnihome-sync/。

   同步语义与门户浏览器版「本地文件夹同步」(localsync.js) 一致：
     · 路径 = 文件夹/标题.md（服务端逻辑寻址，笔记仍存数据库，不落物理镜像）
     · LWW：最后修改时间优先，2 秒同刻窗口内站点优先
     · 删除安全阀：单轮计划删除 > 10 个则暂停并弹确认
     · 30 秒聚合通知，不频繁打扰
     · 仅同步普通笔记（不含常驻笔记 / 每日计划 / 灵感速记，服务端已过滤）
   ============================================================ */

const obsidian = require('obsidian');
const {
  Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, requestUrl,
} = obsidian;

const DELETE_VALVE = 10;            // 单轮删除安全阀阈值
const DEBOUNCE_MS = 800;            // 本地事件防抖
const NOTIFY_THROTTLE_MS = 30000;   // 变更通知聚合窗口
const ERR_THROTTLE_MS = 60000;      // 错误通知节流（轮询失败不刷屏）
const LWW_WINDOW_MS = 2000;         // LWW 同刻窗口（站点优先）
const LOCAL_STABLE_MS = 1000;       // 本地文件“已变更”判定容差
const SELF_WRITE_MS = 4000;         // 自写抑制窗口（避免回环触发）

/* 插件独立版本线（与服务端 app 版本解耦；须与 manifest.json 的 version 保持一致）。
   打进启动日志与设置页，用户反馈报错时可一眼确认所装插件版本。 */
const PLUGIN_VERSION = '0.0.1';

const DEFAULT_SETTINGS = {
  serverUrl: '',
  apiKey: '',
  enabled: false,
  pollSeconds: 8,
  // baseline: path -> { lm: 本地上次同步 mtime(ms), rm: 远端上次同步 mtime(ms) }
  baseline: {},
};

/* ---------- 工具 ---------- */
function isHiddenPath(p) {
  return String(p || '').split('/').some(function (seg) { return seg.startsWith('.'); });
}
function parentDir(p) {
  const i = String(p).lastIndexOf('/');
  return i > 0 ? String(p).slice(0, i) : '';
}
function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- base64 ↔ UTF-8 文本 ----------
   同步正文一律经 base64 传输：笔记常含 <script>/<svg>/<?xml/iframe 等片段，明文放进 JSON
   会被中间「内容安全网关 / WAF / 反代」当成 XSS 攻击特征，从而篡改（甚至 hex 化）响应体，
   导致客户端 JSON.parse 在正文中途崩坏（实测 position 3581 处字面 <svg 被换成十六进制串）。
   base64 后载荷只剩 [A-Za-z0-9+/=]，对内容过滤完全透明，彻底规避。
   用 TextEncoder/TextDecoder + btoa/atob 实现，桌面(Electron)与移动端(Capacitor)均可用。 */
function b64encode(str) {
  const bytes = new TextEncoder().encode(String(str == null ? '' : str));
  let bin = '';
  const CH = 0x8000;                       // 分块 apply，避免超长参数栈溢出
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
/* 从 GET /api/sync/file 响应取正文：优先 contentB64（新服务端），回退 content（旧服务端）。
   两者皆无返回 null —— 服务端与插件版本不匹配，调用方应报错而非写入空正文（否则会清空本地笔记）。 */
function decodeSyncContent(data) {
  if (data && typeof data.contentB64 === 'string') return b64decode(data.contentB64);
  if (data && typeof data.content === 'string') return data.content;
  return null;
}

/* 把响应 JSON 解析失败转成「可定位」错误：服务端由 FastAPI 生成，JSON 必然合法，
   一旦解析失败几乎都是响应字节在传输链路被中间设备（内容安全网关 / WAF / 反代）篡改：
   明文正文里的 <script>/<svg>/<?xml 等被当成攻击特征改写或 hex 化，令 JSON 在中途崩坏。
   （v0.0.1 起正文改走 base64 已规避此问题；保留诊断以备其它传输异常。）
   截取出错位置上下文 + 完整响应头，便于判定是篡改还是截断。 */
function diagnoseJsonError(e, text, resp, method, urlPath) {
  const msg = (e && e.message) || String(e);
  const m = /position (\d+)/.exec(msg);
  const pos = m ? parseInt(m[1], 10) : -1;
  const h = (resp && resp.headers) || {};
  let hdump = '';
  try { hdump = JSON.stringify(h); } catch (e2) { hdump = String(h); }
  let where = '';
  if (pos >= 0 && text) {
    const a = Math.max(0, pos - 24);
    const b = Math.min(text.length, pos + 24);
    where = '｜出错处 …' + text.slice(a, pos) + '【' + (text.charAt(pos) || 'EOF') + '】' +
      text.slice(pos + 1, b) + '…';
  }
  return new Error('服务端响应非法 JSON（' + method + ' ' + urlPath + '）：' + msg +
    '｜status=' + (resp && resp.status) +
    ' 收到长度=' + (text ? text.length : 0) +
    ' 响应头=' + String(hdump).slice(0, 300) + where);
}

/* ---------- 确认弹窗（Obsidian 无内置 confirm，返回 Promise<bool>） ---------- */
class ConfirmModal extends Modal {
  constructor(app, opts, resolve) {
    super(app);
    this.opts = opts || {};
    this._resolve = resolve;
    this._done = false;
  }
  onOpen() {
    const o = this.opts;
    this.titleEl.setText(o.title || '请确认');
    if (o.sub) this.contentEl.createEl('p', { text: o.sub, cls: 'omnihome-sync-confirm-sub' });
    const row = this.contentEl.createDiv({ cls: 'omnihome-sync-confirm-row' });
    const cancel = row.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this._finish(false));
    const ok = row.createEl('button', { text: o.okText || '确定', cls: o.danger ? 'mod-warning' : 'mod-cta' });
    ok.addEventListener('click', () => this._finish(true));
  }
  onClose() { this.contentEl.empty(); this._finish(false); }
  _finish(v) { if (this._done) return; this._done = true; this._resolve(v); this.close(); }
}
function confirmDialog(app, opts) {
  return new Promise(function (resolve) { new ConfirmModal(app, opts, resolve).open(); });
}

/* ============================================================
   插件主体
   ============================================================ */
class OmniHomeSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.selfWrites = {};
    this.syncing = false;
    this._pending = 0;
    this._lastNotify = 0;
    this._lastErrNotify = 0;
    this.lastError = '';

    this.statusBar = this.addStatusBarItem();
    this.setStatus(this.canSync() ? 'idle' : 'off');

    // 启动即打印插件版本：用户反馈报错时可一眼确认所装版本（manifest 为准，常量兜底）
    console.log('[OmniHome Sync] 插件版本 v' + ((this.manifest && this.manifest.version) || PLUGIN_VERSION) +
      '（正文 base64 传输）已加载');

    this.addRibbonIcon('sync', 'OmniHome Sync：立即同步', () => this.manualSync());
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => this.manualSync() });
    this.addCommand({ id: 'toggle-sync', name: '暂停 / 恢复同步', callback: () => this.toggleSync() });

    this.addSettingTab(new OmniHomeSyncSettingTab(this.app, this));

    // 本地仓库事件：修改 / 新建 / 删除 -> 防抖对账；重命名 -> 走服务端 rename 保持笔记身份
    this.registerEvent(this.app.vault.on('modify', (f) => this.onLocalChange(f, 'modify')));
    this.registerEvent(this.app.vault.on('create', (f) => this.onLocalChange(f, 'create')));
    this.registerEvent(this.app.vault.on('delete', (f) => this.onLocalChange(f, 'delete')));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onLocalRename(f, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      if (this.canSync()) { this.startPolling(); this.reconcile('startup'); }
    });
  }

  onunload() {
    this.stopPolling();
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  /* ---------- 配置 ---------- */
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    if (!this.settings.baseline || typeof this.settings.baseline !== 'object') this.settings.baseline = {};
  }
  async saveSettings() { await this.saveData(this.settings); }
  canSync() {
    return !!(this.settings.enabled && this.settings.serverUrl && this.settings.apiKey);
  }

  /* ---------- HTTP（requestUrl 绕过 CORS，移动端可用） ---------- */
  async api(method, urlPath, opts) {
    opts = opts || {};
    const base = String(this.settings.serverUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('未配置服务端地址');
    let url = base + urlPath;
    if (opts.query) {
      const qs = Object.keys(opts.query)
        .filter((k) => opts.query[k] !== undefined && opts.query[k] !== null)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(opts.query[k]))
        .join('&');
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    }
    const headers = { 'X-API-Key': this.settings.apiKey, 'Accept': 'application/json' };
    const req = { url: url, method: method, headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      req.contentType = 'application/json';
      req.body = JSON.stringify(opts.body);
    }

    // 不用 resp.json 的隐式解析（失败时只抛一句无上下文的 SyntaxError）；改读 resp.text
    // 手动 JSON.parse：网络错误或解析失败先重试（GET 幂等；POST 重试经服务端 LWW 判定为
    // site-wins 不会重复写，安全），仍失败则抛出带 status/content-type/长度/出错片段的诊断。
    const maxTries = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      let resp;
      try {
        resp = await requestUrl(req);
      } catch (e) {
        lastErr = new Error('无法连接服务端：' + ((e && e.message) || e));
        if (attempt < maxTries) { await sleep(300 * attempt); continue; }
        throw lastErr;
      }
      if (resp.status === 401) throw new Error('API Key 无效或已吊销（401）');
      const text = resp.text != null ? resp.text : '';
      if (resp.status >= 400) {
        let detail = '';
        try { detail = (JSON.parse(text) || {}).detail || ''; } catch (e) { /* 错误体可能非 JSON */ }
        throw new Error(detail || ('请求失败 ' + resp.status));
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch (e) {
        lastErr = diagnoseJsonError(e, text, resp, method, urlPath);
        console.warn('[OmniHome Sync] 响应 JSON 解析失败（第 ' + attempt + '/' + maxTries +
          ' 次）：', lastErr.message, '\n原始响应前 500 字：', text.slice(0, 500));
        if (attempt < maxTries) { await sleep(300 * attempt); continue; }
        throw lastErr;
      }
    }
    throw lastErr || new Error('请求失败');
  }
  remoteList() {
    return this.api('GET', '/api/sync/list').then((d) => (d && d.files) || []);
  }
  remoteGet(path) { return this.api('GET', '/api/sync/file', { query: { path: path } }); }
  remotePut(path, content, clientMtime) {
    // 正文走 base64：请求体对内容安全网关/WAF 不透明，避免 <script>/<svg> 等特征被拦截或改写
    return this.api('POST', '/api/sync/file',
      { body: { path: path, contentB64: b64encode(content), clientMtime: clientMtime } });
  }
  remoteRename(oldPath, newPath) {
    return this.api('PUT', '/api/sync/file/rename', { body: { oldPath: oldPath, newPath: newPath } });
  }
  remoteDelete(path) { return this.api('DELETE', '/api/sync/file', { query: { path: path } }); }

  async testConnection() {
    const list = await this.remoteList();
    return list.length;
  }

  /* ---------- 状态栏 ---------- */
  setStatus(state) {
    this.status = state;
    const el = this.statusBar;
    if (!el) return;
    const map = {
      off: ['\u2298', '未启用'], syncing: ['\u21bb', '同步中\u2026'], idle: ['\u2713', '已同步'],
      synced: ['\u2713', '已同步'], paused: ['\u23f8', '已暂停'], error: ['\u26a0', '错误'],
    };
    const pair = map[state] || map.idle;
    el.setText(pair[0] + ' 万事屋');
    let tip = 'OmniHome Sync：' + pair[1];
    if (state === 'error' && this.lastError) tip += '（' + this.lastError + '）';
    el.setAttr('aria-label', tip);
    el.className = 'omnihome-sync-status mod-' + state;
  }

  /* ---------- 自写抑制（避免拉取/删除触发的事件回环） ---------- */
  markSelfWrite(path) { this.selfWrites[path] = nowMs(); }
  isSelfWrite(path) {
    const t = this.selfWrites[path];
    return !!(t && (nowMs() - t) < SELF_WRITE_MS);
  }

  /* ---------- 本地事件 ---------- */
  onLocalChange(f, kind) {
    if (!(f instanceof TFile) || f.extension !== 'md') return;
    if (isHiddenPath(f.path)) return;
    if (this.isSelfWrite(f.path)) return;
    this.scheduleReconcile('local:' + kind);
  }
  onLocalRename(f, oldPath) {
    if (!(f instanceof TFile) || f.extension !== 'md') return;
    if (!this.canSync()) return;
    if (isHiddenPath(f.path) || isHiddenPath(oldPath)) { this.scheduleReconcile('rename'); return; }
    if (this.isSelfWrite(f.path) || this.isSelfWrite(oldPath)) { this.scheduleReconcile('rename'); return; }
    const b = this.settings.baseline[oldPath];
    if (b) {
      // 旧路径曾同步过：走服务端 rename，保持笔记身份与历史（退化为删+建会丢 ID）
      this.markSelfWrite(f.path);
      this.setStatus('syncing');
      this.remoteRename(oldPath, f.path).then((resp) => {
        this.settings.baseline[f.path] = { lm: (f.stat && f.stat.mtime) || nowMs(), rm: (resp && resp.mtime) || b.rm };
        delete this.settings.baseline[oldPath];
        return this.saveSettings();
      }).then(() => { this.setStatus('idle'); this.notifyChanges(1); })
        .catch((e) => { this.lastError = (e && e.message) || String(e); this.setStatus('error'); this.scheduleReconcile('rename-fallback'); });
    } else {
      this.scheduleReconcile('rename');
    }
  }
  scheduleReconcile(reason) {
    if (!this.canSync()) return;
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => { this._debounce = null; this.reconcile(reason); }, DEBOUNCE_MS);
  }

  /* ---------- 轮询 ---------- */
  startPolling() {
    this.stopPolling();
    if (!this.canSync()) return;
    const sec = Math.max(3, Math.min(300, parseInt(this.settings.pollSeconds, 10) || 8));
    this._pollId = this.registerInterval(window.setInterval(() => this.reconcile('poll'), sec * 1000));
  }
  stopPolling() {
    if (this._pollId) { window.clearInterval(this._pollId); this._pollId = null; }
  }

  /* ---------- 仓库扫描 / 文件夹补齐 ---------- */
  scanVault() {
    const files = this.app.vault.getMarkdownFiles();
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (isHiddenPath(f.path)) continue;
      out.push({ path: f.path, mtime: (f.stat && f.stat.mtime) || 0, file: f });
    }
    return out;
  }
  async ensureVaultFolder(dir) {
    if (!dir) return;
    const vault = this.app.vault;
    const parts = String(dir).split('/');
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? cur + '/' + parts[i] : parts[i];
      if (!cur || isHiddenPath(cur)) continue;
      if (!vault.getAbstractFileByPath(cur)) {
        try { await vault.createFolder(cur); } catch (e) { /* 可能并发已建，忽略 */ }
      }
    }
  }

  /* ---------- 单文件操作 ---------- */
  async pushFile(f, baseline) {
    const content = await this.app.vault.read(f.file);
    const resp = await this.remotePut(f.path, content, f.mtime);
    if (resp && resp.applied === false) {
      // 站点优先（LWW 拒绝本地推送）：回拉站点较新版本，本地让位
      await this.pullFile(f.path, f.file, { mtime: resp.mtime }, baseline);
      return true;
    }
    baseline[f.path] = { lm: f.mtime, rm: (resp && resp.mtime) || nowMs() };
    return true;
  }
  async pullFile(path, file, r, baseline) {
    const data = await this.remoteGet(path);
    const content = decodeSyncContent(data);
    if (content === null) {
      // 既无 contentB64 也无 content：服务端与插件版本不匹配。绝不写空正文（会清空本地笔记）。
      throw new Error('服务端响应缺少正文字段（contentB64/content），请将服务端更新到 0.2.29 及以上');
    }
    this.markSelfWrite(path);
    let target = file;
    if (target) {
      await this.app.vault.modify(target, content);
    } else {
      await this.ensureVaultFolder(parentDir(path));
      target = await this.app.vault.create(path, content);
    }
    const lm = (target && target.stat && target.stat.mtime) || nowMs();
    baseline[path] = { lm: lm, rm: (data && data.mtime) || (r && r.mtime) || nowMs() };
    return true;
  }
  async trashLocal(f, baseline) {
    this.markSelfWrite(f.path);
    try { await this.app.vault.trash(f.file, true); }   // 移入 vault 内 .trash（可恢复）
    catch (e) { try { await this.app.vault.delete(f.file); } catch (e2) { /* 忽略 */ } }
    delete baseline[f.path];
    return true;
  }
  async deleteRemote(path, baseline) {
    await this.remoteDelete(path);
    delete baseline[path];
    return true;
  }

  /* ---------- 对账引擎（双向 · LWW · 删除安全阀） ---------- */
  async reconcile(reason) {
    if (!this.canSync()) { this.setStatus('off'); return; }
    if (this.syncing) return;
    this.syncing = true;
    this.setStatus('syncing');
    const baseline = this.settings.baseline;
    let changes = 0;
    try {
      const localFiles = this.scanVault();
      const localByPath = {};
      for (let i = 0; i < localFiles.length; i++) localByPath[localFiles[i].path] = localFiles[i];
      const remote = await this.remoteList();
      const remoteByPath = {};
      for (let i = 0; i < remote.length; i++) remoteByPath[remote[i].path] = remote[i];

      const plannedLocalDeletes = [];    // 远端已删 -> 本地移入回收
      const plannedRemoteDeletes = [];   // 本地已删 -> 远端软删（进门户回收站）

      // Pass A：遍历本地文件
      for (let i = 0; i < localFiles.length; i++) {
        const f = localFiles[i];
        const r = remoteByPath[f.path];
        const b = baseline[f.path];
        if (r) {
          const localChanged = !b || f.mtime > (b.lm || 0) + LOCAL_STABLE_MS;
          const remoteChanged = !b || r.mtime > (b.rm || 0) + LWW_WINDOW_MS;
          if (localChanged && remoteChanged) {
            // 双改：mtime 较新者胜，2 秒同刻窗口内站点优先
            if (f.mtime > r.mtime + LWW_WINDOW_MS) { if (await this.pushFile(f, baseline)) changes++; }
            else if (await this.pullFile(f.path, f.file, r, baseline)) changes++;
          } else if (localChanged) {
            if (await this.pushFile(f, baseline)) changes++;
          } else if (remoteChanged) {
            if (await this.pullFile(f.path, f.file, r, baseline)) changes++;
          }
        } else if (!b) {
          // 远端没有、也无基线 -> 新本地文件，推送创建
          if (await this.pushFile(f, baseline)) changes++;
        } else if (f.mtime > (b.lm || 0) + LOCAL_STABLE_MS) {
          // 同步后本地又改过，而远端已删 -> 本地胜，重新推送
          if (await this.pushFile(f, baseline)) changes++;
        } else {
          // 本地未改而远端消失 -> 远端删除传播到本地
          plannedLocalDeletes.push(f);
        }
      }

      // Pass B：遍历远端文件（本地缺失者）
      for (let i = 0; i < remote.length; i++) {
        const r = remote[i];
        if (localByPath[r.path]) continue;
        if (!baseline[r.path]) {
          // 新远端文件 -> 拉取创建
          if (await this.pullFile(r.path, null, r, baseline)) changes++;
        } else {
          // 曾同步过却本地消失 -> 本地删除传播到远端
          plannedRemoteDeletes.push(r.path);
        }
      }

      // Pass C：清理双侧都已消失的基线残留
      Object.keys(baseline).forEach((p) => {
        if (!localByPath[p] && !remoteByPath[p]) delete baseline[p];
      });

      // 删除安全阀：本轮两方向计划删除合计超阈值 -> 暂停 + 确认
      const totalDeletes = plannedLocalDeletes.length + plannedRemoteDeletes.length;
      if (totalDeletes > DELETE_VALVE) {
        this.setStatus('paused');
        const ok = await confirmDialog(this.app, {
          title: '检测到大量删除',
          sub: '本轮同步将删除 ' + totalDeletes + ' 个文件（本地 ' + plannedLocalDeletes.length +
               ' / 远端 ' + plannedRemoteDeletes.length + '）。这可能是误操作或首次绑定错位。' +
               '「继续删除」将执行；「取消」则跳过删除（其余变更已应用），请人工确认后重同步。',
          okText: '继续删除', danger: true,
        });
        if (!ok) {
          await this.saveSettings();
          this.setStatus('paused');
          new Notice('OmniHome Sync：已暂停删除同步（' + totalDeletes + ' 项），请人工确认后「立即同步」', 8000);
          if (changes) this.notifyChanges(changes);
          return;
        }
      }
      for (let i = 0; i < plannedLocalDeletes.length; i++) { if (await this.trashLocal(plannedLocalDeletes[i], baseline)) changes++; }
      for (let i = 0; i < plannedRemoteDeletes.length; i++) { if (await this.deleteRemote(plannedRemoteDeletes[i], baseline)) changes++; }

      await this.saveSettings();
      this.lastSync = nowMs();
      this.lastError = '';
      this.setStatus(changes ? 'synced' : 'idle');
      if (changes) this.notifyChanges(changes);
    } catch (e) {
      this.lastError = (e && e.message) || String(e);
      this.setStatus('error');
      console.error('[OmniHome Sync] reconcile 失败：', e);
      this.notifyErrorOnce(this.lastError);
    } finally {
      this.syncing = false;
    }
  }

  /* ---------- 通知（聚合 / 节流） ---------- */
  notifyChanges(n) {
    this._pending = (this._pending || 0) + n;
    const t = nowMs();
    if (t - this._lastNotify >= NOTIFY_THROTTLE_MS) {
      this._lastNotify = t;
      const c = this._pending; this._pending = 0;
      new Notice('OmniHome Sync：' + c + ' 处变更已同步');
    }
  }
  notifyErrorOnce(msg) {
    const t = nowMs();
    if (t - this._lastErrNotify >= ERR_THROTTLE_MS) {
      this._lastErrNotify = t;
      new Notice('OmniHome Sync 错误：' + msg, 8000);
    }
  }

  /* ---------- 手动 / 开关 ---------- */
  async manualSync() {
    if (!this.canSync()) {
      new Notice('OmniHome Sync：请先在设置中填写服务端地址与 API Key 并启用同步', 6000);
      return;
    }
    new Notice('OmniHome Sync：开始同步\u2026');
    await this.reconcile('manual');
  }
  async toggleSync() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    if (this.settings.enabled) {
      this.startPolling(); this.reconcile('toggle-on');
      new Notice('OmniHome Sync：已恢复同步');
    } else {
      this.stopPolling(); this.setStatus('off');
      new Notice('OmniHome Sync：已暂停同步（不影响任何已有笔记）');
    }
  }
}

/* ============================================================
   设置页
   ============================================================ */
class OmniHomeSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const containerEl = this.containerEl;
    const plugin = this.plugin;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'OmniHome Sync · 万事屋同步' });
    containerEl.createEl('p', {
      cls: 'omnihome-sync-help',
      text: '插件版本 v' + ((plugin.manifest && plugin.manifest.version) || PLUGIN_VERSION) +
        '　·　正文经 base64 传输（规避中间内容安全网关 / WAF 篡改响应导致的 JSON 解析崩坏）',
    });

    new Setting(containerEl)
      .setName('服务端地址')
      .setDesc('门户站点根地址，含协议与端口、无末尾斜杠。移动端 / 公网请用域名并启用 HTTPS。')
      .addText((t) => t.setPlaceholder('http://192.168.1.100:8000')
        .setValue(plugin.settings.serverUrl)
        .onChange(async (v) => {
          plugin.settings.serverUrl = String(v || '').trim().replace(/\/+$/, '');
          await plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('在门户「设置 → 数据与存储 → Obsidian 同步」生成，明文仅显示一次。')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('ohs_\u2026').setValue(plugin.settings.apiKey)
          .onChange(async (v) => { plugin.settings.apiKey = String(v || '').trim(); await plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('轮询间隔（秒）')
      .setDesc('定期检查服务端变更，建议 5-10 秒（3-300）。')
      .addText((t) => t.setValue(String(plugin.settings.pollSeconds))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          plugin.settings.pollSeconds = isNaN(n) ? 8 : Math.max(3, Math.min(300, n));
          await plugin.saveSettings();
          plugin.startPolling();
        }));

    new Setting(containerEl)
      .setName('启用同步')
      .setDesc('开启后双向同步；关闭仅停止同步，不删除任何本地或服务端笔记。')
      .addToggle((t) => t.setValue(plugin.settings.enabled)
        .onChange(async (v) => {
          plugin.settings.enabled = !!v;
          await plugin.saveSettings();
          if (v) { plugin.startPolling(); plugin.reconcile('toggle-on'); }
          else { plugin.stopPolling(); plugin.setStatus('off'); }
        }));

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('验证服务端地址与 API Key 是否有效。')
      .addButton((b) => b.setButtonText('测试连接').onClick(async () => {
        try {
          const n = await plugin.testConnection();
          new Notice('OmniHome Sync：连接成功，服务端有 ' + n + ' 篇可同步笔记', 6000);
        } catch (e) { new Notice('OmniHome Sync：连接失败 — ' + ((e && e.message) || e), 8000); }
      }));

    new Setting(containerEl)
      .setName('立即同步')
      .setDesc('手动触发一次全量对账。')
      .addButton((b) => b.setButtonText('立即同步').onClick(() => plugin.manualSync()));

    new Setting(containerEl)
      .setName('解绑')
      .setDesc('清空服务端地址、API Key 与同步基线（不删除任何本地文件或服务端笔记）。')
      .addButton((b) => b.setButtonText('解绑').setWarning().onClick(async () => {
        const ok = await confirmDialog(plugin.app, {
          title: '解绑 OmniHome Sync？',
          sub: '将清空配置与同步基线，不会删除本地文件或服务端笔记。',
          okText: '解绑', danger: true,
        });
        if (!ok) return;
        plugin.stopPolling();
        plugin.settings = Object.assign({}, DEFAULT_SETTINGS, { baseline: {} });
        await plugin.saveSettings();
        plugin.setStatus('off');
        this.display();
        new Notice('OmniHome Sync：已解绑');
      }));

    containerEl.createEl('p', {
      cls: 'omnihome-sync-help',
      text: '同步范围：普通笔记（不含常驻笔记、每日计划、灵感速记）。冲突按最后修改时间优先（LWW，2 秒内站点优先）。单轮删除超过 ' + DELETE_VALVE + ' 个会暂停并请你确认。',
    });
  }
}

module.exports = OmniHomeSyncPlugin;
module.exports.default = OmniHomeSyncPlugin;
