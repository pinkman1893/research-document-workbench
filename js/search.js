/* 当前工作区全文搜索：标题、PDF、笔记、标注、对话与论文卡片 */
const Search = (() => {
  let input = null;
  let clearButton = null;
  let query = '';
  let results = [];
  let status = '';
  let generation = 0;
  let controller = null;
  let timer = null;
  const INDEX_VERSION = 1;
  const LABELS = { title: '标题', pdf: 'PDF 正文', note: '笔记', highlight: '高亮', chat: 'AI 对话', card: '论文卡片' };

  const normalize = text => String(text == null ? '' : text).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const tokensFor = text => normalize(text).split(' ').filter(Boolean);
  const matches = (text, tokens) => { const n = normalize(text); return tokens.every(token => n.includes(token)); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));

  function flatten(value, out) {
    out = out || [];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const item of value) flatten(item, out);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (!['paperId', 'id', 'ts', 'createdAt', 'updatedAt', 'generatedAt', 'editedAt', 'usage', 'pending'].includes(key)) flatten(item, out);
    }
    return out;
  }

  function snippet(text, tokens, length) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const low = normalize(clean);
    let at = Infinity;
    for (const token of tokens) { const i = low.indexOf(token); if (i >= 0) at = Math.min(at, i); }
    if (!Number.isFinite(at)) at = 0;
    const width = length || 150;
    const start = Math.max(0, at - Math.floor(width * .32));
    return (start ? '…' : '') + clean.slice(start, start + width) + (start + width < clean.length ? '…' : '');
  }

  function addResult(list, seen, item, tokens, source) {
    const key = [item.paperId, item.kind, item.page || 0, item.sourceId || ''].join('|');
    if (seen.has(key) || !matches(source, tokens)) return;
    seen.add(key);
    list.push(Object.assign(item, { snippet: snippet(source, tokens), jumpText: String(source || '').replace(/\s+/g, ' ').slice(0, 180) }));
  }

  async function structuredResults(papers, tokens) {
    const paperIds = new Set(papers.map(p => p.id));
    const [notes, annos, chats, cards] = await Promise.all([
      DB.all('notes'), DB.all('annos'), DB.all('chats'), DB.all('cards')
    ]);
    const list = [], seen = new Set();
    for (const paper of papers) addResult(list, seen, { paperId: paper.id, kind: 'title' }, tokens, paper.title);
    for (const note of notes) if (paperIds.has(note.paperId)) addResult(list, seen, { paperId: note.paperId, kind: 'note' }, tokens, note.text);
    for (const anno of annos) if (paperIds.has(anno.paperId)) for (const h of anno.highlights || []) {
      addResult(list, seen, { paperId: anno.paperId, kind: 'highlight', page: h.page, sourceId: h.id }, tokens, h.text);
    }
    for (const chat of chats) if (paperIds.has(chat.paperId)) for (const msg of chat.messages || []) {
      const text = flatten(msg).join(' ');
      addResult(list, seen, { paperId: chat.paperId, kind: 'chat', sourceId: msg.id || msg.ts }, tokens, text);
    }
    for (const card of cards) if (paperIds.has(card.paperId)) {
      addResult(list, seen, { paperId: card.paperId, kind: 'card' }, tokens, flatten(card.card || card).join(' '));
    }
    return { list, seen };
  }

  async function extractPaper(paper, signal) {
    if (signal.aborted) throw abortError();
    if (Reader.paperId === paper.id && Reader.doc) {
      const cached = await Reader.getPaperText(signal);
      return cached.pageTexts;
    }
    const rec = await abortable(DB.get('blobs', paper.id), signal);
    if (!rec || !(rec.blob instanceof Blob)) throw new Error('找不到 PDF 文件');
    const bytes = await abortable(rec.blob.arrayBuffer(), signal);
    if (signal.aborted) throw abortError();
    const task = pdfjsLib.getDocument({
      data: bytes, isEvalSupported: false, enableXfa: false,
      cMapUrl: PDF_ASSET_BASE + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: PDF_ASSET_BASE + 'standard_fonts/', wasmUrl: PDF_ASSET_BASE + 'wasm/',
      canvasMaxAreaInBytes: 32 * 1024 * 1024
    });
    const cancel = () => task.destroy().catch(() => {});
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const doc = await abortable(task.promise, signal);
      const pageTexts = new Array(doc.numPages);
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        if (signal.aborted) throw abortError();
        const page = await abortable(doc.getPage(pageNo), signal);
        const content = await abortable(page.getTextContent(), signal);
        pageTexts[pageNo - 1] = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        page.cleanup();
        if (pageNo % 3 === 0) await pause();
      }
      return pageTexts;
    } finally {
      signal.removeEventListener('abort', cancel);
      await task.destroy().catch(() => {});
    }
  }

  async function cachedOrIndex(paper, signal, position, total) {
    const cached = await abortable(DB.get('searchDocs', paper.id), signal);
    if (cached && cached.version === INDEX_VERSION && cached.size === paper.size && Array.isArray(cached.pageTexts)) return cached.pageTexts;
    status = '正在建立全文索引 ' + position + ' / ' + total + ' · ' + paper.title;
    renderList();
    const pageTexts = await extractPaper(paper, signal);
    if (signal.aborted) throw abortError();
    await DB.put('searchDocs', { paperId: paper.id, size: paper.size, pageCount: pageTexts.length, pageTexts, indexedAt: Date.now(), version: INDEX_VERSION });
    return pageTexts;
  }

  async function run(raw) {
    query = String(raw || '').trim();
    clearButton.hidden = !query;
    const myGeneration = ++generation;
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    results = []; status = '';
    if (!query) { UI.renderSidebar(); return; }
    const tokens = tokensFor(query);
    const papers = App.wsPapers();
    try {
      const structured = await structuredResults(papers, tokens);
      if (myGeneration !== generation) return;
      results = structured.list;
      status = papers.length ? '正在检查 PDF 正文…' : '当前工作区没有文献';
      renderList();
      let failed = 0;
      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        let pages;
        try { pages = await cachedOrIndex(paper, signal, i + 1, papers.length); }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          failed++; console.warn('全文索引失败：' + paper.title, e); continue;
        }
        if (myGeneration !== generation) return;
        for (let page = 0; page < pages.length; page++) {
          addResult(results, structured.seen, { paperId: paper.id, kind: 'pdf', page: page + 1 }, tokens, pages[page]);
          if (results.length >= 200) break;
        }
        results.sort((a, b) => {
          const priority = { title: 0, pdf: 1, note: 2, highlight: 3, card: 4, chat: 5 };
          return (priority[a.kind] - priority[b.kind]) || (a.page || 0) - (b.page || 0);
        });
        renderList();
      }
      status = results.length >= 200 ? '已显示前 200 条结果，请缩小搜索范围' : '找到 ' + results.length + ' 条结果';
      if (failed) status += ' · ' + failed + ' 篇 PDF 无法建立索引';
      renderList();
    } catch (e) {
      if (e.name === 'AbortError' || myGeneration !== generation) return;
      status = '搜索未完成：' + e.message;
      renderList();
    }
  }

  function mark(text) {
    const clean = String(text || '');
    const tokens = tokensFor(query).sort((a, b) => b.length - a.length);
    if (!tokens.length) return esc(clean);
    let html = '', rest = clean;
    while (rest) {
      const lower = normalize(rest);
      let best = null;
      for (const token of tokens) {
        const at = lower.indexOf(token);
        if (at >= 0 && (!best || at < best.at)) best = { at, len: token.length };
      }
      if (!best) { html += esc(rest); break; }
      html += esc(rest.slice(0, best.at)) + '<mark>' + esc(rest.slice(best.at, best.at + best.len)) + '</mark>';
      rest = rest.slice(best.at + best.len);
    }
    return html;
  }

  function renderList() {
    if (!query) return false;
    const list = document.getElementById('paper-list');
    if (!list) return true;
    const byPaper = new Map(App.wsPapers().map(p => [p.id, p]));
    list.innerHTML = '<div class="search-head"><span>' + esc(status || '正在搜索…') + '</span></div>' +
      (results.length ? results.map((result, i) => {
        const paper = byPaper.get(result.paperId);
        if (!paper) return '';
        return '<button class="search-result" data-i="' + i + '"><div class="search-result-top"><span class="search-kind">' +
          esc(LABELS[result.kind] || result.kind) + (result.page ? ' · P' + result.page : '') + '</span><span class="search-paper">' + esc(paper.title) +
          '</span></div><div class="search-snippet">' + mark(result.snippet) + '</div></button>';
      }).join('') : (status && !status.startsWith('正在') ? '<div class="search-empty">没有匹配内容</div>' : ''));
    list.querySelectorAll('.search-result').forEach(button => button.addEventListener('click', () => openResult(results[Number(button.dataset.i)])));
    return true;
  }

  async function openResult(result) {
    if (!result) return;
    const opened = await App.openPaper(result.paperId);
    if (!opened) return;
    if (result.page) await Reader.jumpTo(result.page, result.jumpText || query);
    else if (result.kind === 'note') AI.setTab('notes');
    else if (result.kind === 'chat') AI.setTab('chat');
    else if (result.kind === 'card') AI.setTab('card');
  }

  function clear() {
    input.value = ''; query = ''; results = []; status = ''; generation++;
    if (controller) controller.abort();
    clearButton.hidden = true; UI.renderSidebar(); input.focus();
  }

  function init() {
    input = document.getElementById('global-search');
    clearButton = document.getElementById('search-clear');
    document.getElementById('search-icon').innerHTML = icon('search', 15);
    clearButton.innerHTML = icon('x', 14);
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 220); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') clear(); });
    clearButton.addEventListener('click', clear);
    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  function isActive() { return !!query; }
  function onWorkspaceChanged() { if (query) run(query); }
  return { init, run, clear, isActive, renderList, onWorkspaceChanged };
})();
