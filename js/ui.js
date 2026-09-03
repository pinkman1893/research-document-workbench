/* UI 层：侧栏文献库、工作区、分类管理、弹层、菜单、拖放 */
const UI = {
  collapsed: {},

  syncPanels() {
    const app = document.getElementById('app');
    if (!app) return;
    const rp = document.getElementById('right-panel');
    const sb = document.getElementById('sidebar');
    const narrow = innerWidth <= 1000;
    if (rp) rp.inert = rp.hidden || app.classList.contains('rp-collapsed');
    if (sb) sb.inert = narrow && !app.classList.contains('sidebar-open');
  },

  init() {
    this.closeCtx();
    document.getElementById('btn-sb-toggle').addEventListener('click', () => {
      document.getElementById('app').classList.toggle('sidebar-open');
      this.syncPanels();
    });
    matchMedia('(max-width: 1000px)').addEventListener('change', e => {
      if (e.matches) document.getElementById('app').classList.add('rp-collapsed');
      else document.getElementById('app').classList.remove('sidebar-open');
      this.syncPanels();
      Reader.renderToolbar(); Reader.onResize();
    });
    document.getElementById('brand-mark').innerHTML = icon('book-open', 19);
    document.getElementById('ws-switch-ic').innerHTML = icon('chevron-down', 15);
    document.getElementById('btn-add-paper').innerHTML = icon('plus', 15) + '<span>添加文献</span>';
    document.getElementById('btn-class-manage').innerHTML = icon('sliders', 14) + '<span>管理分类</span>';
    document.getElementById('btn-data').innerHTML = icon('library', 14) + '<span>备份与恢复</span>';
    document.getElementById('btn-ai-settings').innerHTML = icon('sliders', 16);
    document.getElementById('btn-rp-collapse').innerHTML = icon('panel-right', 16);
    document.getElementById('btn-rp-expand').innerHTML = icon('panel-right', 14);
    document.getElementById('drop-icon').innerHTML = icon('upload', 40);

    document.getElementById('btn-add-paper').addEventListener('click', () => {
      document.getElementById('file-input').click();
    });
    document.getElementById('file-input').addEventListener('change', (e) => {
      if (e.target.files.length) App.importFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('ws-bar').addEventListener('click', (e) => {
      e.stopPropagation();
      UI.workspaceMenu(e.currentTarget);
    });
    document.getElementById('class-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const ws = App.ws(); if (!ws || ws.classMode === b.dataset.mode) return;
      ws.classMode = b.dataset.mode;
      App.saveWs().catch(saveError);
      UI.renderSidebar();
    });
    document.getElementById('btn-class-manage').addEventListener('click', (e) => {
      e.stopPropagation();
      const ws = App.ws();
      if (!ws) return;
      if (ws.classMode === 'tier') UI.tierManageMenu(e.currentTarget);
      else UI.categoryManageMenu(e.currentTarget);
    });
    document.getElementById('btn-data').addEventListener('click', () => Backup.openManager());

    // 全局拖放
    let dragDepth = 0;
    const overlay = document.getElementById('drop-overlay');
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      dragDepth++; overlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; overlay.hidden = true;
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      const files = Array.from(e.dataTransfer.files);
      const backups = files.filter(f => /\.rdwb$/i.test(f.name));
      if (backups.length) {
        if (files.length !== 1) UI.toast('备份文件请单独导入', 'error');
        else Backup.importFile(backups[0]);
      } else App.importFiles(files);
    });

    // 右侧面板 tab
    document.getElementById('rp-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      AI.setTab(b.dataset.tab);
    });
    document.getElementById('btn-rp-collapse').addEventListener('click', () => {
      document.getElementById('app').classList.toggle('rp-collapsed');
      this.syncPanels();
      setTimeout(() => Reader.onResize(), 300);
    });
    document.getElementById('btn-rp-expand').addEventListener('click', () => {
      document.getElementById('app').classList.remove('rp-collapsed');
      this.syncPanels();
      setTimeout(() => Reader.onResize(), 300);
    });
    document.getElementById('btn-ai-settings').addEventListener('click', () => AI.openSettings());
    document.getElementById('ctx-layer').addEventListener('click', () => UI.closeCtx());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { UI.closeCtx(); UI.closeModal(); } });

    try {
      const c = localStorage.getItem('rd_collapsed');
      if (c) this.collapsed = JSON.parse(c);
    } catch (e) {}
  },

  render() {
    this.renderSidebar();
    this.renderMain();
    this.syncPanels();
  },

  /* ---------- 侧栏 ---------- */
  renderSidebar() {
    const ws = App.ws();
    if (!ws) return;
    document.getElementById('ws-name').textContent = ws.name;
    document.querySelectorAll('#class-mode button').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === ws.classMode);
    });
    document.getElementById('btn-class-manage').querySelector('span').textContent =
      ws.classMode === 'tier' ? '管理等级' : '管理分类';

    if (typeof Search !== 'undefined' && Search.isActive() && Search.renderList()) return;

    const papers = App.wsPapers();
    const byOrder = arr => arr.slice().sort((a, b) =>
      (a.order != null ? a.order : a.addedAt) - (b.order != null ? b.order : b.addedAt));
    const reading = byOrder(papers.filter(p => p.status === 'reading'));
    const todo = byOrder(papers.filter(p => p.status === 'todo'));
    const done = byOrder(papers.filter(p => p.status === 'done'));

    let html = '';
    html += this.sectionHTML('正在阅读', 'reading', reading, false);
    if (ws.classMode === 'tier') {
      const groups = ws.tiers.map(t => ({ label: t, cls: 'tier-' + Math.min(ws.tiers.indexOf(t), 6), items: todo.filter(p => p.tier === t) }));
      const none = todo.filter(p => p.tier == null);
      if (none.length) groups.push({ label: '未分级', cls: 'tier-n', items: none });
      html += this.sectionHTML('待读', 'todo', todo, false, groups);
    } else {
      const groups = ws.categories.map(c => ({ label: c.name, cls: 'cat-chip', items: todo.filter(p => p.categoryId === c.id) }));
      const none = todo.filter(p => p.categoryId == null);
      if (none.length) groups.push({ label: '未分类', cls: 'cat-chip', items: none });
      html += this.sectionHTML('待读', 'todo', todo, false, groups);
    }
    html += this.sectionHTML('已完成', 'done', done, true);

    document.getElementById('paper-list').innerHTML = html;

    document.querySelectorAll('.sb-sec-head').forEach(h => {
      h.addEventListener('click', () => {
        const key = h.dataset.key;
        UI.collapsed[key] = !UI.collapsed[key];
        try { localStorage.setItem('rd_collapsed', JSON.stringify(UI.collapsed)); } catch (e) {}
        UI.renderSidebar();
      });
      UI.bindSectionDrop(h);
    });
    document.querySelectorAll('.paper-row').forEach(r => {
      const main = r.querySelector('.pr-main');
      if (main) main.addEventListener('click', () => {
        App.openPaper(r.dataset.id);
      });
      const kb = r.querySelector('.pr-kebab');
      if (kb) kb.addEventListener('click', (e) => { e.stopPropagation(); UI.paperMenu(kb, r.dataset.id); });
      UI.bindRowDrag(r);
    });
  },

  /* 文献行拖拽排序 */
  bindRowDrag(row) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest('.pr-kebab')) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/rd-row', row.dataset.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.paper-row').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    });
    row.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer.types).includes('text/rd-row')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      const dragId = e.dataTransfer.getData('text/rd-row');
      if (!dragId || dragId === row.dataset.id) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      App.movePaper(dragId, row.dataset.id, before);
    });
  },

  /* 分区标题（待读/正在阅读/已完成）可作为拖放目标：仅切换状态 */
  bindSectionDrop(head) {
    head.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer.types).includes('text/rd-row')) return;
      e.preventDefault();
      head.classList.add('drop-target');
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
    head.addEventListener('drop', (e) => {
      head.classList.remove('drop-target');
      const dragId = e.dataTransfer.getData('text/rd-row');
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      App.movePaperToStatus(dragId, head.dataset.key);
    });
  },

  sectionHTML(title, key, items, defaultCollapsed, groups) {
    const collapsed = this.collapsed[key] != null ? this.collapsed[key] : defaultCollapsed;
    let inner = '';
    if (!collapsed) {
      if (groups && groups.length) {
        for (const g of groups) {
          if (!g.items.length) continue;
          inner += '<div class="sb-group-label"><span class="pr-chip ' + g.cls + '">' + esc(g.label) + '</span><span class="cnt">' + g.items.length + '</span></div>';
          inner += g.items.map(p => this.rowHTML(p)).join('');
        }
        if (!groups.some(g => g.items.length)) {
          inner += '<div class="sb-group-label" style="padding-left:10px">暂无文献 · 可拖入 PDF 或点击「添加文献」</div>';
        }
      } else {
        inner = items.map(p => this.rowHTML(p)).join('');
        if (!items.length) inner = '<div class="sb-group-label" style="padding-left:10px">' +
          (key === 'reading' ? '暂无正在阅读的文献' : key === 'todo' ? '暂无待读文献 · 拖入 PDF 开始' : '暂无已完成文献') + '</div>';
      }
    }
    return '<div class="sb-section">' +
      '<button class="sb-sec-head' + (collapsed ? ' collapsed' : '') + '" data-key="' + key + '">' +
      icon('chevron-down', 13) + '<span>' + title + '</span><span class="sb-sec-count">' + items.length + '</span></button>' +
      '<div class="sb-sec-body">' + inner + '</div></div>';
  },

  rowHTML(p) {
    const ws = App.ws();
    let chip = '';
    if (ws && ws.classMode === 'tier' && p.tier) {
      const idx = ws.tiers.indexOf(p.tier);
      chip = '<span class="pr-chip tier-' + Math.min(idx < 0 ? 99 : idx, 6) + '">' + esc(p.tier) + '</span>';
    } else if (ws && ws.classMode === 'custom' && p.categoryId) {
      const c = ws.categories.find(x => x.id === p.categoryId);
      if (c) chip = '<span class="pr-chip cat-chip">' + esc(c.name) + '</span>';
    }
    let progress = '';
    if (p.status === 'reading' && p.progress && p.pageCount) {
      const pct = Math.round(100 * p.progress.page / p.pageCount);
      progress = '<div class="pr-progress"><i style="width:' + pct + '%"></i></div>' +
        '<div class="pr-prog-label">P' + p.progress.page + ' / ' + p.pageCount + ' · ' + pct + '%</div>';
    }
    return '<div class="paper-row' + (p.id === App.paperId ? ' active' : '') + (p.status === 'done' ? ' done' : '') + '" data-id="' + p.id + '">' +
      '<button type="button" class="pr-main">' +
      '<div class="pr-title">' + esc(p.title) + '</div>' +
      '<div class="pr-meta">' + chip + '<span>' + fmtSize(p.size) + '</span><span>' + fmtDate(p.addedAt) + '</span></div>' +
      progress +
      '</button>' +
      '<button type="button" class="pr-kebab" aria-label="更多操作：' + esc(p.title) + '" title="更多操作">' + icon('more', 15) + '</button>' +
      '</div>';
  },

  /* ---------- 主区 ---------- */
  renderMain() {
    const home = document.getElementById('home-view');
    const reader = document.getElementById('reader-view');
    const rp = document.getElementById('right-panel');
    if (App.view === 'reader') {
      if (this._lastView !== 'reader' && innerWidth <= 1000) document.getElementById('app').classList.add('rp-collapsed');
      document.getElementById('app').classList.remove('sidebar-open');
      home.hidden = true; reader.hidden = false; rp.hidden = false;
    } else {
      home.hidden = false; reader.hidden = true; rp.hidden = true;
      this.renderHome();
    }
    this._lastView = App.view;
    this.syncPanels();
  },

  renderHome() {
    const el = document.getElementById('home-inner');
    if (!el || App.view === 'reader') return;
    const ws = App.ws();
    if (!ws) { el.innerHTML = ''; return; }
    const papers = App.wsPapers();
    const counts = {
      todo: papers.filter(p => p.status === 'todo').length,
      reading: papers.filter(p => p.status === 'reading').length,
      done: papers.filter(p => p.status === 'done').length
    };
    const recent = papers.filter(p => p.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 5);
    el.innerHTML =
      '<h1 class="home-title">' + esc(ws.name) + '</h1>' +
      '<div class="home-sub">' + (papers.length ? '共 ' + papers.length + ' 篇文献' : '一个新的科研任务，从收集文献开始') + '</div>' +
      '<div class="home-stats">' +
      '<div class="hstat"><div class="num">' + counts.todo + '</div><div class="lbl">待读</div></div>' +
      '<div class="hstat"><div class="num">' + counts.reading + '</div><div class="lbl">正在阅读</div></div>' +
      '<div class="hstat"><div class="num">' + counts.done + '</div><div class="lbl">已完成</div></div>' +
      '</div>' +
      '<button type="button" class="home-drop" id="home-drop">' + icon('upload', 34) +
      '<div class="hd-main">拖入 PDF 文献，或点击选择文件</div>' +
      '<div class="hd-sub">支持一次添加多篇 · 首次打开将自动进入「正在阅读」</div></button>' +
      (recent.length ? '<div class="home-recent"><h3>最近阅读</h3>' + recent.map(p =>
        '<button class="recent-row" data-id="' + p.id + '">' + icon('file-text', 16) +
        '<span class="recent-title">' + esc(p.title) + '</span>' +
        '<span class="recent-meta">' + (p.status === 'done' ? '已完成' : p.progress && p.pageCount ? 'P' + p.progress.page + '/' + p.pageCount : '待读') + '</span></button>'
      ).join('') + '</div>' : '');

    const drop = el.querySelector('#home-drop');
    drop.addEventListener('click', () => document.getElementById('file-input').click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    // 文件只由 window 的 drop 导入；此处仅更新视觉状态，避免冒泡导致双重导入。
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragover'); });
    el.querySelectorAll('.recent-row').forEach(r => r.addEventListener('click', () => App.openPaper(r.dataset.id)));
  },

  /* ---------- 菜单系统 ---------- */
  closeCtx() {
    const l = document.getElementById('ctx-layer');
    l.innerHTML = ''; l.style.pointerEvents = 'none';
  },

  openCtx(anchor, items, opts) {
    opts = opts || {};
    this.closeCtx();
    const layer = document.getElementById('ctx-layer');
    layer.style.pointerEvents = 'auto';
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = items.map(it => {
      if (it === '-') return '<div class="ctx-sep"></div>';
      if (it.groupTitle) return '<div class="ctx-group-title">' + esc(it.groupTitle) + '</div>';
      const subArrow = it.sub ? '<span class="sub-arrow">' + icon('chevron-right', 13) + '</span>' : '';
      return '<button class="ctx-item' + (it.danger ? ' danger' : '') + '" data-k="' + (it.key || '') + '" ' +
        (it.disabled ? 'disabled style="opacity:.4"' : '') + '>' +
        icon(it.icon || 'circle', 15) + '<span>' + esc(it.label) + '</span>' + subArrow + '</button>';
    }).join('');
    layer.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = opts.x != null ? opts.x : rect.left;
    let y = opts.y != null ? opts.y : rect.bottom + 6;
    if (x + mw > innerWidth - 10) x = Math.max(10, innerWidth - mw - 10);
    if (y + mh > innerHeight - 10) y = Math.max(10, rect.top - mh - 6);
    if (opts.alignRight) x = Math.max(10, opts.x != null ? opts.x - mw : rect.right - mw);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';

    menu.querySelectorAll('.ctx-item').forEach(b => {
      if (b.disabled) return;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const it = items.find(i => i !== '-' && i.key === b.dataset.k);
        if (!it) return;
        if (it.sub) { UI.openCtx(b, it.sub, { x: b.getBoundingClientRect().right + 4, y: b.getBoundingClientRect().top - 5 }); return; }
        UI.closeCtx();
        it.action && it.action();
      });
    });
    return menu;
  },

  /* 工作区菜单 */
  workspaceMenu(anchor) {
    const items = App.workspaces.map(w => ({
      key: 'ws' + w.id, label: w.name + '（' + App.papersOf(w.id).length + '）', icon: w.id === App.wsId ? 'circle-check' : 'library',
      action: () => { if (w.id !== App.wsId) App.switchWs(w.id); }
    }));
    items.push('-');
    items.push({ key: 'new', label: '新建工作区', icon: 'plus', action: () => this.newWorkspace() });
    items.push({ key: 'rename', label: '重命名当前工作区', icon: 'edit', action: () => this.renameWorkspace() });
    items.push({ key: 'del', label: '删除当前工作区', icon: 'trash', danger: true, action: () => App.deleteWorkspace(App.wsId) });
    this.openCtx(anchor, items);
  },

  async newWorkspace() {
    const name = await this.prompt('新建工作区', '为这批科研任务起个名字，例如「毕业论文 · 方向调研」', '工作区名称', '新建');
    if (!name) return;
    const w = { id: uid(), name, createdAt: Date.now(), classMode: 'tier', tiers: ['T0', 'T1', 'T2', 'T3'], categories: [] };
    await DB.put('workspaces', w);
    App.workspaces.push(w);
    await App.switchWs(w.id);
    this.toast('已创建工作区「' + name + '」');
  },

  async renameWorkspace() {
    const ws = App.ws(); if (!ws) return;
    const name = await this.prompt('重命名工作区', '', '工作区名称', '保存', ws.name);
    if (!name || name === ws.name) return;
    ws.name = name; await App.saveWs(); this.render();
  },

  /* 等级管理菜单 */
  tierManageMenu(anchor) {
    const ws = App.ws();
    const items = [{ groupTitle: '等级（点击可隐藏/显示无效，仅作展示）' }];
    ws.tiers.forEach((t, i) => items.push({
      key: 't' + i, label: t + ' · ' + App.wsPapers().filter(p => p.tier === t).length + ' 篇', icon: 'tag',
      action: () => this.renameTier(i)
    }));
    items.push('-');
    items.push({ key: 'add', label: '添加等级 T' + ws.tiers.length, icon: 'plus', action: async () => {
      ws.tiers.push('T' + ws.tiers.length);
      await App.saveWs(); this.renderSidebar(); this.toast('已添加等级 T' + (ws.tiers.length - 1));
    } });
    items.push({ key: 'del', label: '删除末位等级', icon: 'trash', danger: true, disabled: ws.tiers.length <= 1, action: () => this.removeLastTier() });
    this.openCtx(anchor, items);
  },

  async renameTier(i) {
    const ws = App.ws();
    const cur = ws.tiers[i];
    const name = await this.prompt('重命名等级', '通常保持 T0~Tn 命名，也可以自定义（如 T0 · 精读）', '等级名称', '保存', cur);
    if (!name || name === cur) return;
    const affected = App.wsPapers().filter(p => p.tier === cur);
    ws.tiers[i] = name;
    for (const p of affected) { p.tier = name; await App.savePaper(p); }
    await App.saveWs(); this.renderSidebar();
  },

  async removeLastTier() {
    const ws = App.ws();
    const t = ws.tiers[ws.tiers.length - 1];
    const n = App.wsPapers().filter(p => p.tier === t).length;
    const ok = await this.confirm('删除等级 ' + t, n ? '该等级下有 ' + n + ' 篇文献，删除后将变为「未分级」' : '', '删除');
    if (!ok) return;
    ws.tiers.pop();
    for (const p of App.wsPapers()) if (p.tier === t) { p.tier = null; await App.savePaper(p); }
    await App.saveWs(); this.renderSidebar();
  },

  /* 自定义分类管理 */
  categoryManageMenu(anchor) {
    const ws = App.ws();
    const items = [];
    if (ws.categories.length) items.push({ groupTitle: '全部分类' });
    ws.categories.forEach(c => items.push({
      key: 'c' + c.id, label: c.name + ' · ' + App.wsPapers().filter(p => p.categoryId === c.id).length + ' 篇', icon: 'tag',
      action: () => this.renameCategory(c.id)
    }));
    items.push('-');
    items.push({ key: 'add', label: '新建分类', icon: 'plus', action: () => this.newCategory() });
    if (ws.categories.length) items.push({ key: 'del', label: '删除分类…', icon: 'trash', danger: true, action: () => this.deleteCategoryMenu(anchor) });
    this.openCtx(anchor, items);
  },

  async newCategory() {
    const ws = App.ws();
    const name = await this.prompt('新建分类', '例如：必读精读 / 背景了解 / 方法参考', '分类名称', '创建');
    if (!name) return;
    ws.categories.push({ id: uid(), name });
    await App.saveWs(); this.renderSidebar(); this.toast('已创建分类「' + name + '」');
  },

  async renameCategory(id) {
    const ws = App.ws();
    const c = ws.categories.find(x => x.id === id); if (!c) return;
    const name = await this.prompt('重命名分类', '', '分类名称', '保存', c.name);
    if (!name || name === c.name) return;
    c.name = name; await App.saveWs(); this.renderSidebar();
  },

  deleteCategoryMenu(anchor) {
    const ws = App.ws();
    const items = ws.categories.map(c => ({
      key: 'd' + c.id, label: c.name, icon: 'trash', danger: true,
      action: async () => {
        const n = App.wsPapers().filter(p => p.categoryId === c.id).length;
        const ok = await this.confirm('删除分类「' + c.name + '」', n ? '该分类下有 ' + n + ' 篇文献，删除后将变为「未分类」，文献本身不受影响。' : '', '删除');
        if (!ok) return;
        ws.categories = ws.categories.filter(x => x.id !== c.id);
        for (const p of App.wsPapers()) if (p.categoryId === c.id) { p.categoryId = null; await App.savePaper(p); }
        await App.saveWs(); this.renderSidebar();
      }
    }));
    this.openCtx(anchor, items);
  },

  /* 论文菜单 */
  paperMenu(anchor, id) {
    const p = App.paper(id); if (!p) return;
    const ws = App.ws();
    const tierItems = [{ groupTitle: '设置等级' }, { key: 'tier-null', label: '未分级', icon: 'tag', action: () => this.setTier(id, null) }];
    ws.tiers.forEach(t => tierItems.push({
      key: 'tier-' + t, label: t, icon: 'tag',
      action: () => this.setTier(id, t)
    }));
    tierItems.push('-');
    tierItems.push({ key: 'tier-mg', label: '管理等级', icon: 'sliders', action: () => UI.tierManageMenu(anchor) });

    const catItems = [{ groupTitle: '设置分类' }, { key: 'cat-null', label: '未分类', icon: 'tag', action: () => this.setCategory(id, null) }];
    ws.categories.forEach(c => catItems.push({ key: 'cat-' + c.id, label: c.name, icon: 'tag', action: () => this.setCategory(id, c.id) }));
    catItems.push('-');
    catItems.push({ key: 'cat-mg', label: '管理分类', icon: 'sliders', action: () => UI.categoryManageMenu(anchor) });

    const items = [
      { key: 'open', label: '打开阅读', icon: 'book-open', action: () => App.openPaper(id) },
      { key: 'tier', label: '设置等级', icon: 'layers', sub: tierItems },
      { key: 'cat', label: '移动到分类', icon: 'folder-plus', sub: catItems },
      { key: 'card', label: '论文卡片', icon: 'sparkles', action: async () => { await App.openPaper(id); AI.setTab('card'); } },
      '-',
      { key: 'rename', label: '重命名', icon: 'edit', action: () => this.renamePaper(id) }
    ];
    if (p.status !== 'done') items.push({ key: 'done', label: '标记为已完成', icon: 'circle-check', action: () => App.setStatus(id, 'done') });
    if (p.status !== 'todo') items.push({ key: 'back', label: '退回待读', icon: 'undo', action: () => App.setStatus(id, 'todo') });
    if (p.status === 'todo') items.push({ key: 'reading', label: '标记为正在阅读', icon: 'book-open', action: () => App.setStatus(id, 'reading') });
    items.push('-');
    items.push({ key: 'del', label: '删除文献', icon: 'trash', danger: true, action: () => App.deletePaper(id) });
    this.openCtx(anchor, items);
  },

  async setTier(id, tier) {
    const p = App.paper(id); if (!p) return;
    p.tier = tier; await App.savePaper(p); this.renderSidebar();
  },
  async setCategory(id, catId) {
    const p = App.paper(id); if (!p) return;
    p.categoryId = catId; await App.savePaper(p); this.renderSidebar();
  },

  async renamePaper(id) {
    const p = App.paper(id); if (!p) return;
    const name = await this.prompt('重命名文献', '', '文献名称', '保存', p.title);
    if (!name || name === p.title) return;
    p.title = name; await App.savePaper(p);
    this.renderSidebar(); this.renderHome();
    if (App.paperId === id) Reader.renderToolbar();
  },

  /* ---------- 弹窗 ---------- */
  _lastTrigger: null,

  closeModal() {
    const l = document.getElementById('modal-layer');
    if (l.hidden) return;
    l.hidden = true; l.innerHTML = '';
    document.getElementById('ctx-layer').style.pointerEvents = 'none';
    l.onkeydown = null; l.onclick = null;
    if (this._lastTrigger && this._lastTrigger.isConnected && typeof this._lastTrigger.focus === 'function') this._lastTrigger.focus();
    this._lastTrigger = null;
  },

  modal(title, bodyHTML, buttons, opts) {
    opts = opts || {};
    const l = document.getElementById('modal-layer');
    const trigger = document.activeElement;
    this._lastTrigger = trigger && trigger !== document.body ? trigger : null;
    l.hidden = false;
    l.innerHTML = '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="modal-head"><h3>' + esc(title) + '</h3><button class="ibtn" data-act="close" aria-label="关闭">' + icon('x', 17) + '</button></div>' +
      '<div class="modal-body">' + bodyHTML + '</div>' +
      '<div class="modal-foot">' + buttons.map((b, i) =>
        '<button class="' + (b.cls || 'btn-plain') + '" data-i="' + i + '">' + esc(b.label) + '</button>').join('') +
      '</div></div>';
    l.querySelector('[data-act="close"]').addEventListener('click', () => this.closeModal());
    l.onclick = (e) => { if (e.target === l) this.closeModal(); };
    l.onkeydown = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(l.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const btns = l.querySelectorAll('.modal-foot button');
    btns.forEach((b, i) => b.addEventListener('click', () => {
      const r = buttons[i].onClick && buttons[i].onClick();
      if (r !== false) this.closeModal();
    }));
    const first = l.querySelector('input, textarea, select');
    if (first && opts.focus !== false) setTimeout(() => first.focus(), 60);
    return l;
  },

  confirm(title, msg, okLabel, danger) {
    return new Promise(resolve => {
      const l = this.modal(title, '<p style="color:var(--ink)">' + msg + '</p>', [
        { label: '取消' },
        { label: okLabel || '确定', cls: danger ? 'btn-danger-main' : 'btn-primary', onClick: () => resolve(true) }
      ]);
      l.querySelector('.modal-foot button').addEventListener('click', () => resolve(false));
    });
  },

  prompt(title, msg, fieldLabel, okLabel, value) {
    return new Promise(resolve => {
      const l = this.modal(title,
        (msg ? '<p style="margin-bottom:12px">' + esc(msg) + '</p>' : '') +
        '<div class="form-field"><label>' + esc(fieldLabel || '') + '</label><input type="text" id="ui-prompt-input" value="' + esc(value || '') + '"></div>',
        [{ label: '取消' }, { label: okLabel || '确定', cls: 'btn-primary', onClick: () => resolve(l.querySelector('#ui-prompt-input').value.trim() || null) }],
        { focus: false });
      setTimeout(() => {
        const inp = l.querySelector('#ui-prompt-input');
        inp.focus(); inp.select();
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { resolve(inp.value.trim() || null); UI.closeModal(); }
        });
      }, 70);
      l.querySelector('.modal-foot button').addEventListener('click', () => resolve(null));
    });
  },

  /* ---------- 提示 ---------- */
  toast(msg, type) {
    const layer = document.getElementById('toast-layer');
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    t.innerHTML = (type === 'error' ? icon('x', 14) : icon('check', 14)) + '<span>' + esc(msg) + '</span>';
    layer.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2400);
  },

  viewImage(src) {
    const v = document.createElement('div');
    v.className = 'img-viewer';
    v.innerHTML = '<img src="' + src + '">';
    v.addEventListener('click', () => v.remove());
    document.body.appendChild(v);
  },

  fatal(msg) {
    const d = document.createElement('div');
    d.className = 'fatal';
    d.innerHTML = icon('shield', 30) + '<div style="margin-top:10px">' + msg + '</div>';
    document.body.appendChild(d);
  }
};
