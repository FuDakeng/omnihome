import { S } from './state.js';

S.bindTree = function () {/* ---------- 桌面拖拽 .md 文件 / 文件夹 → 导入（支持嵌套结构） ---------- */
    const dropTarget = $('#noteTree');   // 容器同时承载 .kb-tree-body 类（用于拖拽高亮）
    if (dropTarget){
      dropTarget.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('Files')){
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          dropTarget.classList.add('kb-drop-active');
        }
      });
      dropTarget.addEventListener('dragleave', e => {
        if (!dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('kb-drop-active');
      });
      dropTarget.addEventListener('drop', async e => {
        e.preventDefault();
        dropTarget.classList.remove('kb-drop-active');
        const dt = e.dataTransfer;
        if (!dt) return;
        /* 本机图片 → 直接上传为附件（自动归档进附件分区）；其余文件继续走 .md/.zip 导入 */
        const files = Array.from(dt.files || []);
        const imgs = files.filter(f => f.type && f.type.startsWith('image/'));
        if (imgs.length){
          let ok = 0, fail = 0;
          for (const f of imgs){
            try { await S.uploadImage(f); ok++; }
            catch (err){ fail++; showToast('上传失败：' + (err.message || f.name), 'err'); }
          }
          if (ok){ S.refreshAssets(); showToast(`已上传 ${ok} 个附件，已归档到附件分区${fail ? `（${fail} 个失败）` : ''}`); }
          if (files.length === imgs.length) return;   // 全是图片，无需导入
        }
        const items = Array.from(dt.items || []).filter(it => {
          const f = it.getAsFile && it.getAsFile();
          return !(f && f.type && f.type.startsWith('image/'));   // 图片已另行处理
        });
        if (!items.length) return;
        /* 单个 .md / .zip 文件 → 直接走 multipart 端点 */
        if (items.length === 1){
          const f = items[0].getAsFile && items[0].getAsFile();
          if (f && (f.name.toLowerCase().endsWith('.md') || f.name.toLowerCase().endsWith('.zip'))){
            await dropUploadSingle(f);
            return;
          }
        }
        /* 多文件 / 文件夹：用 webkitGetAsEntry 递归收集 */
        const collected = [];
        for (const it of items){
          if (typeof it.webkitGetAsEntry !== 'function') continue;
          const entry = it.webkitGetAsEntry();
          if (entry) await walkEntry(entry, '', collected);
        }
        if (!collected.length){
          showToast('未发现 .md 文件（已自动忽略 macOS 资源垃圾与系统文件）', 'err');
          return;
        }
        await dropUploadMulti(collected);
      });
    }

    function readEntries(reader, out, prefix){
      /* prefix 透传到子项，让后端 import-files 看到完整相对路径以建对应文件夹 */
      return new Promise(resolve => {
        function readBatch(){
          reader.readEntries(async entries => {
            if (!entries.length) return resolve();
            for (const e of entries) await walkEntry(e, prefix || '', out);
            readBatch();
          });
        }
        readBatch();
      });
    }
    async function walkEntry(entry, prefix, out){
      if (entry.isFile){
        if (!entry.name.toLowerCase().endsWith('.md')) return;
        if (entry.name.startsWith('._') || entry.name === 'Thumbs.db' || entry.name === '.DS_Store') return;
        const file = await new Promise(r => entry.file(r));
        const text = await file.text();
        out.push({ path: (prefix || '') + entry.name, content: text });
      } else if (entry.isDirectory){
        /* 子文件夹用 父prefix + 文件夹名 + '/' 作为下一级前缀，
           否则后端 import-files 把所有 md 全部建到根目录、嵌套结构丢失（v0.2.15 BUG 修复） */
        await readEntries(entry.createReader(), out, (prefix || '') + entry.name + '/');
      }
    }
    async function dropUploadSingle(file){
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch('/api/notes/import-md', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + API.getToken() }, body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入 ${d.imported} 个笔记${d.skipped ? '（跳过 ' + d.skipped + ' 个）' : ''}`);
        await S.load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    }
    async function dropUploadMulti(files){
      try {
        const r = await fetch('/api/notes/import-files', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API.getToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });
        if (!r.ok) throw new Error((await r.json()).detail || ('HTTP ' + r.status));
        const d = await r.json();
        showToast(`导入 ${d.imported} 篇笔记${d.skipped ? '（跳过 ' + d.skipped + ' 个非 .md）' : ''}`);
        await S.load();
      } catch (e) { showToast('导入失败：' + e.message, 'err'); }
    }
    /* 面包屑点击（已移至底部状态栏）：根清空选择，文件夹段展开并滚动到该目录 */
    $('#edCrumb')?.addEventListener('click', e => {
      const root = e.target.closest('[data-crumb=root]');
      if (root){
        if (S.currentId){
          S.openTabs = S.openTabs.filter(t => t !== S.currentId);   // 同步关闭当前标签页
          S.persistTabs();
          S.currentId = null; $('#edSrc').value=''; $('#edTitle').value=''; S.renderPreview(); S.updateCrumb(); S.renderTree(); S.renderTabs();
        }
        return;
      }
      const f = e.target.closest('[data-crumb=folder]');
      if (f){
        const path = f.dataset.folder;
        if (!S.expanded.has(path)){ S.expanded.add(path); S.persistExpanded(); S.renderTree(); }
        setTimeout(() => {
          const row = document.querySelector('[data-folder-toggle="' + path + '"]');
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 50);
      }
    });

    /* 多笔记标签页栏：点击切换笔记，× 关闭标签页 */
    $('#edTabs')?.addEventListener('click', e => {
      const x = e.target.closest('[data-tab-x]');
      if (x){ e.stopPropagation(); S.closeTab(x.dataset.tabX); return; }
      const t = e.target.closest('[data-tab]');
      if (t && t.dataset.tab !== S.currentId) S.open(t.dataset.tab);
    });

    /* 附件灯箱：关闭 / 删除 / 点击背景关闭
       注意：#assetLightbox 在页面底部，晚于本脚本执行，若直接绑在元素上会因 ?. 短路而永不生效。
       必须用 document 委托，运行时元素已存在也能命中。 */
    document.addEventListener('click', e => {
      if (!e.target.closest || !e.target.closest('#assetLightbox')) return;
      if (e.target.closest('[data-asset-close]')) S.closeAssetPreview();
      else if (e.target.closest('[data-asset-del]')){
        const name = $('#assetLightbox').dataset.name;
        if (name) S.deleteAsset(name);
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('#assetLightbox')?.classList.contains('open')) S.closeAssetPreview();
    });

/* 回收站条目：恢复 / 永久删。
   必须绑 document 委托（v0.2.26 修复按钮无响应）：列表在 #kbTrashMask 弹层内，
   不在 #noteTree 子树中，绑在 noteTree 上的监听器永远收不到弹层内的点击 */
    document.addEventListener('click', e => {
      const rst = e.target.closest('[data-trash-restore]');
      if (rst){ e.stopPropagation(); S.restoreTrash(rst.dataset.trashRestore); return; }
      const prg = e.target.closest('[data-trash-purge]');
      if (prg){ e.stopPropagation(); S.purgeTrash(prg.dataset.trashPurge); return; }
      const fold = e.target.closest('[data-trash-fold]');
      if (fold){
        e.stopPropagation();
        const p = fold.dataset.trashFold;
        if (S.trashExpanded.has(p)) S.trashExpanded.delete(p); else S.trashExpanded.add(p);
        S.renderTrashList();
        return;
      }
      const ts = e.target.closest('[data-trash-sort]');
      if (ts){
        e.stopPropagation();
        S.trashSort = ts.dataset.trashSort || 'deleted';
        S.renderTrashList();
      }
    });

    /* 编辑区拖入附件 → 在光标处插入引用 */
    const edSrc = $('#edSrc');
    if (edSrc){
      edSrc.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('text/omni-asset') || e.dataTransfer.types.includes('text/plain')){
          e.preventDefault();
          edSrc.classList.add('drop-target');
        }
      });
      edSrc.addEventListener('dragleave', () => edSrc.classList.remove('drop-target'));
      edSrc.addEventListener('drop', e => {
        edSrc.classList.remove('drop-target');
        if (e.dataTransfer.types.includes('text/omni-asset')){
          e.preventDefault();
          const md = e.dataTransfer.getData('text/plain');
          if (md){
            if (S.liveEd && S.liveEd.isShown()){
              S.liveEd.insertText('\n' + md + '\n');
              showToast('已插入附件引用');
            } else {
              const ta = edSrc;
              ta.value = ta.value.slice(0, ta.selectionStart) + '\n' + md + '\n' + ta.value.slice(ta.selectionStart);
              ta.dispatchEvent(new Event('input'));
              ta.focus();
              showToast('已插入附件引用');
            }
          }
        }
      });
    }

    /* 进入知识库视图时刷新（覆盖仪表盘速记新建等跨视图变化） */
    document.addEventListener('view-change', e => {
      if (e.detail === 'notes') S.load();
    });
    /* 设置/其他模块清理完垃圾数据后触发刷新 */
    document.addEventListener('kb-refresh', () => S.load());
    /* 注意：v0.2.8 起知识库改为固定 3 栏布局（kb-layout），目录折叠功能已随
       #kbSideToggle / .note-layout 一并移除——不要再在这里引用它们，
       否则 init() 在此抛 TypeError，其后所有事件绑定（树点击/编辑模式/工具栏…）全部失效 */
    /* #noteDel 顶栏按钮已随 0.2.18 移除，删除入口在悬浮 ⋯ 菜单；旧绑定同步删掉防空引用崩溃 */

    /* 树：点击（打开笔记 / 展开文件夹 / 新建 / 删文件夹 / 分区折叠 / 多选勾选 / 悬浮操作菜单） */
    $('#noteTree').addEventListener('click', e => {
      const nact = e.target.closest('[data-note-act]');
      if (nact){ e.stopPropagation(); S.openNoteMenu(nact, nact.dataset.noteAct); return; }
      const ndel = e.target.closest('[data-note-del]');
      if (ndel){ e.stopPropagation(); S.del(ndel.dataset.noteDel); return; }
      const kadd = e.target.closest('[data-kb-add]');
      if (kadd){ e.stopPropagation(); S.openKbMenu(kadd, kadd.dataset.kbAdd); return; }
      const fact = e.target.closest('[data-folder-act]');
      if (fact){ e.stopPropagation(); S.openFolderMenu(fact, fact.dataset.folderAct); return; }
      const add = e.target.closest('[data-folder-add]');
      if (add){
        e.stopPropagation();
        S.newFolder(add.dataset.folderAdd);
        return;
      }
      if (e.target.closest('[data-pin-toggle]')){
        localStorage.setItem(S.PIN_KEY, localStorage.getItem(S.PIN_KEY) === '1' ? '0' : '1');
        S.renderTree();
        return;
      }
      if (e.target.closest('[data-assets-toggle]')){
        localStorage.setItem(S.ASSET_KEY, localStorage.getItem(S.ASSET_KEY) === '1' ? '0' : '1');
        S.renderTree();
        return;
      }
      if (e.target.closest('[data-sync-toggle]')){
        localStorage.setItem(SYNC_KEY, localStorage.getItem(SYNC_KEY) === '1' ? '0' : '1');
        S.renderTree();
        return;
      }
      const assetDel = e.target.closest('[data-asset-del]');
      if (assetDel){ e.stopPropagation(); S.deleteAsset(assetDel.dataset.assetDel); return; }
      const assetRow = e.target.closest('[data-asset-name]');
      if (assetRow){
        /* ⌘/Ctrl 点选或多选模式下点选：多选附件待批量拖入编辑区；普通点击预览，Alt+点击插入引用 */
        if (e.ctrlKey || e.metaKey || S.selMode){
          const name = assetRow.dataset.assetName;
          S.selAssets.has(name) ? S.selAssets.delete(name) : S.selAssets.add(name);
          S.renderTree();
          return;
        }
        S.selAssets.clear();
        if (e.altKey) S.insertAssetRef(assetRow.dataset.assetName);
        else S.showAssetPreview(assetRow.dataset.assetName);
        return;
      }
      const row = e.target.closest('[data-folder-toggle]');
      if (row){
        const f = row.dataset.folderToggle;
        if (e.ctrlKey || e.metaKey || S.selMode){
          /* ctrl/cmd 点选：多选文件夹待批量挪动（内置/专属不可选） */
          if (f !== S.PLAN_FOLDER && f !== S.QUICK_FOLDER){
            S.selFolders.has(f) ? S.selFolders.delete(f) : S.selFolders.add(f);
            S.renderTree();
          }
          return;
        }
        /* 普通点击：退出多选状态，避免选中效果残留 */
        S.selNotes.clear(); S.selFolders.clear(); S.selAssets.clear();
        if (S.expanded.has(f)) S.expanded.delete(f); else S.expanded.add(f);
        S.persistExpanded();
        S.currentFolder = f;
        S.renderTree();
        return;
      }
      const btn = e.target.closest('[data-note-id]');
      if (btn){
        const id = btn.dataset.noteId;
        const meta = S.idx.find(n => n.id === id);
        if ((e.ctrlKey || e.metaKey || S.selMode) && meta && !meta.pinned){
          S.selNotes.has(id) ? S.selNotes.delete(id) : S.selNotes.add(id);
          S.renderTree();
          return;
        }
        S.selNotes.clear(); S.selFolders.clear(); S.selAssets.clear();   // 普通点击清除多选残留（BUG 修复）
        S.open(id);
      }
    });

    /* 树：拖拽笔记/文件夹 → 文件夹 / 根目录（多选时批量挪动） */
    const tree = $('#noteTree');
    tree.addEventListener('dragstart', e => {
      const item = e.target.closest ? e.target.closest('[data-note-id]') : null;
      const row = e.target.closest ? e.target.closest('[data-folder-toggle]') : null;
      const assetRow = e.target.closest ? e.target.closest('[data-asset-name]') : null;
      if (!S.vaultCanEdit() && (item || row)){ e.preventDefault(); return; }
      if (item){
        const id = item.dataset.noteId;
        if (!S.selNotes.has(id)) S.selNotes = new Set([id]);
        S.selFolders.clear();
        S.dragState = { kind: 'note', ids: [...S.selNotes] };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        setTimeout(() => item.classList.add('dragging'), 0);
        return;
      }
      if (row){
        const f = row.dataset.folderToggle;
        if (f === S.PLAN_FOLDER || f === S.QUICK_FOLDER){ e.preventDefault(); return; }
        if (!S.selFolders.has(f)) S.selFolders = new Set([f]);
        S.selNotes.clear();
        S.dragState = { kind: 'folder', ids: [...S.selFolders] };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f);
        setTimeout(() => row.classList.add('dragging'), 0);
      }
      if (assetRow){
        /* 拖动附件 → 编辑区可在光标位置插入引用；多选时批量插入 */
        const name = assetRow.dataset.assetName;
        const names = S.selAssets.has(name) ? [...S.selAssets] : [name];
        const mds = names.map(nm => '![' + nm.replace(/[\[\]()]/g, '') + '](/api/notes/assets/' + encodeURIComponent(nm) + ')');
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/omni-asset', names.join('\n'));
        e.dataTransfer.setData('text/plain', mds.join('\n'));
      }
    });
    tree.addEventListener('dragend', e => {
      const item = e.target.closest ? e.target.closest('[data-note-id], [data-folder-toggle]') : null;
      if (item) item.classList.remove('dragging');
      S.dragState = null;
      S.highlightTrash(false);
      $$('.kb-drop-hint', tree).forEach(x => x.classList.remove('kb-drop-hint'));
    });
    tree.addEventListener('dragover', e => {
      if (!S.dragState) return;
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (!drop) return;
      if (S.dragState.kind === 'folder'){
        const t = drop.dataset.folderToggle || '';
        /* 不允许把文件夹拖入自身或子孙 */
        if (t && S.dragState.ids.some(f => t === f || t.startsWith(f + '/'))) return;
      }
      e.preventDefault();
      drop.classList.add('kb-drop-hint');
    });
    tree.addEventListener('dragleave', e => {
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (drop) drop.classList.remove('kb-drop-hint');
    });
    tree.addEventListener('drop', async e => {
      const drop = e.target.closest ? e.target.closest('[data-folder-toggle], [data-drop-root]') : null;
      if (!drop || !S.dragState) return;
      e.preventDefault();
      drop.classList.remove('kb-drop-hint');
      const target = drop.dataset.folderToggle || '';
      const { kind, ids } = S.dragState;
      S.dragState = null;
      if (kind === 'note') await S.moveNotes(ids, target);
      else await S.moveFolders(ids, target);
      S.selNotes.clear(); S.selFolders.clear();
    });

    /* 批量删除：拖入删除横条与底部多选操作栏共用 */
    async function bulkDeleteNotes(ids){
      const metas = ids.map(id => S.idx.find(n => n.id === id)).filter(Boolean);
      if (metas.some(n => n.pinned)) showToast('内置笔记已跳过（删除后会自动重建，无需手动删）');
      const delIds = metas.filter(n => !n.pinned).map(n => n.id);
      if (!delIds.length) return;
      let failed = 0;
      for (const id of delIds){
        await API.del('/api/notes/' + id).catch(() => { failed++; });
      }
      S.idx = S.idx.filter(n => !delIds.includes(n.id));
      S.openTabs = S.openTabs.filter(t => !delIds.includes(t));   // 同步清理被删笔记的标签页
      S.persistTabs();
      /* 徽标 +N（v0.2.23：批量删除同样进回收站） */
      try {
        const c = parseInt(localStorage.getItem('om_trash_count') || '0', 10) + delIds.length;
        localStorage.setItem('om_trash_count', String(c));
        const badge = $('#kbTrashBadge');
        if (badge){ badge.textContent = String(c); badge.hidden = false; }
      } catch (_) {}
      showToast(`已移到回收站 ${delIds.length} 篇笔记`);
      if (delIds.includes(S.currentId)){
        S.currentId = null; S.dirty = false;
        $('#edSrc').value = ''; $('#edTitle').value = ''; S.renderPreview();
        if (S.liveEd) S.liveEd.refresh();
        S.updateCrumb();
        if (S.openTabs.length) S.open(S.openTabs[S.openTabs.length - 1]);
        else if (S.idx.length) S.open(S.idx[0].id);
      }
      S.selNotes.clear();
      S.renderTree();
      S.renderTabs();
      showToast(delIds.length - failed > 0
        ? `已移到回收站 ${delIds.length - failed} 篇笔记${failed ? `（${failed} 篇失败）` : ''}`
        : '删除失败');
      if (delIds.length - failed > 0) S.loadTrash();   // 后台刷新真实计数
    }
    async function bulkDeleteFolders(ids){
      const dels = ids.filter(f => f !== S.PLAN_FOLDER && f !== S.QUICK_FOLDER);
      if (!dels.length) return;
      const ok = await App.confirmModal({
        title: dels.length > 1 ? `删除 ${dels.length} 个文件夹？`
          : `删除文件夹「${S.folderLabel(dels[0])}」？`,
        sub: '内部子文件夹将一并删除，其中的笔记全部移入回收站（可恢复，原文件夹在恢复时自动重建）。',
        okText: '删除', danger: true,
      });
      if (!ok) return;
      let trashed = 0;
      for (const f of dels){
        await API.del('/api/notes/folders/' + encodeURIComponent(f))
          .then(r => { trashed += (r && r.trashed) || 0; })
          .catch(e2 => showToast(e2.message, 'err'));
        if (S.currentFolder === f) S.currentFolder = '';
        S.expanded.delete(f); S.persistExpanded();
      }
      S.selFolders.clear();
      await S.load();
      showToast(dels.length > 1
        ? `已删除 ${dels.length} 个文件夹（${trashed} 篇笔记进回收站）`
        : `文件夹已删除（${trashed} 篇笔记进回收站）`);
      if (trashed) S.loadTrash();
    }

    /* 快速删除：拖拽落到树列底部「回收站」条即删（v0.2.25 替代原全屏横条；内置项自动跳过）
       v0.3.4：ESM 拆分后必须读 S.selNotes，裸 ident 会在 dragstart 抛错，drop 因无 dragState 被拒 */
    const foot = $('#kbTreeFoot');
    if (foot){
      const allowTrashDrop = e => {
        if (!S.dragState) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        foot.classList.add('kb-drop-del');
      };
      /* capture：内部按钮是视觉层，保证拖到按钮上也能 preventDefault 接受 drop */
      foot.addEventListener('dragover', allowTrashDrop, true);
      foot.addEventListener('dragenter', allowTrashDrop, true);
      foot.addEventListener('dragleave', e => {
        if (!foot.contains(e.relatedTarget)) foot.classList.remove('kb-drop-del');
      });
      foot.addEventListener('drop', async e => {
        if (!S.dragState) return;
        e.preventDefault();
        e.stopPropagation();
        S._trashDropAt = Date.now();   // 抑制随后误触发的 click（打开回收站弹层）
        const { kind, ids } = S.dragState;
        S.dragState = null;
        S.highlightTrash(false);
        $$('.kb-drop-hint', tree).forEach(x => x.classList.remove('kb-drop-hint'));
        if (kind === 'note') await bulkDeleteNotes(ids);
        else await bulkDeleteFolders(ids);
      }, true);
    }

    /* 多选操作栏：批量删除 / 取消选择 */
    $('#kbBatchDel')?.addEventListener('click', async () => {
      const noteIds = [...S.selNotes], folderIds = [...S.selFolders];
      if (!noteIds.length && !folderIds.length) return;
      if (noteIds.length) await bulkDeleteNotes(noteIds);
      if (folderIds.length) await bulkDeleteFolders(folderIds);
      S.clearAllSel();
      S.renderTree();
    });
    $('#kbBatchClear')?.addEventListener('click', () => {
      S.clearAllSel();
      S.renderTree();
    });

    $('#edSrc').addEventListener('input', S.onSrcInput);
    $('#edTitle').addEventListener('input', () => {
      S.dirty = true;
      /* 标签页标题实时跟随（保存落库时再同步目录树） */
      const meta = S.idx.find(n => n.id === S.currentId);
      if (meta){ meta.title = $('#edTitle').value.trim() || '未命名笔记'; S.renderTabs(); }
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(S.save, 900);
    });
    $$('#edModeSeg .seg-btn').forEach(b =>
      b.addEventListener('click', () => S.setMode(b.dataset.edMode)));

    };
