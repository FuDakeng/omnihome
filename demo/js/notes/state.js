/* 知识库共享状态。各子模块只往 S 上挂函数。 */
export const S = {};

S.idx = [];            // [{id,title,tags,folder,pinned,updated}];

S.folders = [];        // [文件夹名];

S.vaults = [];         // [{id,name,kind}];

S.shares = [];         // 当前有效分享;

S.lastKnownUpdated = 0;

S.trashSort = 'deleted';

S.trashExpanded = new Set();

S.currentVault = 'default';

S.folderVault = {};    // folderPath -> vaultId;

S.currentId = null;

S.currentMode = 'edit';

S.currentFolder = '';  // 新建笔记的默认文件夹（最近点选的）;

S.EXPAND_KEY = 'omni.kb.expanded';

S.expanded = new Set((() => {
    try { return JSON.parse(localStorage.getItem(S.EXPAND_KEY) || '[]'); }
    catch (_) { return []; }
  })());

S.dirty = false;

S.saveTimer = null;

S.liveEd = null;       // LiveMD 实例（原地实时渲染）;

S.shareLiveEd = null;  // 分享页独立 LiveMD，不与主编辑器抢实例;

S.selNotes = new Set();    // ctrl/cmd 多选：笔记 id 集合;

S.selFolders = new Set();  // ctrl/cmd 多选：文件夹路径集合;

S.selAssets = new Set();   // ctrl/cmd 多选：附件名集合（拖动可批量引用入编辑区）;

S.selMode = false;         // 显式多选模式：开启后普通点击即勾选（免按 ⌘/Ctrl）;

S.dragState = null;        // 当前拖拽 {kind: 'note'|'folder', ids: []};

S.assets = [];             // 附件分区清单 [{name, type, size, ts}];

S.openTabs = [];           // 多笔记标签页：已打开笔记 id 的有序列表，末位为当前页候选;

S.TABS_KEY = 'omni.kb.tabs';   // 标签页持久化，刷新后恢复上次打开的笔记;

S.PLAN_FOLDER = '每日计划';
S.QUICK_FOLDER = '灵感速记';

S.PIN_KEY = 'omni.kb.pinned.hidden';

S.ASSET_KEY = 'omni.kb.assets.hidden';

S.VAULT_KEY = 'omni.kb.vault';

S.trash = [];                        // 当前加载的回收站条目（弹层打开时拉取）;

S.trashDays = null;                  // 回收站保留天数（后端下发；null=未知）;

S.VAULT_DEFAULT = 'default';
S.VAULT_SYSTEM = 'system';

S.hydrated = new WeakSet();

S.assetDataCache = new Map();   // path -> data URL;

S.assetPending = new Map();     // path -> Promise;

S._kbMenuAnchor = null;

S._kbMenuDocClose = null;

S.trashVaults = [];

S._revNoteId = '';

S._revCanRestore = false;

S._revDiffOn = true;

S._revCache = null;

S.previewFolded = new WeakMap();

S.previewMermaidView = new WeakMap();

S.shareTarget = null;

S.shareView = { token: '', canEdit: false, nid: '', mode: 'edit' };

S.shareSaveTimer = 0;

S._obsidianPlain = '';

S._obsidianPlainVault = '';

