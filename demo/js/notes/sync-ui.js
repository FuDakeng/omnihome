import { S } from './state.js';

  S.fmtObsidianLogTs = function(ts){
    const d = new Date((ts || 0) * 1000);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  S.openObsidianModal = async function(){
    await S.loadObsidianModal();
    App.openModal('kbObsidianMask');
  };

  S.loadObsidianModal = async function(){
    const v = S.vaultMeta(S.currentVault);
    const block = S.vaultSyncBlock(v);
    const switchLock = S.vaultSyncSwitchLocked(v);
    const sw = $('#kbObsidianEnabled');
    const hit = $('#kbObsidianSwitchHit');
    const chip = $('#kbObsidianChip');
    const body = $('#kbObsidianBody');
    const note = $('#kbObsidianBlockNote');
    const urlEl = $('#kbObsidianUrl');
    if (urlEl) urlEl.value = location.origin.replace(/\/$/, '');
    if ($('#kbObsidianSub')) $('#kbObsidianSub').textContent = '当前仓库「' + (v.name || S.currentVault) + '」';
    if ($('#kbObsidianTokenSub')) $('#kbObsidianTokenSub').textContent = '为「' + (v.name || S.currentVault)
      + '」配置令牌。明文仅生成时可见；一键复制会带上服务端地址与 API Key，可在 Obsidian 插件设置里粘贴导入。';

    await S.refreshObsidianPluginBtn();

    if (block){
      if (sw){
        sw.disabled = true;
        sw.classList.remove('on');
        sw.setAttribute('aria-disabled', 'true');
      }
      hit?.classList.add('locked');
      if (chip){
        chip.textContent = '不可同步';
        chip.className = 'chip warning no-dot';
      }
      $('#kbObsidianEnableSub').textContent = block;
      if (note){
        note.hidden = false;
        $('#kbObsidianBlockText').textContent = block;
      }
      if (body) body.hidden = true;
      return;
    }

    let on = false;
    try {
      const info = await API.get('/api/sync/apikey?vault=' + encodeURIComponent(S.currentVault));
      on = !!info.vaultSync;
    } catch (e) {}

    if (switchLock){
      if (sw){
        sw.disabled = true;
        sw.setAttribute('aria-disabled', 'true');
      }
      hit?.classList.add('locked');
      $('#kbObsidianEnableSub').textContent = switchLock + (on
        ? ' 当前仓库同步已开启。'
        : ' 当前仓库同步已关闭。');
      if (note){
        note.hidden = false;
        $('#kbObsidianBlockText').textContent = switchLock;
      }
    } else {
      if (sw){
        sw.disabled = false;
        sw.removeAttribute('aria-disabled');
      }
      hit?.classList.remove('locked');
      $('#kbObsidianEnableSub').textContent = '仅对当前仓库生效。关闭后同步立即不可用，已有令牌会失效但不会被吊销，重新开启后可继续使用。';
      if (note) note.hidden = true;
    }

    sw?.classList.toggle('on', on);
    if (chip){
      chip.textContent = on ? '已开启' : '已关闭';
      chip.className = on ? 'chip success no-dot' : 'chip no-dot';
    }
    if (body) body.hidden = !on;
    if (on) await Promise.all([S.renderObsidianVaultKey(), S.renderObsidianLog()]);
  };

  S.refreshObsidianPluginBtn = async function(){
    try {
      const pc = await API.get('/api/plugin/check');
      const btn = $('#kbObsidianPluginDl');
      if (!btn) return;
      btn.dataset.available = pc.available ? '1' : '';
      if (pc.available && pc.version && !btn.dataset.ver){
        btn.dataset.ver = '1';
        btn.append(' v' + pc.version);
      }
    } catch (e) {}
  };

  S.renderObsidianVaultKey = async function(){
    const box = $('#kbObsidianVaultKey');
    if (!box) return;
    const v = S.vaultMeta(S.currentVault);
    let info = { enabled: false };
    try {
      info = await API.get('/api/sync/apikey?vault=' + encodeURIComponent(S.currentVault));
    } catch (e) {}
    const k = (info.keys || []).find(x => x.vault === S.currentVault) || (info.enabled ? info : null);
    const tag = v.kind === 'team' ? '<span class="chip no-dot" style="margin-left:6px;font-size:10px">团队</span>' : '';
    const mask = (k && k.prefix)
      ? `<span class="chip no-dot" style="margin-left:6px;font-size:10px" title="令牌前缀">${App.esc(k.prefix)}…</span>`
      : '';
    const hasKey = !!(k && (k.prefix || k.enabled));
    box.innerHTML = `<div class="sync-vault-row">
      <div class="nm">${App.esc(v.name || S.currentVault)}${tag}${mask}</div>
      <div class="sv-actions">
        ${hasKey ? `<button class="btn btn-outline btn-sm" data-obs-bundle>一键复制连接信息</button>
        <button class="btn btn-primary btn-sm" data-obs-gen>重置</button>
        <button class="btn btn-outline btn-sm" style="color:var(--om-danger)" data-obs-rev>吊销</button>`
          : `<button class="btn btn-primary btn-sm" data-obs-gen data-obs-new="1">生成令牌</button>`}
      </div>
    </div>`;
  }

  S.renderObsidianLog = async function(){
    const box = $('#kbObsidianLog');
    if (!box) return;
    try {
      const d = await API.get('/api/sync/log?vault=' + encodeURIComponent(S.currentVault) + '&limit=80');
      const logs = (d.logs || []).filter(x => ['add', 'edit', 'delete'].indexOf(x.kind) >= 0);
      if (!logs.length){ box.textContent = '暂无笔记变更记录'; return; }
      const kindLabel = { add: '新增', edit: '修改', delete: '删除' };
      const kindChip = { add: 'success', edit: 'info', delete: 'danger' };
      box.innerHTML = logs.map(x => {
        const dir = (x.from && x.to) ? (x.from + ' → ' + x.to) : '';
        return `<div class="sync-log-item">
          <div class="sync-log-top">
            <span class="chip ${kindChip[x.kind] || ''} no-dot">${kindLabel[x.kind] || App.esc(x.kind)}</span>
            <span class="nm">${App.esc(x.title || x.path || '未命名笔记')}</span>
            <span class="ts">${S.fmtObsidianLogTs(x.ts)}</span>
          </div>
          ${dir ? `<div class="sync-log-dir">${App.esc(dir)}</div>` : ''}
          <div class="sync-log-sum">${App.esc(x.summary || x.msg || '')}</div>
        </div>`;
      }).join('');
    } catch (e) { box.textContent = '日志加载失败'; }
  };

  S.copyObsidianBundle = async function(){
    if (!S._obsidianPlain || S._obsidianPlainVault !== S.currentVault){
      showToast('请先生成或重置令牌后再复制连接信息', 'err');
      return;
    }
    const url = ($('#kbObsidianUrl')?.value || location.origin).replace(/\/$/, '');
    const v = S.vaultMeta(S.currentVault);
    const blob = 'OMNIHOME_SYNC\nurl: ' + url + '\nkey: ' + S._obsidianPlain
      + '\nvault: ' + S.currentVault + (v.name ? '\nvaultName: ' + v.name : '') + '\n';
    try { await navigator.clipboard.writeText(blob); showToast('已复制服务端地址与 API Key，可在插件设置里一键粘贴'); }
    catch (err) { showToast('复制失败', 'err'); }
  };

