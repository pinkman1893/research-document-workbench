/* PDF 阅读器：渲染、缩放、懒加载、进度记忆、画笔、高亮、区域选取、引用跳转 */
const Reader = {
  doc: null,
  paperId: null,
  pagesMeta: [],          // [{w,h}] scale=1
  pageEls: new Map(),     // pageNum -> el
  rendered: new Map(),    // pageNum -> {textItems, vpScale}
  gen: 0,                 // 代际计数，防止关闭后残留渲染
  scale: 1,
  fitMode: true,
  tool: 'select',
  penColor: '#44413A',
  markerColor: 'rgba(242, 214, 117, .45)',
  penColors: ['#44413A', '#6E8B7B', '#B07B62', '#7F93AC', '#9A86AC'],
  markerColors: [
    { name: '黄', css: 'rgba(242, 214, 117, .45)', dot: '#F2D675' },
    { name: '绿', css: 'rgba(188, 220, 195, .50)', dot: '#BCDCC3' },
    { name: '蓝', css: 'rgba(195, 216, 238, .50)', dot: '#C3D8EE' },
    { name: '粉', css: 'rgba(239, 201, 214, .50)', dot: '#EFC9D6' },
    { name: '橙', css: 'rgba(242, 217, 184, .50)', dot: '#F2D9B8' }
  ],
  hlColorIdx: 0,
  annos: { ink: {}, highlights: [] },
  undoStack: [],
  currentPage: 1,
  pageCount: 0,
  textCache: null,        // {text, pageTexts} 供 AI 使用
  _saveAnnosDebounced: null,
  _saveProgressDebounced: null,
  _io: null,
  _scrollAnchor: null,
  _wanted: new Set(),
  _jobs: new Map(),
  _captureJobs: new Set(),
  _annosDirty: false,
  _annosVersion: 0,

  /* ---------- 打开 / 关闭 ---------- */
  async open(paper) {
    if (this.doc && this.paperId === paper.id && !this._opening) return true;
    if (this.doc || this._loadingTask) await this.close();
    const gen = ++this.gen;
    const controller = this._docAbort = new AbortController();
    const signal = controller.signal;
    this._opening = true;
    this.paperId = paper.id;
    this.doc = null; this.pagesMeta = []; this.pageEls.clear(); this.rendered.clear();
    this.textCache = null; this.undoStack = []; this.tool = 'select';
    document.getElementById('reader-scroll').classList.remove('hand-mode', 'is-panning');
    this.currentPage = 1; this.pageCount = 0; this._textPromise = null;
    this.annos = { paperId: paper.id, ink: {}, highlights: [] };
    this._annosDirty = false;
    this._tcCache = new Map();
    this._pageHandles = new Map();
    this._renderQueue = [];
    this._rendering = new Set();
    this._jobs = new Map(); this._wanted = new Set();
    this._layoutVer = 0;
    this._pageTops = [];
    this._pageHeights = [];
    this.renderToolbar();
    document.getElementById('pages-root').innerHTML = '<div style="color:#837D71;font-size:13px;padding:60px 0">' + loaderIcon(18) + ' 正在打开…</div>';
    try {
      const [annos, rec] = await abortable(Promise.all([DB.get('annos', paper.id), DB.get('blobs', paper.id)]), signal);
      if (!rec) throw new Error('找不到 PDF 文件数据');
      const buf = await abortable(rec.blob.arrayBuffer(), signal);
      if (gen !== this.gen) throw abortError();
      this.annos = annos || this.annos;
      this.annos.ink ||= {}; this.annos.highlights ||= [];
      const task = this._loadingTask = pdfjsLib.getDocument({
        data: buf, isEvalSupported: false, enableXfa: false,
        cMapUrl: PDF_ASSET_BASE + 'cmaps/', cMapPacked: true,
        standardFontDataUrl: PDF_ASSET_BASE + 'standard_fonts/', wasmUrl: PDF_ASSET_BASE + 'wasm/',
        canvasMaxAreaInBytes: 32 * 1024 * 1024
      });
      const doc = await abortable(task.promise, signal);
      if (gen !== this.gen) throw abortError();
      this.doc = doc; this.pageCount = doc.numPages;
      const metas = new Array(doc.numPages), handles = this._pageHandles;
      let next = 1;
      await Promise.all(Array.from({ length: Math.min(4, doc.numPages) }, async () => {
        while (next <= doc.numPages) {
          const n = next++;
          const page = await abortable(doc.getPage(n), signal);
          if (gen !== this.gen) throw abortError();
          handles.set(n, page);
          const vp = page.getViewport({ scale: 1 });
          metas[n - 1] = { w: vp.width, h: vp.height };
        }
      }));
      if (gen !== this.gen) throw abortError();
      this.pagesMeta = metas;
      paper.pageCount = doc.numPages;
      await App.savePaper(paper);
      if (gen !== this.gen) throw abortError();
      const prog = paper.progress;
      this.fitMode = !prog || prog.fit !== false;
      this.scale = this.fitMode ? this.fitScale() : Math.min(4, Math.max(0.3, prog.zoom || 1));
      this.currentPage = Math.max(1, Math.min(prog?.page || 1, doc.numPages));
      this.buildPages(); this.rebuildTops();
      const sc = document.getElementById('reader-scroll');
      const el = this.pageEls.get(this.currentPage);
      sc.scrollTop = prog ? Math.max(0, el.offsetTop + (prog.ratio || 0) * el.offsetHeight - sc.clientHeight * 0.3) : 0;
      sc.scrollLeft = 0;
      this._opening = false;
      this.setupObserver(); this.onScroll(); this.renderToolbar();
      UI.renderSidebar();
      return true;
    } catch (e) {
      if (gen !== this.gen || e.name === 'AbortError') return false;
      this._opening = false;
      if (this._loadingTask) await this._loadingTask.destroy().catch(() => {});
      this._loadingTask = null; this.doc = null;
      document.getElementById('pages-root').innerHTML = '<div style="color:#A5604A;padding:60px 20px">PDF 打开失败：' + esc(e.message) + '</div>';
      return false;
    }
  },

  async close(silent) {
    this._finishGesture?.();
    await Promise.all([this.saveProgressNow(), this.saveAnnosNow()]);
    this.cancelPending();
    this._saveProgressDebounced?.cancel(); this._resizeDebounced?.cancel();
    clearTimeout(this._wheelState?.apply); clearTimeout(this._wheelState?.idle);
    if (this._wheelState) { this._wheelState.apply = null; this._wheelState.acc = 0; }
    cancelAnimationFrame(this._layoutFrame); this._layoutFrame = null;
    const task = this._loadingTask, doc = this.doc;
    this._loadingTask = null; this.doc = null;
    if (task) await task.destroy().catch(() => {});
    else if (doc) await doc.destroy().catch(() => {});
    this.paperId = null; this.pageCount = 0; this.currentPage = 1; this._opening = false;
    this.pagesMeta = []; this._pageTops = []; this._pageHeights = []; this.textCache = null; this._textPromise = null;
    this.pageEls.clear(); this.rendered.clear();
    this._tcCache = new Map(); this._pageHandles = new Map();
    this._renderQueue = []; this._rendering = new Set(); this._jobs = new Map(); this._wanted = new Set();
    document.getElementById('pages-root').innerHTML = '';
    document.getElementById('reader-toolbar').innerHTML = '';
    this.removeSelPop();
  },

  cancelPending() {
    this.gen++;
    this._docAbort?.abort();
    if (this._io) { try { this._io.disconnect(); } catch (e) {} this._io = null; }
    for (const job of this._jobs.values()) this.cancelJob(job);
    for (const job of this._captureJobs) { job.abort.abort(); job.task?.cancel(); }
    this._renderQueue = []; this._wanted.clear();
  },

  fitScale() {
    const sc = document.getElementById('reader-scroll');
    const avail = (sc.clientWidth || 800) - 56;
    const pw = this.pagesMeta.length ? this.pagesMeta[0].w : 612;
    return Math.min(2.5, Math.max(0.3, avail / pw));
  },

  /* ---------- 页面骨架 ---------- */
  buildPages() {
    const root = document.getElementById('pages-root');
    root.innerHTML = '';
    for (let i = 1; i <= this.pageCount; i++) {
      const el = document.createElement('div');
      el.className = 'pg';
      el.dataset.page = i;
      el.style.width = Math.round(this.pagesMeta[i - 1].w * this.scale) + 'px';
      el.style.height = Math.round(this.pagesMeta[i - 1].h * this.scale) + 'px';
      // 画布元素常驻复用，避免反复创建/销毁大画布
      el.innerHTML = '<div class="pg-inner">' +
        '<canvas class="pdf-canvas" width="0" height="0" style="display:none"></canvas>' +
        '<div class="hl-layer"></div>' +
        '<div class="textLayer"></div>' +
        '<canvas class="ink-layer" width="0" height="0" style="display:none;pointer-events:none"></canvas>' +
        '<div class="region-mask"></div>' +
        '</div>';
      root.appendChild(el);
      this.pageEls.set(i, el);
      this.bindPageEvents(el, i);
    }
    this.updatePageIndicator();
  },

  setupObserver() {
    if (this._io) this._io.disconnect();
    const gen = this.gen;
    this._io = new IntersectionObserver(() => {
      if (gen === this.gen) this.enqueueVisible();
    }, { root: document.getElementById('reader-scroll'), rootMargin: '250px 0px' });
    this.pageEls.forEach(el => this._io.observe(el));
  },

  /* ---------- 渲染队列（并发上限 2，避免同时分配多个大画布） ---------- */
  renderPage(n) {
    if (!this.doc || !this._wanted.has(n)) return;
    const cur = this.rendered.get(n);
    if (cur && cur.scale === this.scale) return;
    if (!this._renderQueue.includes(n)) this._renderQueue.push(n);
    this.pumpQueue();
  },

  pumpQueue() {
    while (this.doc && this._rendering.size + this._captureJobs.size < 2 && this._renderQueue.length) {
      const idx = this._renderQueue.findIndex(n => !this._rendering.has(n));
      if (idx < 0) return;
      const n = this._renderQueue.splice(idx, 1)[0];
      if (!this._wanted.has(n) || this.rendered.get(n)?.scale === this.scale) continue;
      const jobs = this._jobs, rendering = this._rendering;
      const job = { n, gen: this.gen, ver: this._layoutVer, abort: new AbortController(), task: null, textTask: null };
      jobs.set(n, job);
      this._rendering.add(n);
      this.renderOne(n, job)
        .catch(e => { if (e.name !== 'AbortError' && e.name !== 'RenderingCancelledException') console.warn('页面渲染失败', n, e); })
        .finally(() => {
          if (jobs.get(n) === job) jobs.delete(n);
          rendering.delete(n);
          if (job.gen !== this.gen) return;
          if (!this._wanted.has(n)) this._pageHandles.get(n)?.cleanup?.();
          if (job.abort.signal.aborted && this._wanted.has(n) && !this._renderQueue.includes(n)) this._renderQueue.push(n);
          this.pumpQueue();
        });
    }
  },

  cancelJob(job) {
    job.abort.abort();
    job.task?.cancel(); job.textTask?.cancel();
  },

  pixelSize(w, h, requested = window.devicePixelRatio || 1) {
    const dpr = Math.min(requested, 2, 2200 / w, 2200 / h, Math.sqrt(4500000 / (w * h)));
    return { width: Math.max(1, Math.floor(w * dpr)), height: Math.max(1, Math.floor(h * dpr)), dpr };
  },

  async renderOne(n, job) {
    const el = this.pageEls.get(n);
    if (!el || !this.doc) return;
    const live = () => !job.abort.signal.aborted && job.gen === this.gen && job.ver === this._layoutVer && this._wanted.has(n) && this.pageEls.get(n) === el;
    const check = () => { if (!live()) throw abortError(); };
    const meta = this.pagesMeta[n - 1];
    const scale = this.scale;
    const w = meta.w * scale, h = meta.h * scale;
    const size = this.pixelSize(w, h), dpr = size.dpr;
    const page = await abortable(this._getPage(n), job.abort.signal);
    check();
    const canvas = el.querySelector('canvas.pdf-canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    canvas.style.display = '';

    const viewport = page.getViewport({ scale });
    try {
      job.task = page.render({
        canvasContext: ctx, canvas: null,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      });
      await job.task.promise;
      check();
      const tl = el.querySelector('.textLayer');
      tl.innerHTML = '';
      tl.style.width = w + 'px'; tl.style.height = h + 'px';
      tl.style.setProperty('--scale-factor', scale);
      tl.style.setProperty('--total-scale-factor', scale);
      let tc;
      try {
        tc = await abortable(this._textContent(page), job.abort.signal);
        check();
        job.textTask = new pdfjsLib.TextLayer({ textContentSource: tc, container: tl, viewport });
        await abortable(job.textTask.render(), job.abort.signal);
      } catch (e) {
        check();
        console.warn('文字层不可用', n, e);
      }
      check();
      this.rendered.set(n, { scale, textItems: tc ? tc.items : [], vpScale1: page.getViewport({ scale: 1 }) });
      this.renderHighlightsFor(n);
      this.setupInkCanvas(n, el);
    } catch (e) {
      this.clearPageCanvas(el);
      throw e;
    }
  },

  _getPage(n) {
    if (!this._pageHandles.has(n)) this._pageHandles.set(n, this.doc.getPage(n));
    return this._pageHandles.get(n);
  },

  _textContent(page) {
    const pn = page.pageNumber;
    if (!this._tcCache.has(pn)) {
      const cache = this._tcCache;
      const promise = page.getTextContent().catch(e => { cache.delete(pn); throw e; });
      cache.set(pn, promise);
    }
    return this._tcCache.get(pn);
  },

  unrenderPage(n) {
    if (this._gesturePage === n) this._finishGesture?.();
    const job = this._jobs.get(n);
    if (job) this.cancelJob(job);
    const el = this.pageEls.get(n);
    if (!el) return;
    this.clearPageCanvas(el);
    this.rendered.delete(n);
    if (!job && !this._captureJobs.size) this._pageHandles.get(n)?.cleanup?.();
  },

  clearPageCanvas(el) {
    el.querySelectorAll('canvas').forEach(c => { c.style.display = 'none'; c.width = 0; c.height = 0; });
    const tl = el.querySelector('.textLayer');
    if (tl) tl.innerHTML = '';
    const hl = el.querySelector('.hl-layer');
    if (hl) hl.innerHTML = '';
  },

  /* ---------- 缩放 ---------- */
  setScale(scale, manual) {
    if (!this.doc || this._opening || !Number.isFinite(scale)) return;
    const next = Math.min(4, Math.max(0.3, scale));
    this.fitMode = !manual;
    if (Math.abs(next - this.scale) < 0.001) return;
    this.scale = next;
    this.relayout();
  },

  fitNow() { this.setScale(this.fitScale(), false); this.renderToolbar(); },

  relayout() {
    if (!this.doc || this._opening) return;
    this._finishGesture?.();
    const sc = document.getElementById('reader-scroll');
    const anchor = this._layoutFrame ? this._scrollAnchor : this._anchorInfo();
    this._scrollAnchor = anchor;
    this._layoutVer++;
    this._renderQueue = [];
    for (const n of new Set([...this.rendered.keys(), ...this._jobs.keys()])) this.unrenderPage(n);
    for (let i = 1; i <= this.pageCount; i++) {
      const pel = this.pageEls.get(i);
      const m = this.pagesMeta[i - 1];
      pel.style.width = Math.round(m.w * this.scale) + 'px';
      pel.style.height = Math.round(m.h * this.scale) + 'px';
    }

    cancelAnimationFrame(this._layoutFrame);
    const gen = this.gen;
    this._layoutFrame = requestAnimationFrame(() => {
      this._layoutFrame = null;
      if (gen !== this.gen || !this.doc) return;
      this.rebuildTops();
      const ael = this.pageEls.get(anchor.page);
      if (ael) sc.scrollTop = Math.max(0, ael.offsetTop + anchor.ratio * ael.offsetHeight - sc.clientHeight * 0.3);
      this.enqueueVisible(anchor.page);   // 锚点页优先渲染
      this.currentPage = this._pageAt(sc.scrollTop + sc.clientHeight * 0.3) || 1;
      this.updatePageIndicator();
      this.renderToolbar();
    });
    this.saveProgress();
  },

  /* 缓存页面纵坐标，滚动/缩放不再逐帧触发布局 */
  rebuildTops() {
    this._pageTops = [];
    this._pageHeights = [];
    for (let i = 1; i <= this.pageCount; i++) {
      const el = this.pageEls.get(i);
      this._pageTops.push(el ? el.offsetTop : 0);
      this._pageHeights.push(Math.round(this.pagesMeta[i - 1].h * this.scale));
    }
  },

  _pageAt(st) {
    const tops = this._pageTops, heights = this._pageHeights;
    if (!tops.length) return null;
    let lo = 0, hi = this.pageCount - 1, cur = this.pageCount;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + heights[mid] > st) { cur = mid + 1; hi = mid - 1; }
      else lo = mid + 1;
    }
    return cur;
  },

  _anchorInfo() {
    const sc = document.getElementById('reader-scroll');
    const st = sc.scrollTop + sc.clientHeight * 0.3;
    const n = this._pageAt(st) || this.currentPage || 1;
    let ratio = 0.3;
    const top = this._pageTops[n - 1], h = this._pageHeights[n - 1];
    if (top != null && h) ratio = Math.min(1, Math.max(0, (st - top) / h));
    return { page: n, ratio };
  },

  _visiblePages() {
    const sc = document.getElementById('reader-scroll');
    const top = sc.scrollTop - 250, bottom = sc.scrollTop + sc.clientHeight + 250;
    const out = [];
    for (let i = this._pageAt(top) || 1; i <= this.pageCount; i++) {
      const t = this._pageTops[i - 1], h = this._pageHeights[i - 1];
      if (t >= bottom) break;
      if (t + h > top && t < bottom) out.push(i);
    }
    return out;
  },

  enqueueVisible(priority) {
    if (!this.doc || this._opening || this._layoutFrame) return;
    const vis = this._visiblePages();
    const p = priority || (vis[0] || 1);
    vis.sort((a, b) => Math.abs(a - p) - Math.abs(b - p));
    this._wanted = new Set(vis.slice(0, 8));
    this._renderQueue = this._renderQueue.filter(n => this._wanted.has(n));
    for (const n of new Set([...this.rendered.keys(), ...this._jobs.keys()])) {
      if (!this._wanted.has(n)) this.unrenderPage(n);
    }
    for (const n of this._wanted) this.renderPage(n);
  },

  onResize() {
    if (!this.doc || App.view !== 'reader') return;
    if (this.fitMode) {
      this._resizeDebounced = this._resizeDebounced || debounce(() => { if (this.doc && this.fitMode) this.setScale(this.fitScale(), false); }, 180);
      this._resizeDebounced();
    }
  },

  /* ---------- 工具栏 ---------- */
  renderToolbar() {
    const p = App.paper();
    if (!p || !this.paperId) return;
    const tb = document.getElementById('reader-toolbar');
    const tool = (name, title, id) =>
      '<button class="ibtn tool-btn' + (this.tool === id ? ' active' : '') + '" data-tool="' + id + '" title="' + title + '">' + icon(name, 17) +
      ((id === 'pen' && this.tool !== 'pen') || (id === 'marker' && this.tool !== 'marker') ? '' : '') + '</button>';

    let colorDot = '';
    if (this.tool === 'pen') colorDot = '<i class="tool-color-dot" style="background:' + this.penColor + '"></i>';
    if (this.tool === 'marker') colorDot = '<i class="tool-color-dot" style="background:' + this.markerColors[this.hlColorIdx].dot + '"></i>';
    const toolBtnHtml = (name, label, title, id) => {
      const active = this.tool === id;
      return '<button class="ibtn tool-btn' + (active ? ' active' : '') + '" data-tool="' + id + '" aria-label="' + label + '" aria-pressed="' + active + '" title="' + title + '">' + icon(name, 17) +
        (colorDot && active ? colorDot : '') + '</button>';
    };

    tb.innerHTML =
      '<button class="rt-back" id="rt-back" aria-label="返回文献库" title="返回文献库">' + icon('chevron-left', 19) + '</button>' +
      '<div class="rt-title-wrap"><div class="rt-title">' + esc(p.title) + '</div>' +
      '<div class="rt-status"><span>' + (p.status === 'done' ? '已完成' : p.status === 'reading' ? '正在阅读' : '待读') + '</span>' +
      '<span id="rt-pageinfo">P' + this.currentPage + (this.pageCount ? ' / ' + this.pageCount : '') + '</span></div></div>' +

      '<div class="rt-center">' +
      '<div class="page-nav">' +
      '<button class="ibtn" id="pg-prev" aria-label="上一页" title="上一页">' + icon('chevron-up', 16) + '</button>' +
      '<span class="page-ind"><input id="pg-input" aria-label="页码" value="' + this.currentPage + '" inputmode="numeric"> / ' + (this.pageCount || '?') + '</span>' +
      '<button class="ibtn" id="pg-next" aria-label="下一页" title="下一页">' + icon('chevron-down', 16) + '</button>' +
      '</div>' +
      '<span class="rt-divider"></span>' +
      '<button class="ibtn" id="zoom-out" aria-label="缩小" title="缩小">' + icon('zoom-out', 16) + '</button>' +
      '<span class="zoom-label">' + Math.round(this.scale * 100) + '%</span>' +
      '<button class="ibtn" id="zoom-in" aria-label="放大" title="放大">' + icon('zoom-in', 16) + '</button>' +
      '<button class="ibtn' + (this.fitMode ? ' active' : '') + '" id="zoom-fit" aria-label="适宽" aria-pressed="' + this.fitMode + '" title="适宽">' + icon('fit-width', 16) + '</button>' +
      '<span class="rt-divider"></span>' +
      '<button class="ibtn tool-btn' + (this.tool === 'select' ? ' active' : '') + '" data-tool="select" aria-label="选择文本" aria-pressed="' + (this.tool === 'select') + '" title="选择文本">' + icon('mouse-pointer', 16) + '</button>' +
      '<button class="ibtn tool-btn' + (this.tool === 'hand' ? ' active' : '') + '" data-tool="hand" aria-label="小手拖拽" aria-pressed="' + (this.tool === 'hand') + '" title="小手拖拽：按住鼠标拖动页面">' + icon('hand', 17) + '</button>' +
      toolBtnHtml('pencil', '画笔', '画笔（按住涂抹，再点一下换色）', 'pen') +
      toolBtnHtml('highlighter', '荧光笔', '荧光笔（划选句子高亮，再点一下换色）', 'marker') +
      toolBtnHtml('eraser', '橡皮擦', '橡皮擦', 'eraser') +
      toolBtnHtml('box-select', '框选区域提问', '框选区域提问', 'region') +
      '<button class="ibtn" id="ink-undo" aria-label="撤销标注 (Ctrl+Z)" title="撤销标注 (Ctrl+Z)">' + icon('undo', 16) + '</button>' +
      '</div>' +

      '<div class="rt-right">' +
      '<button class="ibtn' + (document.getElementById('app').classList.contains('rp-collapsed') ? '' : ' active') + '" id="rt-panel-toggle" aria-label="显示 / 隐藏 AI 面板" aria-pressed="' + !document.getElementById('app').classList.contains('rp-collapsed') + '" title="显示 / 隐藏 AI 面板">' + icon('panel-right', 16) + '</button>' +
      (p.status === 'done'
        ? '<span class="btn-done is-done">' + icon('circle-check', 14) + ' 已完成</span>'
        : '<button class="btn-done" id="btn-mark-done">' + icon('circle-check', 14) + ' 阅读完成</button>') +
      '<button class="ibtn" id="rt-menu" aria-label="文献操作" title="文献操作">' + icon('more', 17) + '</button>' +
      '</div>';

    tb.querySelector('#rt-back').addEventListener('click', () => App.closePaper());
    tb.querySelector('#pg-prev').addEventListener('click', () => this.scrollToPage(this.currentPage - 1));
    tb.querySelector('#pg-next').addEventListener('click', () => this.scrollToPage(this.currentPage + 1));
    const pgInput = tb.querySelector('#pg-input');
    pgInput.addEventListener('change', () => {
      const n = parseInt(pgInput.value, 10);
      if (n >= 1 && n <= this.pageCount) this.scrollToPage(n);
      else pgInput.value = this.currentPage;
    });
    tb.querySelector('#zoom-in').addEventListener('click', () => this.setScale(this.scale * 1.15, true));
    tb.querySelector('#zoom-out').addEventListener('click', () => this.setScale(this.scale / 1.15, true));
    tb.querySelector('#zoom-fit').addEventListener('click', () => this.fitNow());
    tb.querySelector('#ink-undo').addEventListener('click', () => this.undo());
    const md = tb.querySelector('#btn-mark-done');
    if (md) md.addEventListener('click', async () => {
      await App.setStatus(this.paperId, 'done');
      UI.toast('已归档至「已完成」，记录已全部保留');
    });
    tb.querySelector('#rt-panel-toggle').addEventListener('click', () => {
      document.getElementById('app').classList.toggle('rp-collapsed');
      UI.syncPanels();
      setTimeout(() => { Reader.onResize(); Reader.renderToolbar(); }, 300);
    });
    tb.querySelector('#rt-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      UI.paperMenu(e.currentTarget, this.paperId);
    });
    tb.querySelectorAll('.tool-btn').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = b.dataset.tool;
        if (t === this.tool && (t === 'pen' || t === 'marker')) {
          this.colorMenu(e, t);   // 再次点击已选中的画笔/荧光笔 = 换颜色
          return;
        }
        this.setTool(t === this.tool ? 'select' : t);
      });
      if (b.dataset.tool === 'pen' || b.dataset.tool === 'marker') {
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.colorMenu(e, b.dataset.tool); });
      }
    });
  },

  refreshToolbarStatus() {
    if (App.view === 'reader' && this.paperId) this.renderToolbar();
  },

  setTool(t) {
    this._finishGesture?.();
    this.tool = t;
    document.getElementById('reader-scroll').classList.toggle('hand-mode', t === 'hand');
    // pen/eraser = 自由绘制；marker = 划选文字高亮（保留文本可选）；region = 框选截图
    const freehand = t === 'pen' || t === 'eraser';
    this.pageEls.forEach((el, n) => {
      el.classList.toggle('noselect', freehand);
      el.classList.toggle('region-mode', t === 'region');
      const ink = el.querySelector('canvas.ink-layer');
      if (this.rendered.has(n)) this.setupInkCanvas(n, el);
      if (ink) {
        ink.classList.toggle('draw', t === 'pen');
        ink.classList.toggle('erase', t === 'eraser');
        ink.style.pointerEvents = freehand ? 'auto' : 'none';
      }
      const mask = el.querySelector('.region-mask');
      if (mask) mask.style.display = t === 'region' ? 'block' : 'none';
    });
    this.removeSelPop();
    this.renderToolbar();
    if (t === 'pen') UI.toast('在页面上按住涂抹即可绘制；再次点击画笔按钮可换颜色');
    if (t === 'marker') UI.toast('在正文上划选句子即可高亮；再次点击荧光笔按钮可换颜色');
    if (t === 'region') UI.toast('在页面上框选区域，截图将送入 AI 对话');
  },

  colorMenu(e, tool) {
    const colors = tool === 'pen' ? this.penColors : this.markerColors;
    const cur = tool === 'pen' ? this.penColor : this.markerColors[this.hlColorIdx].css;
    this.closeColorPop && this.closeColorPop();
    const pop = document.createElement('div');
    pop.className = 'ctx-menu';
    pop.style.padding = '10px';
    pop.style.display = 'flex';
    pop.style.gap = '8px';
    pop.innerHTML = colors.map((c, i) => {
      const color = tool === 'pen' ? c : c.dot;
      const active = tool === 'pen' ? this.penColor === c : this.hlColorIdx === i;
      return '<button class="swatch" data-i="' + i + '" style="width:24px;height:24px;background:' + color + ';border-radius:8px;' + (active ? 'outline:2px solid var(--accent-deep);outline-offset:2px' : '') + '" title="' + esc(tool === 'pen' ? '墨色 ' + (i + 1) : c.name + '荧光') + '"></button>';
    }).join('');
    const layer = document.getElementById('ctx-layer');
    layer.style.pointerEvents = 'auto';
    layer.appendChild(pop);
    this.closeColorPop = () => { pop.remove(); UI.closeCtx(); };
    layer.onclick = () => { this.closeColorPop(); };

    // 以鼠标事件坐标定位，出现在按钮附近而非窗口角落
    const ev = e && e.clientX != null ? e : null;
    let x = ev ? ev.clientX : 8;
    let y = ev ? ev.clientY + 12 : 8;
    x = Math.min(x, innerWidth - pop.offsetWidth - 12);
    y = Math.min(y, innerHeight - pop.offsetHeight - 12);
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = Math.max(8, y) + 'px';

    pop.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', (e2) => {
      e2.stopPropagation();
      const i = +s.dataset.i;
      if (tool === 'pen') this.penColor = this.penColors[i]; else this.hlColorIdx = i;
      this.closeColorPop(); this.renderToolbar();
    }));
  },

  updatePageIndicator() {
    const el = document.getElementById('pg-input');
    if (el) el.value = this.currentPage;
    const pi = document.getElementById('rt-pageinfo');
    if (pi) pi.textContent = 'P' + this.currentPage + (this.pageCount ? ' / ' + this.pageCount : '');
  },

  scrollToPage(n) {
    n = Math.max(1, Math.min(this.pageCount || 1, n));
    const el = this.pageEls.get(n);
    const sc = document.getElementById('reader-scroll');
    if (el && sc) sc.scrollTo({ top: el.offsetTop - 14, behavior: 'smooth' });
    this.currentPage = n;
    this.updatePageIndicator();
  },

  /* ---------- 滚动 / 进度 ---------- */
  onScroll() {
    if (!this.doc || this._opening || this._layoutFrame) return;
    const sc = document.getElementById('reader-scroll');
    const st = sc.scrollTop + sc.clientHeight * 0.3;
    const n = this._pageAt(st);
    if (n && n !== this.currentPage) {
      this.currentPage = n;
      this.updatePageIndicator();
    }
    this.enqueueVisible(n);
    this.saveProgress();
  },

  saveProgress() {
    if (!this._saveProgressDebounced) {
      this._saveProgressDebounced = debounce(() => this.saveProgressNow().catch(saveError), 400);
    }
    this._saveProgressDebounced();
  },

  async saveProgressNow() {
    const p = App.paper(this.paperId);
    if (!p || !this.doc || this._opening || this._layoutFrame) return;
    const sc = document.getElementById('reader-scroll');
    const el = this.pageEls.get(this.currentPage);
    let ratio = 0;
    if (el && el.offsetHeight) ratio = Math.min(1, Math.max(0, (sc.scrollTop + sc.clientHeight * 0.3 - el.offsetTop) / el.offsetHeight));
    p.progress = { page: this.currentPage, ratio: +ratio.toFixed(4), fit: this.fitMode, zoom: +this.scale.toFixed(4), ts: Date.now() };
    await App.savePaper(p);
  },

  /* ---------- 页面事件（选区/画笔/区域框选） ---------- */
  bindPageEvents(el, n) {
    const sc = document.getElementById('reader-scroll');

    // One container listener also covers the gaps between pages; panning never re-renders the PDF.
    if (!this._panBound) {
      this._panBound = true;
      sc.addEventListener('pointerdown', e => {
        if (this.tool !== 'hand' || !this.doc || this._opening || e.button !== 0 || !e.isPrimary || this._finishGesture) return;
        if (e.target.closest('button, a, input, textarea')) return;
        const bounds = sc.getBoundingClientRect();
        if (e.clientX >= bounds.left + sc.clientWidth || e.clientY >= bounds.top + sc.clientHeight) return;
        e.preventDefault(); e.stopPropagation();
        getSelection()?.removeAllRanges(); this.removeSelPop(); this._gesturePage = null;
        const start = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
        const move = ev => {
          if (ev.pointerId !== e.pointerId) return;
          ev.preventDefault();
          sc.scrollLeft = start.left - (ev.clientX - start.x);
          sc.scrollTop = start.top - (ev.clientY - start.y);
        };
        const finish = ev => {
          if (ev?.pointerId != null && ev.pointerId !== e.pointerId) return;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
          window.removeEventListener('blur', finish); sc.removeEventListener('lostpointercapture', finish);
          sc.classList.remove('is-panning'); this._finishGesture = null;
          if (sc.hasPointerCapture(e.pointerId)) sc.releasePointerCapture(e.pointerId);
        };
        this._finishGesture = finish; sc.classList.add('is-panning');
        sc.setPointerCapture(e.pointerId);
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
        window.addEventListener('blur', finish); sc.addEventListener('lostpointercapture', finish);
      }, { capture: true });
    }

    // 文本选择：select 工具出浮条；marker 工具直接按当前颜色高亮（只绑定一次）
    if (!this._selBound) {
      this._selBound = true;
      document.addEventListener('mouseup', (e) => {
        if (App.view !== 'reader') return;
        if (this.tool === 'marker') { setTimeout(() => this.markerHighlight(), 10); return; }
        if (this.tool === 'select') setTimeout(() => this.maybeShowSelPop(e), 10);
      });
    }

    // Ctrl+滚轮缩放：只绑定一次（此前逐页绑定导致 N 个监听器叠加触发，一次滚轮引发 N 次重排，直接卡死）
    if (!this._wheelBound) {
      this._wheelBound = true;
      const z = this._wheelState = { acc: 0, idle: null, apply: null };
      sc.addEventListener('wheel', (e) => {
        if (!e.ctrlKey || !this.doc || this._opening) return;
        e.preventDefault();
        clearTimeout(z.idle);
        z.acc += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1);
        z.idle = setTimeout(() => { z.acc = 0; }, 180);
        if (z.apply) return;                      // 手势只调度一次应用
        z.apply = setTimeout(() => {
          z.apply = null;
          if (!this.doc || Math.abs(z.acc) < 1) return;
          const steps = Math.max(-3, Math.min(3, -z.acc / 120));
          z.acc = 0;
          this.setScale(this.scale * Math.pow(1.12, steps), true);
        }, 50);
      }, { passive: false });
    }

    // 区域框选
    const mask = el.querySelector('.region-mask');
    mask.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'region' || this._finishGesture) return;
      e.preventDefault();
      const gen = this.gen;
      this._gesturePage = n;
      const wrap = el.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const box = document.createElement('div');
      box.className = 'region-box';
      el.querySelector('.pg-inner').appendChild(box);
      const move = (ev) => {
        const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY);
        const x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
        box.style.left = (x1 - wrap.left) + 'px';
        box.style.top = (y1 - wrap.top) + 'px';
        box.style.width = (x2 - x1) + 'px';
        box.style.height = (y2 - y1) + 'px';
      };
      const up = async (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        this._finishGesture = null;
        const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY);
        const x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
        box.remove();
        if (x2 - x1 < 12 || y2 - y1 < 12) return;
        const rect = {
          x: (x1 - wrap.left) / wrap.width, y: (y1 - wrap.top) / wrap.height,
          w: (x2 - x1) / wrap.width, h: (y2 - y1) / wrap.height
        };
        const dataUrl = await this.captureRegion(n, rect);
        if (dataUrl && gen === this.gen) {
          AI.attachImage(dataUrl);
          this.setTool('select');
          UI.toast('已截取区域，可在右侧 AI 对话中提问');
        }
      };
      const cancel = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel); box.remove(); this._finishGesture = null;
      };
      this._finishGesture = cancel;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
  },

  async captureRegion(n, rect) {
    const gen = this.gen, doc = this.doc;
    if (!doc || this._captureJobs.size) { UI.toast('正在截取，请稍候'); return null; }
    const job = { abort: new AbortController(), task: null };
    this._captureJobs.add(job);
    const cancel = () => { job.abort.abort(); job.task?.cancel(); };
    this._docAbort.signal.addEventListener('abort', cancel, { once: true });
    const docSignal = this._docAbort.signal;
    let c;
    try {
      // 与页面渲染共用最多两个任务的额度，截图只分配裁剪区域。
      while (this._rendering.size > 1) await abortable(new Promise(r => setTimeout(r, 16)), job.abort.signal);
      const page = await abortable(this._getPage(n), job.abort.signal);
      if (gen !== this.gen) throw abortError();
      const x1 = Math.max(0, rect.x), y1 = Math.max(0, rect.y);
      const x2 = Math.min(1, rect.x + rect.w), y2 = Math.min(1, rect.y + rect.h);
      if (x2 <= x1 || y2 <= y1) return null;
      const outScale = Math.min(3, Math.max(1.6, this.scale * 1.8));
      const vp = page.getViewport({ scale: outScale });
      const w = (x2 - x1) * vp.width, h = (y2 - y1) * vp.height;
      const size = this.pixelSize(w, h, 1);
      if (size.width < 4 || size.height < 4) return null;
      c = document.createElement('canvas'); c.width = size.width; c.height = size.height;
      job.task = page.render({ canvas: c, viewport: vp, transform: [size.dpr, 0, 0, size.dpr, -x1 * vp.width * size.dpr, -y1 * vp.height * size.dpr] });
      await job.task.promise;
      if (gen !== this.gen || job.abort.signal.aborted) throw abortError();
      return c.toDataURL('image/png');
    } catch (e) {
      if (e.name !== 'AbortError' && e.name !== 'RenderingCancelledException') UI.toast('截取失败：' + e.message, 'error');
      return null;
    } finally {
      if (c) { c.width = 0; c.height = 0; }
      docSignal.removeEventListener('abort', cancel);
      this._captureJobs.delete(job); this.pumpQueue();
    }
  },

  /* ---------- 选中浮条 ---------- */
  /* 荧光笔工具：划选后直接以当前颜色高亮，不弹浮条 */
  markerHighlight() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const anchor = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const tl = anchor ? anchor.closest('.textLayer') : null;
    if (!tl) return;
    const text = sel.toString().trim();
    if (!text || text.length > 2000) return;
    const pgEl = tl.closest('.pg');
    this.addHighlight(+pgEl.dataset.page, range, pgEl, this.hlColorIdx, text);
  },

  maybeShowSelPop(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { this.removeSelPop(); return; }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const tl = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.textLayer');
    if (!tl) { this.removeSelPop(); return; }
    const text = sel.toString().trim();
    if (!text || text.length > 2000) { this.removeSelPop(); return; }
    const pgEl = tl.closest('.pg');
    const page = +pgEl.dataset.page;

    // 是否与已有高亮重叠
    const wrapRect = pgEl.getBoundingClientRect();
    const selRects = Array.from(range.getClientRects());
    const overlap = this.annos.highlights.find(h =>
      h.page === page && selRects.some(sr => h.rects.some(r =>
        !(sr.right < wrapRect.left + r.x * wrapRect.width || sr.left > wrapRect.left + (r.x + r.w) * wrapRect.width ||
          sr.bottom < wrapRect.top + r.y * wrapRect.height || sr.top > wrapRect.top + (r.y + r.h) * wrapRect.height))));

    this.removeSelPop();
    const pop = document.createElement('div');
    pop.className = 'sel-pop';
    let html = this.markerColors.map((c, i) =>
      '<button class="swatch" data-ci="' + i + '" style="background:' + c.dot + '" title="' + c.name + '高亮"></button>').join('');
    if (overlap) html += '<button class="sel-act" data-act="unhl">' + icon('eraser', 13) + '取消高亮</button>';
    html += '<button class="sel-act" data-act="copy">' + icon('copy', 13) + '复制</button>';
    html += '<button class="sel-act" data-act="ask">' + icon('sparkles', 13) + '问 AI</button>';
    pop.innerHTML = html;
    document.body.appendChild(pop);

    const r = selRects[selRects.length - 1] || range.getBoundingClientRect();
    let x = r.left + r.width / 2 - pop.offsetWidth / 2;
    let y = r.bottom + 8;
    x = Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8));
    if (y + 40 > innerHeight) y = r.top - 44;
    pop.style.left = x + 'px'; pop.style.top = y + 'px';

    pop.querySelectorAll('.swatch').forEach(b => b.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      this.addHighlight(page, range, pgEl, +b.dataset.ci, text);
    }));
    const act = (name, fn) => {
      const b = pop.querySelector('[data-act="' + name + '"]');
      if (b) b.addEventListener('mousedown', (ev) => { ev.preventDefault(); fn(); });
    };
    act('unhl', () => { this.removeHighlight(overlap.id); window.getSelection().removeAllRanges(); this.removeSelPop(); });
    act('copy', () => {
      navigator.clipboard && navigator.clipboard.writeText(text).then(() => UI.toast('已复制'));
      this.removeSelPop();
    });
    act('ask', () => {
      AI.attachQuote(text, page);
      window.getSelection().removeAllRanges();
      this.removeSelPop();
    });
    // 点击别处关闭
    const close = (ev) => { if (!pop.contains(ev.target)) { this.removeSelPop(); } };
    setTimeout(() => document.addEventListener('mousedown', close, { once: true }), 0);
  },

  removeSelPop() {
    document.querySelectorAll('.sel-pop').forEach(p => p.remove());
  },

  /* ---------- 文字高亮 ---------- */
  addHighlight(page, range, pgEl, colorIdx, text) {
    const wrapRect = pgEl.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter(r => r.width > 1 && r.height > 1)
      .map(r => ({
        x: +((r.left - wrapRect.left) / wrapRect.width).toFixed(4),
        y: +((r.top - wrapRect.top) / wrapRect.height).toFixed(4),
        w: +(r.width / wrapRect.width).toFixed(4),
        h: +(r.height / wrapRect.height).toFixed(4)
      }));
    if (!rects.length) return;
    const hl = { id: uid(), page, colorIdx, rects, text, createdAt: Date.now() };
    this.annos.highlights.push(hl);
    this.undoStack.push({ type: 'highlight-add', highlight: hl });
    this.renderHighlightsFor(page);
    window.getSelection().removeAllRanges();
    this.removeSelPop();
    this.saveAnnos();
    Notes.refreshHighlights();
  },

  removeHighlight(id) {
    const highlight = this.annos.highlights.find(h => h.id === id);
    if (highlight) this.undoStack.push({ type: 'highlight-del', highlight });
    this.annos.highlights = this.annos.highlights.filter(h => h.id !== id);
    this.renderHighlightsFor();
    this.saveAnnos();
    Notes.refreshHighlights();
  },

  renderHighlightsFor(onlyPage) {
    const pages = onlyPage ? [onlyPage] : [...this.pageEls.keys()];
    for (const n of pages) {
      const el = this.pageEls.get(n);
      if (!el || !this.rendered.has(n)) continue;
      const layer = el.querySelector('.hl-layer');
      layer.innerHTML = '';
      const w = el.offsetWidth, h = el.offsetHeight;
      this.annos.highlights.filter(x => x.page === n).forEach(x => {
        x.rects.forEach(r => {
          const d = document.createElement('div');
          d.className = 'hl-box';
          d.style.cssText = 'left:' + (r.x * w) + 'px;top:' + (r.y * h) + 'px;width:' + (r.w * w) + 'px;height:' + (r.h * h) +
            'px;background:' + this.markerColors[x.colorIdx % this.markerColors.length].css + ';';
          d.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hlClickMenu(e, x);
          });
          layer.appendChild(d);
        });
      });
    }
  },

  hlClickMenu(e, hl) {
    const items = [
      { key: 'copy', label: '复制文本', icon: 'copy', action: () => { navigator.clipboard && navigator.clipboard.writeText(hl.text).then(() => UI.toast('已复制')); } },
      { key: 'ask', label: '问 AI', icon: 'sparkles', action: () => AI.attachQuote(hl.text, hl.page) },
      '-',
      { key: 'del', label: '删除此高亮', icon: 'trash', danger: true, action: () => this.removeHighlight(hl.id) }
    ];
    UI.openCtx(e.currentTarget, items, { x: e.clientX, y: e.clientY + 6 });
    // openCtx 需要 anchor 有 rect；改用坐标模式
  },

  /* ---------- 画笔 ---------- */
  setupInkCanvas(n, el) {
    const meta = this.pagesMeta[n - 1];
    const ink = el.querySelector('canvas.ink-layer');
    const needed = (this.annos.ink[n]?.length || 0) > 0 || this.tool === 'pen';
    const size = this.pixelSize(meta.w * this.scale, meta.h * this.scale);
    ink._dpr = size.dpr;
    if (ink.width !== (needed ? size.width : 0) || ink.height !== (needed ? size.height : 0)) {
      ink.width = needed ? size.width : 0; ink.height = needed ? size.height : 0;
    }
    ink.style.display = needed ? '' : 'none';
    ink.style.width = Math.round(meta.w * this.scale) + 'px';
    ink.style.height = Math.round(meta.h * this.scale) + 'px';
    ink.style.pointerEvents = (this.tool === 'pen' || this.tool === 'eraser') ? 'auto' : 'none';
    ink.classList.toggle('draw', this.tool === 'pen');
    ink.classList.toggle('erase', this.tool === 'eraser');
    this.redrawInk(n);
    if (ink.dataset.bound) return;
    ink.dataset.bound = '1';

    ink.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'pen' && this.tool !== 'eraser') return;
      if (this._finishGesture) return;
      this._gesturePage = n;
      e.preventDefault();
      ink.setPointerCapture(e.pointerId);
      const wrapRect = el.getBoundingClientRect();
      const strokes = this.annos.ink[n] || (this.annos.ink[n] = []);
      if (this.tool === 'eraser') {
        const removed = new Map();
        const erase = ev => { for (const s of this.eraseAt(n, strokes, ev, wrapRect) || []) removed.set(s.id, s); };
        erase(e);
        const move = (ev) => {
          erase(ev);
        };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          this._finishGesture = null;
          if (removed.size) { this.undoStack.push({ type: 'del', page: n, strokes: [...removed.values()] }); this.saveAnnos(); }
        };
        this._finishGesture = up;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return;
      }
      const isPen = this.tool === 'pen';
      const stroke = {
        id: uid(), tool: isPen ? 'pen' : 'pen',
        color: this.penColor,
        size: 2.2,
        pts: [[(e.clientX - wrapRect.left) / wrapRect.width, (e.clientY - wrapRect.top) / wrapRect.height, e.pressure || 0.5]]
      };
      strokes.push(stroke);
      const ctx = ink.getContext('2d');
      const drawSeg = (a, b) => this.drawSeg(ctx, stroke, a, b, ink, ink._dpr);
      const move = (ev) => {
        const p = [(ev.clientX - wrapRect.left) / wrapRect.width, (ev.clientY - wrapRect.top) / wrapRect.height, ev.pressure || 0.5];
        drawSeg(stroke.pts[stroke.pts.length - 1], p);
        stroke.pts.push(p);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this._finishGesture = null;
        if (stroke.pts.length < 2) { this.annos.ink[n] = strokes.filter(s => s !== stroke); this.redrawInk(n); return; }
        this.undoStack.push({ type: 'add', page: n, stroke });
        this.saveAnnos();
      };
      this._finishGesture = up;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  },

  drawSeg(ctx, stroke, a, b, inkCanvas, dpr) {
    const w = inkCanvas.width, h = inkCanvas.height;
    const ax = a[0] * w, ay = a[1] * h, bx = b[0] * w, by = b[1] * h;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (stroke.tool === 'marker') {
      ctx.globalAlpha = 0.42;
      ctx.strokeStyle = this.markerColors[stroke.color % this.markerColors.length].dot;
      ctx.lineWidth = stroke.size * this.scale * dpr;
    } else {
      ctx.strokeStyle = stroke.color;
      const pr = ((a[2] + b[2]) / 2);
      ctx.lineWidth = stroke.size * (0.6 + pr * 0.9) * this.scale * dpr;
    }
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  },

  redrawInk(n) {
    const el = this.pageEls.get(n);
    if (!el) return;
    const ink = el.querySelector('canvas.ink-layer');
    if (!ink || !ink.width) return;
    const ctx = ink.getContext('2d');
    ctx.clearRect(0, 0, ink.width, ink.height);
    const strokes = this.annos.ink[n] || [];
    const dpr = ink._dpr || 1;
    for (const s of strokes) {
      for (let i = 1; i < s.pts.length; i++) this.drawSeg(ctx, s, s.pts[i - 1], s.pts[i], ink, dpr);
      if (s.pts.length === 1) this.drawSeg(ctx, s, s.pts[0], s.pts[0], ink, dpr);
    }
  },

  eraseAt(n, strokes, ev, wrapRect) {
    strokes = this.annos.ink[n] || [];
    const nx = (ev.clientX - wrapRect.left) / wrapRect.width;
    const ny = (ev.clientY - wrapRect.top) / wrapRect.height;
    const thrX = 10 / wrapRect.width, thrY = 10 / wrapRect.height;
    const removed = strokes.filter(s => s.pts.some(p => Math.abs(p[0] - nx) < thrX && Math.abs(p[1] - ny) < thrY));
    if (!removed.length) return null;
    const set = new Set(removed);
    this.annos.ink[n] = strokes.filter(s => !set.has(s));
    this.redrawInk(n);
    return removed;
  },

  undo() {
    const op = this.undoStack.pop();
    if (!op) { UI.toast('没有可撤销的标注'); return; }
    if (op.type === 'highlight-add') {
      this.annos.highlights = this.annos.highlights.filter(h => h.id !== op.highlight.id);
      this.renderHighlightsFor(op.highlight.page); Notes.refreshHighlights();
    } else if (op.type === 'highlight-del') {
      this.annos.highlights.push(op.highlight);
      this.renderHighlightsFor(op.highlight.page); Notes.refreshHighlights();
    } else if (op.type === 'add') {
      const arr = this.annos.ink[op.page];
      if (arr) {
        const i = arr.indexOf(op.stroke);
        if (i >= 0) arr.splice(i, 1);
        this.redrawInk(op.page);
      }
    } else if (op.type === 'del') {
      const arr = this.annos.ink[op.page] || (this.annos.ink[op.page] = []);
      arr.push(...op.strokes);
      this.redrawInk(op.page);
    }
    this.saveAnnos();
  },

  saveAnnos() {
    this._annosDirty = true; this._annosVersion++;
    this.saveAnnosNow().catch(saveError);
  },

  async saveAnnosNow() {
    if (!this.paperId || !this._annosDirty) return this._annosSave;
    const paperId = this.paperId, version = this._annosVersion;
    const record = structuredClone({ ...this.annos, paperId, updatedAt: Date.now() });
    const saving = DB.put('annos', record);
    this._annosSave = saving;
    await saving;
    if (paperId === this.paperId && version === this._annosVersion) this._annosDirty = false;
  },

  /* ---------- 引用跳转（AI 锚点） ---------- */
  async jumpTo(page, snippet) {
    const gen = this.gen;
    page = Math.max(1, Math.min(this.pageCount, page | 0));
    await this.scrollToPageAndWait(page);
    if (!snippet) return;
    // 等页面渲染完成
    for (let i = 0; i < 30; i++) {
      if (gen !== this.gen) return;
      if (this.rendered.has(page) && this.rendered.get(page).textItems) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (gen === this.gen) this.highlightSnippet(page, snippet);
  },

  async scrollToPageAndWait(n) {
    const el = this.pageEls.get(n);
    const sc = document.getElementById('reader-scroll');
    if (el && sc) sc.scrollTop = el.offsetTop - 14;
    this.currentPage = n;
    this.updatePageIndicator();
    this.enqueueVisible(n);
  },

  highlightSnippet(page, snippet) {
    const info = this.rendered.get(page);
    const el = this.pageEls.get(page);
    if (!info || !info.textItems || !el) return;
    const norm = s => s.replace(/\s+/g, '');
    const target = norm(snippet).slice(0, 40);
    if (!target) return;

    // 拼接页面文本并记录 item 边界
    let full = '';
    const bounds = [];
    for (const it of info.textItems) {
      if (!it.str) continue;
      bounds.push({ start: full.length, end: full.length + norm(it.str).length, item: it });
      full += norm(it.str);
    }
    let idx = full.indexOf(target.slice(0, 12));
    if (idx < 0) { // 找不到就整页顶部闪一下
      this.flashPage(page);
      return;
    }
    const hit = bounds.filter(b => b.end > idx && b.start < idx + target.length);
    if (!hit.length) { this.flashPage(page); return; }

    const vp1 = info.vpScale1;
    const layer = el.querySelector('.pg-inner');
    const W = el.offsetWidth, H = el.offsetHeight;
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const b of hit) {
      const t = b.item.transform;
      const th = b.item.height || Math.abs(t[3]) || 10;
      const tx = t[4], ty = t[5];
      const rect = [...vp1.convertToViewportPoint(tx, ty - th), ...vp1.convertToViewportPoint(tx + (b.item.width || 0), ty + th * 0.25)];
      x1 = Math.min(x1, rect[0], rect[2]); y1 = Math.min(y1, rect[1], rect[3]);
      x2 = Math.max(x2, rect[0], rect[2]); y2 = Math.max(y2, rect[1], rect[3]);
    }
    if (x2 < x1) return;
    const d = document.createElement('div');
    d.className = 'temp-hl';
    d.style.cssText = 'left:' + (x1 / vp1.width * W) + 'px;top:' + (y1 / vp1.height * H) + 'px;width:' +
      ((x2 - x1) / vp1.width * W) + 'px;height:' + ((y2 - y1) / vp1.height * H + 4) + 'px;';
    layer.appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .6s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 650); }, 2600);
  },

  flashPage(page) {
    const el = this.pageEls.get(page);
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'temp-hl';
    d.style.cssText = 'left:8%;top:8%;width:84%;height:12%;';
    el.querySelector('.pg-inner').appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .6s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 650); }, 2200);
  },

  /* ---------- 提供论文全文给 AI ---------- */
  async getPaperText(signal) {
    if (this.textCache) return this.textCache;
    if (!this.doc) return { text: '', pageTexts: [] };
    if (!this._textPromise) {
      const gen = this.gen, doc = this.doc, docSignal = this._docAbort.signal;
      const promise = (async () => {
        const pageTexts = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await abortable(this._getPage(i), docSignal);
          if (gen !== this.gen) throw abortError();
          const tc = await abortable(this._textContent(page), docSignal);
          if (gen !== this.gen) throw abortError();
          pageTexts.push(tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim());
        }
        const text = pageTexts.map((t, i) => '[P' + (i + 1) + ']\n' + t).join('\n\n');
        return this.textCache = { text, pageTexts };
      })();
      this._textPromise = promise;
      promise.catch(() => { if (this._textPromise === promise) this._textPromise = null; });
    }
    return abortable(this._textPromise, signal);
  }
};

/* 全局快捷键 */
window.addEventListener('keydown', (e) => {
  if (App.view !== 'reader') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); Reader.undo(); }
});
