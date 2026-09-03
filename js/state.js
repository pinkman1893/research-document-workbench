/* 应用状态：工作区、论文、当前视图 */
const App = {
  workspaces: [],
  papers: [],          // 所有工作区的论文（内存缓存，落盘于 IndexedDB）
  wsId: null,
  paperId: null,       // 当前打开的论文
  view: 'home',        // home | reader
  lastOpen: null,      // {wsId, paperId}
  _navVersion: 0,
  _navigating: false,
  _navTail: Promise.resolve(),
  _imports: Promise.resolve(),

  async init() {
    this.workspaces = await DB.all('workspaces');
    if (!this.workspaces.length) {
      const w = {
        id: uid(), name: '默认工作区', createdAt: Date.now(),
        classMode: 'tier', tiers: ['T0', 'T1', 'T2', 'T3'], categories: []
      };
      await DB.put('workspaces', w);
      this.workspaces.push(w);
    }
    let last = null;
    try { last = localStorage.getItem('rd_last_ws'); } catch (e) {}
    this.wsId = this.workspaces.some(w => w.id === last) ? last : this.workspaces[0].id;
    this.papers = await DB.all('papers');
  },

  ws() { return this.workspaces.find(w => w.id === this.wsId) || null; },
  paper(id) { return this.papers.find(p => p.id === (id != null ? id : this.paperId)) || null; },
  papersOf(wsId) { return this.papers.filter(p => p.wsId === wsId); },
  wsPapers() { return this.papersOf(this.wsId); },
  category(id) {
    const w = this.ws();
    return w ? w.categories.find(c => c.id === id) : null;
  },

  async saveWs() { const w = this.ws(); if (w) await DB.put('workspaces', w); },
  async savePaper(p) { await DB.put('papers', p); },

  navigate(action) {
    const version = ++this._navVersion;
    this._navigating = true;
    AI.cancelTasks();
    if (Reader._opening) Reader.cancelPending();
    const run = this._navTail.then(async () => {
      if (version !== this._navVersion) return false;
      await Promise.all([Notes.save(), AI.flushChat(), AI.flushCardEdit(), Reader.saveAnnosNow(), Reader.saveProgressNow()]);
      if (version !== this._navVersion) return false;
      return action(version);
    });
    this._navTail = run.catch(e => { saveError(e); return false; }).finally(() => { if (version === this._navVersion) this._navigating = false; });
    return this._navTail;
  },

  async leaveReader() {
    await AI.closePaper();
    await Reader.close(true);
    await DB.flush();
  },

  switchWs(id) {
    if (!this.workspaces.some(w => w.id === id)) return Promise.resolve(false);
    return this.navigate(async version => {
      await this.leaveReader();
      if (version !== this._navVersion) return false;
      this.wsId = id; this.paperId = null; this.view = 'home';
      try { localStorage.setItem('rd_last_ws', id); } catch (e) {}
      UI.render(); return true;
    });
  },

  /* 打开论文：首次打开自动进入“正在阅读” */
  openPaper(id) {
    const p = this.paper(id);
    if (!p) return Promise.resolve(false);
    if (!this._navigating && this.paperId === id && Reader.doc && !Reader._opening && AI.paperId === id) return Promise.resolve(true);
    return this.navigate(async version => {
      await this.leaveReader();
      if (version !== this._navVersion || !this.paper(id)) return false;
      this.paperId = id; this.wsId = p.wsId; this.view = 'reader';
      this.lastOpen = { wsId: this.wsId, paperId: id };
      if (p.status === 'todo') p.status = 'reading';
      p.lastOpenedAt = Date.now();
      await this.savePaper(p);
      if (version !== this._navVersion) return false;
      UI.render();
      const opened = await Reader.open(p);
      if (version !== this._navVersion || !opened) return false;
      await AI.onPaperOpened(p.id);
      if (version !== this._navVersion) return false;
      UI.renderSidebar(); return true;
    });
  },

  closePaper(toHome = true) {
    return this.navigate(async version => {
      await this.leaveReader();
      if (version !== this._navVersion) return false;
      this.paperId = null;
      if (toHome) { this.view = 'home'; UI.render(); }
      return true;
    });
  },

  async setStatus(id, status) {
    const p = this.paper(id);
    if (!p) return;
    p.status = status;
    if (status === 'done') p.doneAt = Date.now();
    else p.doneAt = null;
    await this.savePaper(p);
    UI.renderSidebar();
    UI.renderHome();
    Reader.refreshToolbarStatus();
  },

  /* 拖拽排序：把 dragId 移动到 targetId 前/后（仅在同一分组内重排序，不改分类与状态） */
  async reorderPaper(dragId, targetId, before) {
    const ws = this.ws();
    const d = this.paper(dragId), t = this.paper(targetId);
    if (!ws || !d || !t || d.id === t.id) return;
    const groupKey = p => p.status + '|' + (ws.classMode === 'tier' ? (p.tier || '') : (p.categoryId || ''));
    const inGroup = p => p.wsId === ws.id && groupKey(p) === groupKey(t);
    const group = this.papers.filter(inGroup)
      .sort((a, b) => (a.order != null ? a.order : a.addedAt) - (b.order != null ? b.order : b.addedAt));
    const ids = group.map(p => p.id).filter(id => id !== d.id);
    let idx = ids.indexOf(t.id);
    if (idx < 0) return;
    if (!before) idx++;
    ids.splice(idx, 0, d.id);
    for (let i = 0; i < ids.length; i++) {
      const p = this.paper(ids[i]);
      if (p.order !== i) { p.order = i; await this.savePaper(p); }
    }
    UI.renderSidebar();
  },

  /* 跨分组拖拽：落到某文献前/后 —— 若目标属于不同分组，先变更状态与归类，再在目标组内排序 */
  async movePaper(dragId, targetId, before) {
    const d = this.paper(dragId), t = targetId ? this.paper(targetId) : null;
    if (!d || (targetId && !t) || d.id === (t && t.id)) return;
    const ws = this.ws();
    if (!ws) return;
    const groupKey = p => p.status + '|' + (ws.classMode === 'tier' ? (p.tier || '') : (p.categoryId || ''));
    let changed = false;
    if (t && groupKey(d) !== groupKey(t)) {
      d.status = t.status;
      d.doneAt = t.status === 'done' ? Date.now() : null;
      if (ws.classMode === 'tier') d.tier = t.tier; else d.categoryId = t.categoryId;
      await this.savePaper(d);
      changed = true;
    }
    if (t) await this.reorderPaper(dragId, targetId, before);
    if (changed) {
      UI.renderSidebar();
      UI.renderHome();
      Reader.refreshToolbarStatus();
    }
  },

  /* 拖到分区标题（待读/正在阅读/已完成）上：仅变更状态，保留原归类 */
  async movePaperToStatus(dragId, statusKey) {
    const d = this.paper(dragId);
    if (!d || !['reading', 'todo', 'done'].includes(statusKey) || d.status === statusKey) return;
    d.status = statusKey;
    d.doneAt = statusKey === 'done' ? Date.now() : null;
    await this.savePaper(d);
    UI.renderSidebar();
    UI.renderHome();
    Reader.refreshToolbarStatus();
    UI.toast(statusKey === 'done' ? '已移入「已完成」' : statusKey === 'reading' ? '已移入「正在阅读」' : '已退回「待读」');
  },

  importFiles(files) {
    const list = Array.from(files), wsId = this.wsId;
    const run = this._imports.then(() => this.importBatch(list, wsId));
    this._imports = run.catch(saveError);
    return this._imports;
  },

  async importBatch(files, wsId) {
    const pdfs = Array.from(files).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { UI.toast('请添加 PDF 文件', 'error'); return; }
    let ok = 0;
    for (const f of pdfs) {
      try {
        const id = uid();
        if (!this.workspaces.some(w => w.id === wsId)) throw new Error('目标工作区已删除');
        const paper = {
          id, wsId,
          title: f.name.replace(/\.pdf$/i, ''),
          fileName: f.name, size: f.size, addedAt: Date.now(),
          status: 'todo', tier: null, categoryId: null,
          progress: null, pageCount: null, lastOpenedAt: null, doneAt: null,
          order: Date.now()
        };
        await DB.batch(['blobs', 'papers', 'workspaces'], t => {
          const check = t.objectStore('workspaces').get(wsId);
          check.onsuccess = () => {
            if (!check.result) { t.abort(); return; }
            t.objectStore('blobs').put({ paperId: id, blob: f });
            t.objectStore('papers').put(paper);
          };
        });
        this.papers.push(paper);
        ok++;
      } catch (e) {
        UI.toast('导入失败：' + f.name, 'error');
      }
    }
    if (ok) {
      UI.toast('已添加 ' + ok + ' 篇文献到待读区');
      UI.renderSidebar();
      UI.renderHome();
    }
  },

  async deletePaper(id) {
    const p = this.paper(id);
    if (!p) return;
    const del = await UI.confirm('删除文献', '将永久删除「' + p.title + '」及其全部标注、笔记、卡片与对话记录，此操作不可恢复。', '删除', true);
    if (!del) return;
    return this.navigate(async () => {
      if (this.paperId === id) { await this.leaveReader(); this.paperId = null; this.view = 'home'; }
      await this.deleteRecords([id]);
      this.papers = this.papers.filter(x => x.id !== id);
      UI.render(); UI.toast('已删除');
    });
  },

  deleteRecords(ids, workspaceId, replacement) {
    const stores = ['papers', 'blobs', 'notes', 'annos', 'cards', 'chats', 'usage', 'workspaces'];
    const set = new Set(ids);
    return DB.batch(stores, t => {
      for (const name of stores.slice(0, 6)) for (const id of ids) t.objectStore(name).delete(id);
      const cursor = t.objectStore('usage').openCursor();
      cursor.onsuccess = () => { const c = cursor.result; if (!c) return; if (set.has(c.value.paperId)) c.delete(); c.continue(); };
      if (workspaceId) t.objectStore('workspaces').delete(workspaceId);
      if (replacement) t.objectStore('workspaces').put(replacement);
    });
  },

  async deleteWorkspace(id) {
    const w = this.workspaces.find(x => x.id === id);
    if (!w) return;
    const n = this.papersOf(id).length;
    const msg = n
      ? '将删除工作区「' + w.name + '」及其中 ' + n + ' 篇文献的全部数据，此操作不可恢复。'
      : '将删除工作区「' + w.name + '」，此操作不可恢复。';
    const del = await UI.confirm('删除工作区', msg, '删除', true);
    if (!del) return;
    await this._imports;
    return this.navigate(async () => {
    if (this.wsId === id) await this.leaveReader();
    const replacement = this.workspaces.length === 1 ? { id: uid(), name: '默认工作区', createdAt: Date.now(), classMode: 'tier', tiers: ['T0', 'T1', 'T2', 'T3'], categories: [] } : null;
    await this.deleteRecords(this.papersOf(id).map(p => p.id), id, replacement);
    this.papers = this.papers.filter(p => p.wsId !== id);
    this.workspaces = this.workspaces.filter(x => x.id !== id);
    if (this.wsId === id) {
      this.wsId = this.workspaces.length ? this.workspaces[0].id : null;
      this.paperId = null;
      this.view = 'home';
    }
    if (!this.workspaces.length) {
      const w2 = replacement;
      this.workspaces.push(w2);
      this.wsId = w2.id;
    }
    UI.render();
    });
  }
};
