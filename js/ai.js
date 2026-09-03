/* AI 模块：模型配置、流式对话、tokens/cost、论文卡片、引用锚点；以及笔记区 */

function fmtTok(n) {
  if (n == null) return '—';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : '' + n;
}
function fmtCost(c) {
  if (c == null) return null;
  if (c === 0) return '¥0';
  if (c < 0.0001) return '¥' + c.toExponential(1);
  return '¥' + c.toFixed(4);
}

const CardState = { data: null, editing: false, generating: false, genStart: 0, genError: null };
const Notes = {
  paperId: null, text: '', savedAt: null, _version: 0, _dirty: false, _saving: null,
  mode: 'edit',

  async load(paperId) {
    const version = ++this._version;
    await this.save();
    const rec = await DB.get('notes', paperId);
    if (version !== this._version) return;
    this.paperId = paperId;
    this.text = rec ? (rec.text || '') : '';
    this.savedAt = rec ? rec.updatedAt : null;
    this._dirty = false;
    this.render();
    this.refreshHighlights();
  },

  render() {
    const el = document.getElementById('tab-notes');
    if (!el) return;
    const saved = '<span class="saved">' + (this._dirty ? '保存中…' : this.savedAt ? icon('check', 12) + '已保存 ' + fmtTime(this.savedAt) : '') + '</span>';
    el.innerHTML =
      '<div class="note-head"><span>本文笔记 · Markdown</span>' + saved + '</div>' +
      '<div class="note-tools"><div class="seg" aria-label="笔记显示方式"><button data-note-mode="edit">编辑</button><button data-note-mode="preview">预览</button></div><span>自动保存 · 支持标题、列表、表格与代码</span></div>' +
      '<div class="hl-list" id="hl-list"></div>' +
      '<textarea id="note-area" aria-label="Markdown 笔记" placeholder="# 阅读笔记&#10;&#10;在这里记录想法、疑问、摘要…&#10;支持 **加粗**、列表、表格和代码块（自动保存）">' + esc(this.text) + '</textarea>' +
      '<div id="note-preview" class="md-content" tabindex="0" aria-label="笔记预览" hidden></div>';
    const ta = el.querySelector('#note-area');
    const paperId = this.paperId;
    ta.addEventListener('input', () => {
      if (paperId !== this.paperId) return;
      this.text = ta.value;
      this._dirty = true;
      el.querySelector('.saved').textContent = '保存中…';
      this.save().catch(saveError);
    });
    el.querySelectorAll('[data-note-mode]').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.noteMode)));
    el.querySelector('#note-preview').addEventListener('click', e => {
      const cite = e.target.closest('.cite');
      if (cite) Reader.jumpTo(+cite.dataset.page, cite.dataset.q || '');
    });
    this.setMode(this.mode);
    this.refreshHighlights();
  },

  setMode(mode) {
    this.mode = mode === 'preview' ? 'preview' : 'edit';
    const el = document.getElementById('tab-notes'), ta = el?.querySelector('#note-area'), preview = el?.querySelector('#note-preview');
    if (!ta || !preview) return;
    const showing = this.mode === 'preview';
    ta.hidden = showing; preview.hidden = !showing;
    el.querySelectorAll('[data-note-mode]').forEach(b => {
      const active = b.dataset.noteMode === this.mode;
      b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active));
    });
    if (showing) preview.innerHTML = this.text.trim() ? Markdown.render(this.text, true) : '<p class="note-empty">还没有笔记，切换到「编辑」开始记录。</p>';
  },

  async save() {
    if (!this.paperId || !this._dirty) return this._saving;
    const record = { paperId: this.paperId, text: this.text, updatedAt: Date.now() };
    const saving = this._saving = DB.put('notes', record);
    await saving;
    if (this.paperId !== record.paperId || this.text !== record.text) return;
    this.savedAt = record.updatedAt; this._dirty = false;
    const s = document.querySelector('#tab-notes .saved');
    if (s) s.innerHTML = icon('check', 12) + '已保存 ' + fmtTime(this.savedAt);
  },

  async close() {
    ++this._version;
    await this.save();
    this.paperId = null; this.text = ''; this.savedAt = null; this._saving = null;
  },

  refreshHighlights() {
    const el = document.getElementById('hl-list');
    if (!el) return;
    const hls = (Reader.annos && Reader.annos.highlights) || [];
    if (!hls.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h4>文中高亮 · ' + hls.length + '</h4>' + hls.map(h =>
      '<div class="hl-item" data-hl="' + h.id + '">' +
      '<div class="h-text">' + esc(h.text) + '</div>' +
      '<div class="h-meta"><span class="color-dot-s" style="background:' + Reader.markerColors[h.colorIdx % Reader.markerColors.length].dot + '"></span>' +
      '<span>P' + h.page + '</span>' +
      '<span class="h-del" data-del="' + h.id + '" title="删除">' + icon('trash', 13) + '</span></div></div>'
    ).join('');
    el.querySelectorAll('.h-text').forEach(t => t.addEventListener('click', () => {
      const h = hls.find(x => x.id === t.parentElement.dataset.hl);
      if (h) Reader.jumpTo(h.page, h.text.slice(0, 20));
    }));
    el.querySelectorAll('.h-del').forEach(d => d.addEventListener('click', () => Reader.removeHighlight(d.dataset.del)));
  }
};

const AI = {
  paperId: null,
  messages: [],
  pendingQuotes: [],
  pendingImages: [],
  tab: 'chat',
  _saveDeb: null,
  _abort: null,
  _epoch: 0,
  _job: null,
  _chatDirty: false,

  init() {
    this.renderModelChip();
  },

  async onPaperOpened(paperId) {
    await this.closePaper();
    const epoch = ++this._epoch;
    this.paperId = paperId;
    this.pendingQuotes = []; this.pendingImages = [];
    const [rec, cardRec] = await Promise.all([DB.get('chats', paperId), DB.get('cards', paperId)]);
    if (epoch !== this._epoch || App.paperId !== paperId) return;
    this.messages = rec ? (rec.messages || []) : [];
    this.messages.forEach(m => { if (m.pending) { m.pending = false; m.error = '上次请求已中断，可重试'; } });
    CardState.data = cardRec || null;
    CardState.editing = false; CardState.generating = false; CardState.genError = null;
    this.setTab(this.tab === 'chat' ? 'chat' : this.tab);
    this.renderChat();
    this.renderCardTab();
    this.renderUnderstandBtn();
    await Notes.load(paperId);
    if (epoch !== this._epoch) return;
    this.updateCtxNote();
  },

  cancelTasks() {
    ++this._epoch;
    const job = this._job;
    if (job) {
      job.controller.abort();
      if (job.message) { job.message.pending = false; job.message.error = '已停止，可重试'; this._chatDirty = true; }
    }
    this._job = null; this._abort = null;
    CardState.generating = false;
    clearTimeout(this._cardTimer);
  },

  async closePaper() {
    this.cancelTasks();
    await Promise.all([this.flushChat(), Notes.close(), this.flushCardEdit()]);
    this.paperId = null; this.messages = []; this._chatSave = null; this._chatDirty = false;
    this.pendingQuotes = []; this.pendingImages = [];
    CardState.data = null; CardState.editing = false;
    this._cardDraft = null; this._cardEditDirty = false;
    for (const id of ['tab-chat', 'tab-card', 'tab-notes']) document.getElementById(id).innerHTML = '';
  },

  beginJob(kind) {
    if (!this.paperId || this._job) return null;
    const job = { kind, phase: 'reading', startedAt: Date.now(), paperId: this.paperId, epoch: this._epoch, controller: new AbortController(), messages: this.messages };
    this._job = job; this._abort = job.controller;
    return job;
  },

  jobCurrent(job) { return job && this._job === job && job.epoch === this._epoch && job.paperId === this.paperId && !job.controller.signal.aborted; },
  checkJob(job) { if (!this.jobCurrent(job)) throw abortError(); },

  phaseLabel(job = this._job) {
    return ({ reading: '正在读取论文', waiting: '等待模型响应', thinking: '思考中', writing: job?.kind === 'card' ? '正在生成卡片' : '正在输出' })[job?.phase] || '正在处理';
  },

  setJobPhase(job, phase) {
    if (!this.jobCurrent(job) || job.phase === phase) return;
    job.phase = phase;
    document.querySelectorAll('.job-phase').forEach(el => { el.textContent = this.phaseLabel(job); });
  },

  stopCurrent() {
    const job = this._job;
    if (!job) return;
    this.cancelTasks();
    if (!job.message && job.kind === 'chat') this.messages.push({ id: uid(), role: 'info', text: '已停止读取或等待，可重新发送', ts: Date.now() });
    if (job.kind === 'card') CardState.genError = '已停止生成，可重新理解全文';
    this.saveChat(); this.renderChat(); this.renderCardTab();
    UI.toast('已停止生成，已收到的内容已保留');
  },

  setTab(t) {
    this.tab = t;
    document.querySelectorAll('#rp-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.getElementById('tab-chat').hidden = t !== 'chat';
    document.getElementById('tab-card').hidden = t !== 'card';
    document.getElementById('tab-notes').hidden = t !== 'notes';
    if (t === 'chat') this.scrollChatBottom(false);
  },

  /* ---------- 模型配置 ---------- */
  activeProfile() { return Settings.activeProfile(); },

  renderModelChip() {
    const p = this.activeProfile();
    const el = document.getElementById('model-pick');
    if (!el) return;
    if (!el.querySelector('button')) {
      el.innerHTML = '<button title="切换模型">' + icon('zap', 12) + '<span class="mp-name"></span></button>';
      el.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); this.modelMenu(e.currentTarget); });
    }
    const btn = el.querySelector('button .mp-name');
    if (btn) btn.textContent = p ? (p.name + ' · ' + p.model) : '未配置模型';
  },

  modelMenu(anchor) {
    const profiles = Settings.profiles();
    const items = profiles.map(p => ({
      key: p.id, label: p.name + ' · ' + p.model, icon: Settings.data.activeProfileId === p.id ? 'circle-check' : 'zap',
      action: () => { Settings.setActive(p.id); this.renderModelChip(); this.updateCtxNote(); }
    }));
    if (!profiles.length) items.push({ groupTitle: '尚未配置任何模型' });
    items.push('-');
    items.push({ key: 'mg', label: '管理模型配置', icon: 'sliders', action: () => this.openSettings() });
    UI.openCtx(anchor, items, { alignRight: true });
  },

  openSettings(selectId) {
    const profiles = Settings.profiles();
    let html = '<div class="form-field"><label>模型配置</label><div id="profile-list">' +
      (profiles.length ? profiles.map(p =>
        '<button class="ctx-item" style="width:100%" data-p="' + p.id + '">' + icon('zap', 15) +
        '<span>' + esc(p.name + ' · ' + p.model) + '</span>' +
        (p.id === Settings.data.activeProfileId ? '<span style="margin-left:auto;color:var(--accent-deep)">' + icon('circle-check', 15) + '</span>' : '') +
        '</button>').join('') : '<div class="hint" style="margin-bottom:8px">还没有配置，先新建一个</div>') +
      '</div></div>' +
      '<div id="profile-usage" class="hint"></div>';
    const l = UI.modal('AI 模型配置', html, [
      { label: '新建配置', cls: 'btn-plain', onClick: () => { const p = Settings.newProfile(); Settings.upsertProfile(p); UI.closeModal(); this.editProfile(p.id); return false; } },
      { label: '关闭' }
    ], { wide: true });
    l.querySelectorAll('#profile-list [data-p]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.p;
      Settings.setActive(id); this.renderModelChip();
      UI.closeModal(); this.editProfile(id);
    }));
    this.fillUsage(l.querySelector('#profile-usage'));
  },

  async fillUsage(el) {
    try {
      const rows = await DB.all('usage');
      if (!rows.length) { el.textContent = ''; return; }
      const byName = {};
      for (const r of rows) {
        if (!byName[r.profile]) byName[r.profile] = { pt: 0, ct: 0, cost: 0, n: 0 };
        byName[r.profile].pt += r.pt || 0; byName[r.profile].ct += r.ct || 0;
        byName[r.profile].cost += r.cost || 0; byName[r.profile].n++;
      }
      el.innerHTML = '累计用量：' + Object.entries(byName).map(([k, v]) =>
        esc(k) + ' ' + fmtTok(v.pt + v.ct) + ' tokens · ' + (fmtCost(v.cost) || '价格未设置')).join('；');
    } catch (e) {}
  },

  editProfile(id) {
    const p = Settings.profiles().find(x => x.id === id);
    if (!p) return;
    const body =
      '<div class="form-field"><label>配置名称</label><input id="pf-name" value="' + esc(p.name) + '"><div class="hint">例如：DeepSeek · 日常精读</div></div>' +
      '<div class="form-field"><label>Base URL</label><input id="pf-base" value="' + esc(p.baseUrl) + '" placeholder="https://api.deepseek.com/v1"><div class="hint">兼容 OpenAI 接口的服务地址，一般以 /v1 结尾</div></div>' +
      '<div class="form-field"><label>API Key</label><div style="position:relative"><input id="pf-key" type="password" value="' + esc(p.apiKey) + '" placeholder="sk-…"><button class="ibtn" id="pf-eye" style="position:absolute;right:4px;top:2px">' + icon('eye', 15) + '</button></div><div class="hint">Key 仅保存在当前浏览器；AI 请求会把 Key 和相关论文内容直接发送到此模型网关，请只配置可信服务</div></div>' +
      '<div class="form-field"><label>模型</label><input id="pf-model" value="' + esc(p.model) + '" placeholder="deepseek-chat / gpt-4o / glm-4.6 …"></div>' +
      '<div class="grid2">' +
      '<div class="form-field"><label>思考强度</label><select id="pf-think">' +
      ['off|不发送', 'low|低', 'medium|中', 'high|高'].map(o => { const [v, n] = o.split('|'); return '<option value="' + v + '"' + (p.thinking === v ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select><div class="hint">按 reasoning_effort 参数发送</div></div>' +
      '<div class="form-field"><label>视觉能力</label><select id="pf-vision"><option value="0"' + (!p.vision ? ' selected' : '') + '>纯文本</option><option value="1"' + (p.vision ? ' selected' : '') + '>支持图片</option></select><div class="hint">用于粘贴图片 / 区域截图提问</div></div>' +
      '</div>' +
      '<div class="grid2">' +
      '<div class="form-field"><label>输入价格（元 / 百万 tokens）</label><input id="pf-in" type="number" step="any" min="0" value="' + (p.inPrice || 0) + '"></div>' +
      '<div class="form-field"><label>输出价格（元 / 百万 tokens）</label><input id="pf-out" type="number" step="any" min="0" value="' + (p.outPrice || 0) + '"></div>' +
      '</div>' +
      '<div class="form-field"><label>上下文上限（千字符）</label><input id="pf-max" type="number" min="10" max="2000" value="' + Math.round((p.maxChars || 120000) / 1000) + '"><div class="hint">理解与对话时送入的论文文本上限，超长将截断</div></div>' +
      '<div id="pf-test" class="hint" style="min-height:20px"></div>';

    const l = UI.modal('编辑模型配置：' + esc(p.name), body, [
      { label: '删除', cls: 'btn-danger', onClick: async () => { Settings.removeProfile(p.id); this.renderModelChip(); UI.toast('已删除配置'); } },
      { label: '测试连接', cls: 'btn-plain', onClick: () => { this.testConnection(l, p); return false; } },
      { label: '保存', cls: 'btn-primary', onClick: () => {
        p.name = l.querySelector('#pf-name').value.trim() || p.name;
        p.baseUrl = l.querySelector('#pf-base').value.trim().replace(/\/+$/, '');
        p.apiKey = l.querySelector('#pf-key').value.trim();
        p.model = l.querySelector('#pf-model').value.trim();
        p.thinking = l.querySelector('#pf-think').value;
        p.vision = l.querySelector('#pf-vision').value === '1';
        p.inPrice = parseFloat(l.querySelector('#pf-in').value) || 0;
        p.outPrice = parseFloat(l.querySelector('#pf-out').value) || 0;
        p.maxChars = Math.max(10000, (parseInt(l.querySelector('#pf-max').value, 10) || 120) * 1000);
        Settings.upsertProfile(p);
        if (!Settings.data.activeProfileId) Settings.setActive(p.id);
        this.renderModelChip(); this.updateCtxNote();
        UI.toast('已保存模型配置');
      } }
    ], { wide: true, focus: false });
    l.querySelector('#pf-eye').addEventListener('click', () => {
      const k = l.querySelector('#pf-key');
      k.type = k.type === 'password' ? 'text' : 'password';
    });
  },

  async testConnection(modalEl, p) {
    const out = modalEl.querySelector('#pf-test');
    const base = modalEl.querySelector('#pf-base').value.trim().replace(/\/+$/, '');
    const key = modalEl.querySelector('#pf-key').value.trim();
    const model = modalEl.querySelector('#pf-model').value.trim();
    out.innerHTML = loaderIcon(13) + ' 正在连接…';
    const show = (html) => { out.innerHTML = html; };
    try {
      const res = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
      if (!res.ok) { show('<span style="color:var(--danger)">连接失败：HTTP ' + res.status + ' ' + esc((await res.text()).slice(0, 120)) + '</span>'); return; }
    } catch (e) { show('<span style="color:var(--danger)">连接失败：' + esc(e.message) + '</span>'); return; }
    // 再发一条极短请求校验模型名是否真实存在
    try {
      const r2 = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false })
      });
      if (r2.ok) show('<span style="color:var(--accent-deep)">连接成功，模型「' + esc(model) + '」可用</span>');
      else {
        const t = (await r2.text()).slice(0, 160);
        show('<span style="color:var(--danger)">接口可用，但模型「' + esc(model) + '」校验失败（HTTP ' + r2.status + '）：' + esc(t) + '</span>');
      }
    } catch (e) {
      show('<span style="color:var(--danger)">接口可用，模型校验请求异常：' + esc(e.message) + '</span>');
    }
  },

  /* ---------- 论文上下文 ---------- */
  async buildContext(signal, profile) {
    const pt = await Reader.getPaperText(signal);
    const p = profile || this.activeProfile();
    const limit = p ? (p.maxChars || 120000) : 120000;
    let text = pt.text || '';
    let truncated = false;
    if (text.length > limit) {
      truncated = true;
      const head = text.slice(0, Math.floor(limit * 0.7));
      const tail = text.slice(-Math.floor(limit * 0.3));
      text = head + '\n\n……（中段因长度限制省略）……\n\n' + tail;
    }
    return { text, truncated, chars: (pt.text || '').length };
  },

  systemPrompt() {
    return '你是科研论文阅读助手，正在协助用户精读一篇论文。论文全文按 [P页码] 标记分页提供。\n\n' +
      '回答规则：\n' +
      '1. 陈述论文中的事实、方法、实验结果、作者观点时，必须附来源锚点，格式：[P页码|不超过30字的原文片段]。同一回答涉及多处内容时分别标注。\n' +
      '2. 你自己的推理、推测、评价或建议，必须单独成段并以「评：」开头，不加页码锚点，与论文原文事实明确区分。\n' +
      '3. 优先依据论文原文作答；原文没有的信息要明确说「论文未提及」，不要猜测。\n' +
      '4. 用户消息中若附带「引用原文（P页码）」或图片，优先围绕它们作答。\n' +
      '5. 用中文回答，专业术语可保留英文；条理清晰，适度使用列表。';
  },

  async updateCtxNote() {
    const el = document.getElementById('ctx-note');
    if (!el) return;
    if (!this.paperId) { el.textContent = ''; return; }
    const epoch = this._epoch;
    try {
      const pt = await Reader.getPaperText();
      if (epoch !== this._epoch || !el.isConnected) return;
      const p = this.activeProfile();
      el.textContent = '全文 ' + ((pt.text || '').length).toLocaleString() + ' 字符' + (p ? ' · ' + p.model : '');
    } catch (e) { if (e.name !== 'AbortError' && el.isConnected) el.textContent = '全文暂不可用：' + e.message; }
  },

  /* ---------- 对话渲染 ---------- */
  renderChat() {
    const el = document.getElementById('tab-chat');
    const p = App.paper();
    if (!p) return;
    const draft = el.querySelector('#chat-input')?.value || '';
    const oldList = el.querySelector('#chat-list'), oldTop = oldList?.scrollTop || 0;
    const keepPosition = oldList && oldList.scrollHeight - oldTop - oldList.clientHeight > 80;
    const msgsHtml = this.messages.length ? this.messages.map((m, i) => this.msgHTML(m, i)).join('') :
      '<div class="chat-empty">' + icon('message-square', 26) + '<br>向 AI 提问这篇论文<br><span style="font-size:11.5px">划选原文可针对性提问 · 框选区域可截图提问 · 点击「理解全文」生成论文卡片</span></div>';

    el.innerHTML =
      '<div class="ai-top"><button class="btn-understand' + (CardState.data && !CardState.generating ? ' ghost' : '') + '" id="btn-understand">' +
      icon(CardState.data && !CardState.generating ? 'refresh' : 'sparkles', 15) +
      (CardState.generating ? loaderIcon(14, 'spin') : '') +
      '<span>' + (CardState.generating ? '正在阅读理解…' : CardState.data ? '重新理解全文' : '理解全文') + '</span></button>' +
      '<div class="ctx-note" id="ctx-note"></div></div>' +
      (this._job ? '<div class="chat-progress" role="status"><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="job-phase">' + this.phaseLabel() + '</span><span class="progress-hint">可随时停止</span></div>' : '') +
      '<div id="chat-list">' + msgsHtml + '</div>' +
      '<div class="quote-tray" id="quote-tray"></div>' +
      '<div class="img-tray" id="img-tray"></div>' +
      '<div class="composer"><div class="composer-box">' +
      '<textarea id="chat-input" rows="1" aria-label="向 AI 提问这篇论文" placeholder="向 AI 提问这篇论文…"></textarea>' +
      '<div class="composer-bar">' +
      '<button class="ibtn" id="btn-attach" aria-label="添加图片" title="添加图片">' + icon('image', 16) + '</button>' +
      '<span class="composer-hint">Enter 发送 · 可粘贴图片</span>' +
      '<button class="send-btn' + (this._job ? ' is-stop' : '') + '" id="btn-send" title="' + (this._job ? '停止生成' : '发送') + '" aria-label="' + (this._job ? '停止生成' : '发送') + '">' + icon(this._job ? 'square' : 'arrow-up', 15) + '</button>' +
      '</div></div>' +
      '<input type="file" id="img-input" accept="image/*" multiple hidden></div>';

    const input = el.querySelector('#chat-input');
    input.value = draft;
    el.querySelector('#btn-understand').disabled = !!this._job;
    const epoch = this._epoch;
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          e.preventDefault();
          const f = it.getAsFile();
          const r = new FileReader();
          r.onload = () => { if (epoch === this._epoch) this.attachImage(r.result); };
          r.readAsDataURL(f);
        }
      }
    });
    el.querySelector('#btn-send').addEventListener('click', () => this._job ? this.stopCurrent() : this.send());
    el.querySelector('#btn-attach').addEventListener('click', () => el.querySelector('#img-input').click());
    el.querySelector('#img-input').addEventListener('change', (e) => {
      for (const f of e.target.files) {
        const r = new FileReader();
        r.onload = () => { if (epoch === this._epoch) this.attachImage(r.result); };
        r.readAsDataURL(f);
      }
      e.target.value = '';
    });
    el.querySelector('#btn-understand').addEventListener('click', () => this.understand());

    // 引用锚点点击
    el.querySelector('#chat-list').addEventListener('click', (e) => {
      const c = e.target.closest('.cite');
      if (c) { Reader.jumpTo(+c.dataset.page, c.dataset.q || ''); return; }
      const img = e.target.closest('img');
      if (img && img.src.startsWith('data:')) { UI.viewImage(img.src); return; }
      const re = e.target.closest('[data-retry]');
      if (re) { this.retry(); return; }
      const rg = e.target.closest('[data-regen]');
      if (rg) { this.regenerate(); return; }
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        const m = this.messages[+cp.dataset.copy];
        if (m) { navigator.clipboard && navigator.clipboard.writeText(m.text || '').then(() => UI.toast('已复制')); }
      }
      const op = e.target.closest('[data-open]');
      if (op) { this.setTab('card'); }
    });
    this.renderTrays();
    this.updateCtxNote();
    // 重建被 innerHTML 清掉的模型选择器
    let pick = el.querySelector('#model-pick');
    if (!pick) {
      pick = document.createElement('div');
      pick.id = 'model-pick';
      pick.className = 'model-pick';
      el.insertBefore(pick, el.firstChild);
    }
    this.renderModelChip();
    if (keepPosition) el.querySelector('#chat-list').scrollTop = oldTop;
    else this.scrollChatBottom(false);
  },

  renderUnderstandBtn() { /* 按钮已随 renderChat 重建 */ },

  msgHTML(m, i) {
    if (m.role === 'info') {
      return '<div class="msg msg-info">' + icon('sparkles', 15) + '<span>' + esc(m.text) + '</span>' +
        (m.openCard ? '<span class="link" data-open="1">查看卡片</span>' : '') + '</div>';
    }
    if (m.role === 'user') {
      let q = '';
      (m.quotes || []).forEach(x => {
        q += '<div class="msg-quote">引用原文（P' + x.page + '）：「' + esc(x.text.slice(0, 200)) + '」</div>';
      });
      let imgs = '';
      (m.images || []).forEach(src => { imgs += '<img src="' + src + '" alt="图片">'; });
      return '<div class="msg msg-user">' + q + (imgs ? '<div class="imgs">' + imgs + '</div>' : '') +
        '<div class="bubble">' + esc(m.text) + '</div></div>';
    }
    // assistant
    if (m.error && !m.text && !m.reasoning) {
      return '<div class="msg msg-ai"><div class="msg-error">' + icon('x', 14) + '<span>' + esc(m.error) + '</span>' +
        '<span class="retry-btn" data-retry="1">重试</span></div></div>';
    }
    const foot = m.usage ? '<div class="msg-foot">' +
      '<span class="mf-act" data-copy="' + i + '">' + icon('copy', 12) + '复制</span>' +
      (m.usage.ct != null ? '<span class="mf-act" data-regen="1">' + icon('refresh', 12) + '重新生成</span>' : '') +
      '<span class="usage">输入 ' + fmtTok(m.usage.pt) + ' · 输出 ' + fmtTok(m.usage.ct) +
      (m.usage.cost != null ? ' · ' + fmtCost(m.usage.cost) : '') + '</span></div>' : '';
    const reasoning = '<details class="reasoning"' + (m.reasoning ? '' : ' hidden') + '><summary>' + (m.pending && !m.text ? '思考中 · 展开过程' : '思考过程') + '</summary><div class="r-body">' + esc(m.reasoning || '') + '</div></details>';
    const errTail = m.error ? '<div class="msg-error" style="margin-top:8px">' + icon('x', 14) + '<span>中断：' + esc(m.error) + '</span><span class="retry-btn" data-retry="1">重试</span></div>' : '';
    return '<div class="msg msg-ai" data-msg-id="' + esc(m.id) + '" aria-busy="' + !!m.pending + '">' + reasoning + '<div class="body md-content">' + this.mdRender(m.text || '') + (m.pending && m.text ? '<span class="cursor-blink" aria-hidden="true"></span>' : '') + '</div>' + (m.pending && !m.text ? '<div class="stream-placeholder" aria-hidden="true"><div class="shimmer"></div><div class="shimmer"></div></div>' : '') + errTail + foot + '</div>';
  },

  /* 轻量 Markdown + 引用锚点渲染 */
  mdRender(text) {
    return Markdown.render(text, true);
  },

  inline(s) {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 统一引用格式 → 锚点
    h = h.replace(/[（【\[]\s*[Pp](\d+)\s*(?:[|｜]([^\]】）]{1,80}))?\s*[\]】）]/g, (all, page, q) => {
      return '<span class="cite" data-page="' + page + '" data-q="' + esc(q || '') + '" title="' + esc(q || '跳转到 P' + page) + '">' + icon('book-open', 10) + 'P' + page + '</span>';
    });
    return h;
  },

  scrollChatBottom(smooth) {
    const el = document.getElementById('chat-list');
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  },

  /* ---------- 输入附件 ---------- */
  attachQuote(text, page) {
    this.pendingQuotes.push({ text, page });
    this.renderTrays();
    this.setTab('chat');
    const inp = document.getElementById('chat-input');
    if (inp) inp.focus();
  },

  attachImage(dataUrl) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(dataUrl)) { UI.toast('请使用 PNG、JPEG、WebP 等位图图片', 'error'); return; }
    this.pendingImages.push(dataUrl);
    this.renderTrays();
    this.setTab('chat');
  },

  renderTrays() {
    const qt = document.getElementById('quote-tray');
    if (qt) {
      qt.innerHTML = this.pendingQuotes.map((q, i) =>
        '<div class="tray-item"><span class="t-tag">P' + q.page + '</span><span class="t-main">「' + esc(q.text.slice(0, 160)) + '」</span>' +
        '<span class="t-x" data-q="' + i + '">' + icon('x', 12) + '</span></div>').join('');
      qt.querySelectorAll('.t-x[data-q]').forEach(x => x.addEventListener('click', () => {
        this.pendingQuotes.splice(+x.dataset.q, 1); this.renderTrays();
      }));
    }
    const it = document.getElementById('img-tray');
    if (it) {
      it.innerHTML = this.pendingImages.map((src, i) =>
        '<div class="img-cell"><img src="' + src + '"><span class="t-x" data-i="' + i + '">' + icon('x', 12) + '</span></div>').join('');
      it.querySelectorAll('.t-x[data-i]').forEach(x => x.addEventListener('click', () => {
        this.pendingImages.splice(+x.dataset.i, 1); this.renderTrays();
      }));
      it.querySelectorAll('img').forEach(im => im.addEventListener('click', () => UI.viewImage(im.src)));
    }
  },

  saveChat() {
    this._chatDirty = true;
    return this.flushChat().catch(saveError);
  },

  async flushChat() {
    if (!this.paperId || !this._chatDirty) return this._chatSave;
    const paperId = this.paperId;
    const record = structuredClone({ paperId, messages: this.messages, updatedAt: Date.now() });
    this._chatDirty = false;
    const saving = this._chatSave = DB.put('chats', record);
    this._chatSaving = true;
    try { await saving; } catch (e) { if (paperId === this.paperId) this._chatDirty = true; throw e; }
    finally { if (this._chatSave === saving) this._chatSaving = false; }
  },

  /* ---------- 发送 ---------- */
  apiMessages(context) {
    const msgs = [{ role: 'system', content: this.systemPrompt() + '\n\n论文全文如下：\n' + (context.truncated ? '（注意：全文过长已截断）\n' : '') + context.text }];
    for (const m of this.messages) {
      if (m.role === 'user') {
        let text = m.text || '';
        (m.quotes || []).forEach(q => { text = '引用原文（P' + q.page + '）：「' + q.text + '」\n\n' + text; });
        if (m.images && m.images.length) {
          const content = [{ type: 'text', text: text || '请看图片' }];
          m.images.forEach(src => content.push({ type: 'image_url', image_url: { url: src } }));
          msgs.push({ role: 'user', content });
        } else {
          msgs.push({ role: 'user', content: text });
        }
      } else if (m.role === 'assistant' && m.text && !m.error) {
        msgs.push({ role: 'assistant', content: m.text });
      }
    }
    return msgs;
  },

  async send() {
    if (this._job) { UI.toast('当前请求尚未完成，请稍候'); return; }
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : '';
    if (!text && !this.pendingImages.length && !this.pendingQuotes.length) return;
    const profile = this.activeProfile();
    if (!profile) { UI.toast('请先配置 AI 模型'); this.openSettings(); return; }
    const job = this.beginJob('chat');
    if (!job) return;

    const userMsg = {
      id: uid(), role: 'user', text,
      images: this.pendingImages.slice(),
      quotes: this.pendingQuotes.slice(),
      ts: Date.now()
    };
    this.messages.push(userMsg);
    this.pendingQuotes = []; this.pendingImages = [];
    if (input) input.value = '';
    this.saveChat();
    this.renderChat();

    if (userMsg.images.length && profile.vision !== true) {
      UI.toast('当前模型标记为纯文本，可能无法看图；若报错请切换支持图片的模型', 'error');
    }

    await this.prepareChat(profile, job);
  },

  async prepareChat(profile, job) {
    try {
      const context = await abortable(this.buildContext(job.controller.signal, profile), job.controller.signal);
      this.checkJob(job);
      this.setJobPhase(job, 'waiting');
      await this.runChat(profile, this.apiMessages(context), job);
    } catch (e) {
      if (!this.jobCurrent(job)) return;
      this.messages.push({ id: uid(), role: 'assistant', text: '', error: e.message, ts: Date.now() });
      this.saveChat();
    } finally {
      if (this._job === job) { this._job = null; this._abort = null; this.renderChat(); }
    }
  },

  async retry() {
    if (this._job) return;
    // 移除末尾的出错 assistant 消息后重发
    while (this.messages.length && this.messages[this.messages.length - 1].role === 'assistant') {
      const last = this.messages[this.messages.length - 1];
      if (last.pending) this._abort && this._abort.abort();
      this.messages.pop();
    }
    if (!this.messages.length || this.messages[this.messages.length - 1].role !== 'user') return;
    const profile = this.activeProfile();
    if (!profile) { this.openSettings(); return; }
    const job = this.beginJob('chat');
    if (!job) return;
    this.renderChat();
    await this.prepareChat(profile, job);
  },

  async regenerate() {
    if (this._job) return;
    const idx = this.messages.map(m => m.role).lastIndexOf('assistant');
    if (idx < 0) return;
    this.messages.splice(idx, 1);
    this.renderChat();
    const profile = this.activeProfile();
    if (!profile) { this.openSettings(); return; }
    const job = this.beginJob('chat');
    if (job) { this.renderChat(); await this.prepareChat(profile, job); }
  },

  async runChat(profile, apiMsgs, job = this.beginJob('chat')) {
    if (!job) return;
    this.checkJob(job);
    this.setJobPhase(job, 'waiting');
    const asstMsg = job.message = { id: uid(), role: 'assistant', text: '', reasoning: '', usage: null, pending: true, ts: Date.now() };
    job.messages.push(asstMsg);
    this.renderChat();

    const listEl = () => document.getElementById('chat-list');
    const bodyEl = () => {
      return document.querySelector('[data-msg-id="' + asstMsg.id + '"] .body');
    };
    let nearBottom = true;
    const onScroll = () => {
      const el = listEl();
      nearBottom = el && (el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    };
    const scrollEl = listEl();
    if (scrollEl) scrollEl.addEventListener('scroll', onScroll);

    const refresh = () => {
      if (!this.jobCurrent(job)) return;
      const b = bodyEl();
      if (b && b._markdownSource !== asstMsg.text) {
        b.innerHTML = this.mdRender(asstMsg.text || '') + (asstMsg.pending && asstMsg.text ? '<span class="cursor-blink" aria-hidden="true"></span>' : '');
        b._markdownSource = asstMsg.text;
      }
      const msg = b?.closest('.msg'), details = msg?.querySelector('.reasoning');
      if (details) {
        details.hidden = !asstMsg.reasoning;
        details.querySelector('summary').textContent = asstMsg.text ? '思考过程' : '思考中 · 展开过程';
        const body = details.querySelector('.r-body');
        const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.textContent = asstMsg.reasoning || '';
        if (follow) body.scrollTop = body.scrollHeight;
      }
      const placeholder = msg?.querySelector('.stream-placeholder');
      if (placeholder) placeholder.hidden = !!asstMsg.text;
      if (nearBottom) this.scrollChatBottom(false);
    };
    asstMsg.pending = true;
    let lastPaint = 0, lastSave = 0, paintTimer = null;
    const paint = () => { paintTimer = null; lastPaint = Date.now(); refresh(); };
    try {
      const r = await abortable(this.chatRequest(profile, apiMsgs, {
        signal: job.controller.signal,
        onDelta: (kind, accumulated) => {
          if (!this.jobCurrent(job)) return;
          if (kind === 'content') asstMsg.text = accumulated;
          else asstMsg.reasoning = accumulated;
          this.setJobPhase(job, asstMsg.text ? 'writing' : 'thinking');
          this._chatDirty = true;
          const now = Date.now();
          if (now - lastPaint >= 80) { clearTimeout(paintTimer); paint(); }
          else if (!paintTimer) paintTimer = setTimeout(paint, 80 - (now - lastPaint));
          if (now - lastSave > 1000) { lastSave = now; this.flushChat().catch(saveError); }
        }
      }), job.controller.signal);
      this.checkJob(job);
      asstMsg.text = r.content;
      asstMsg.reasoning = r.reasoning;
      asstMsg.usage = this.usageOf(profile, r.usage);
      asstMsg.model = profile.model;
      if (r.usage) await this.recordUsage(profile, r.usage, job.paperId);
      asstMsg.pending = false;
      if (!r.content) asstMsg.error = '模型未返回内容';
    } catch (e) {
      if (!this.jobCurrent(job)) return;
      asstMsg.pending = false;
      if (e.name === 'AbortError') asstMsg.error = '已停止';
      else asstMsg.error = e.message || String(e);
    } finally {
      clearTimeout(paintTimer);
      scrollEl?.removeEventListener('scroll', onScroll);
      if (this._job === job) {
        this._job = null; this._abort = null;
        this.saveChat(); this.renderChat();
      }
    }
  },

  usageOf(profile, usage) {
    if (!usage) return null;
    const pt = usage.prompt_tokens || 0, ct = usage.completion_tokens || 0;
    const cost = (profile.inPrice || profile.outPrice) ? pt * (profile.inPrice || 0) / 1e6 + ct * (profile.outPrice || 0) / 1e6 : null;
    return { pt, ct, cost };
  },

  async recordUsage(profile, usage, paperId = this.paperId) {
    const pt = usage.prompt_tokens || 0, ct = usage.completion_tokens || 0;
    const cost = pt * (profile.inPrice || 0) / 1e6 + ct * (profile.outPrice || 0) / 1e6;
    try {
      await DB.put('usage', { ts: Date.now(), paperId, profile: profile.name, model: profile.model, pt, ct, cost });
    } catch (e) { saveError(e); }
  },

  /* ---------- OpenAI 兼容请求（流式） ---------- */
  async chatRequest(profile, messages, opts) {
    opts = opts || {};
    const url = profile.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (profile.apiKey) headers['Authorization'] = 'Bearer ' + profile.apiKey;

    const doFetch = async (extras, stream) => {
      const body = { model: profile.model, messages, stream };
      if (stream) body.stream_options = { include_usage: true };
      Object.assign(body, extras || {});
      return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
    };

    let extras = {};
    if (profile.thinking && profile.thinking !== 'off' && profile.sendReasoning !== false) {
      extras.reasoning_effort = profile.thinking;
    }

    let res = await doFetch(extras, true);
    if (res.status === 400 && (extras.reasoning_effort)) {
      extras = {}; // 部分接口不认 reasoning_effort，去掉重试
      res = await doFetch(extras, true);
    }
    if (res.status === 400) {
      res = await doFetch({}, false);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 200));
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const j = await res.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      return { content: msg.content || '', reasoning: msg.reasoning_content || '', usage: j.usage };
    }

    // SSE 流式
    if (!res.body) throw new Error('接口没有返回响应正文');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', usage = null;
    let eventData = [];
    const dispatch = () => {
      if (!eventData.length) return;
      const data = eventData.join('\n').trim(); eventData = [];
      if (data === '[DONE]' || !data) return;
      let j;
      try { j = JSON.parse(data); } catch (_) { throw new Error('接口返回了无效的流式数据，请重试'); }
      if (j.error) throw new Error(j.error.message || '接口返回错误');
      const d = j.choices?.[0]?.delta || j.choices?.[0]?.message;
      if (d?.content) { content += d.content; opts.onDelta?.('content', content, d.content); }
      if (d?.reasoning_content) { reasoning += d.reasoning_content; opts.onDelta?.('reasoning', reasoning, d.reasoning_content); }
      if (j.usage) usage = j.usage;
    };
    const line = raw => {
      const value = raw.replace(/\r$/, '');
      if (!value) dispatch();
      else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
    };
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), opts.signal);
        buf += done ? dec.decode() : dec.decode(value, { stream: true });
        if (buf.length > 2 * 1024 * 1024) throw new Error('流式数据过大或格式错误');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) { line(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
        if (done) { if (buf) line(buf); dispatch(); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { content, reasoning, usage };
  },

  /* ---------- 理解全文 → 论文卡片 ---------- */
  async understand() {
    if (this._job || !this.paperId) return;
    const epoch = this._epoch, paperId = this.paperId;
    const profile = this.activeProfile();
    if (!profile) { UI.toast('请先配置 AI 模型'); this.openSettings(); return; }
    if (CardState.data) {
      const ok = await UI.confirm('重新理解全文', '已有论文卡片，重新生成将覆盖现有卡片（也可在卡片内手动编辑）。', '重新生成');
      if (!ok) return;
    }
    if (epoch !== this._epoch || paperId !== this.paperId || this._job) return;
    const job = this.beginJob('card');
    if (!job) return;
    CardState.generating = true; CardState.genError = null; CardState.genStart = Date.now();
    this.setTab('card');
    this.renderCardTab();
    this.renderChat();

    try {
      const context = await abortable(this.buildContext(job.controller.signal, profile), job.controller.signal);
      this.checkJob(job);
      if (!context.text || context.text.replace(/\[P\d+\]|\s/g, '').length < 200) {
        throw new Error('这篇 PDF 几乎没有文本层（可能是扫描件），无法进行文本理解');
      }
      const sys = '你是一名严谨的科研助理。请通读用户提供的论文全文（按 [P页码] 标记分页），生成一张结构化论文卡片。只输出一个 JSON 对象，不要输出任何额外文字、解释或代码块标记。JSON 结构：\n' +
        '{\n' +
        '  "oneSentence": "一句话概括这篇论文（不超过60字）",\n' +
        '  "problem": "研究的问题（2-4句）",\n' +
        '  "method": "核心方法与关键设计（3-6句）",\n' +
        '  "finding": "主要发现与实验结果（含关键数字）",\n' +
        '  "contribution": "主要贡献（2-4条，数组形式）",\n' +
        '  "limitations": "局限与不足",\n' +
        '  "quotes": [{"text": "值得引用的原文摘录", "page": 页码数字, "note": "为什么值得引用（一句话）"}]\n' +
        '}\n' +
        '要求：除 quotes.text 保留原文语言外全部用中文；所有内容必须来自原文，页码必须真实；quotes 选 3-6 条最有价值的；不要编造。';

      this.setJobPhase(job, 'waiting');
      const r = await abortable(this.chatRequest(profile, [
        { role: 'system', content: sys },
        { role: 'user', content: '论文全文：\n' + context.text }
      ], { signal: job.controller.signal, onDelta: (kind, accumulated) => {
        if (!this.jobCurrent(job)) return;
        if (kind === 'content') job.outputLength = accumulated.length;
        this.setJobPhase(job, job.outputLength ? 'writing' : 'thinking');
      } }), job.controller.signal);
      this.checkJob(job);

      const card = this.parseCard(r.content);
      const rec = { paperId: job.paperId, card, generatedAt: Date.now(), model: profile.model, editedAt: null };
      await DB.put('cards', rec);
      this.checkJob(job);
      CardState.data = rec;
      CardState.generating = false;
      this.messages.push({ id: uid(), role: 'info', text: '已完成全文阅读理解，论文卡片已生成并保存', openCard: true, ts: Date.now() });
      this.saveChat();
      if (r.usage) await this.recordUsage(profile, r.usage, job.paperId);
      this.checkJob(job);
      this.renderCardTab();
      this.renderChat();
      UI.toast('论文卡片已生成');
    } catch (e) {
      if (!this.jobCurrent(job)) return;
      CardState.generating = false;
      CardState.genError = e.message || String(e);
      this.renderCardTab();
      this.renderChat();
      UI.toast('理解失败：' + CardState.genError, 'error');
    } finally {
      if (this._job === job) { this._job = null; this._abort = null; CardState.generating = false; this.renderCardTab(); this.renderChat(); }
    }
  },

  parseCard(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/```json|```/g, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型未返回有效的卡片内容');
    let j;
    try { j = JSON.parse(s.slice(a, b + 1)); }
    catch (e) { throw new Error('卡片解析失败，可重试或在卡片中手动编辑'); }
    const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
    const quotes = arr(j.quotes).map(q => ({
      text: String(q.text || ''), page: parseInt(q.page, 10) || 1, note: String(q.note || '')
    })).filter(q => q.text);
    return {
      oneSentence: String(j.oneSentence || ''),
      problem: String(j.problem || ''),
      method: String(j.method || ''),
      finding: String(j.finding || ''),
      contribution: arr(j.contribution),
      limitations: String(j.limitations || ''),
      quotes
    };
  },

  /* ---------- 卡片 Tab ---------- */
  renderCardTab() {
    clearTimeout(this._cardTimer);
    const el = document.getElementById('tab-card');
    if (!el) return;
    if (CardState.generating) {
      const secs = Math.round((Date.now() - CardState.genStart) / 1000);
      el.innerHTML = '<div class="card-wrap"><div class="gen-state">' + loaderIcon(30, 'spin') +
        '<div class="gs-title job-phase" role="status">' + this.phaseLabel() + '</div>' +
        '<div class="gs-sub">已进行 <span class="gen-seconds">' + secs + '</span> 秒 · 完成后自动保存</div>' +
        '<div class="shimmer"></div><div class="shimmer" style="margin-top:9px;width:80%"></div><div class="shimmer" style="margin-top:9px;width:65%"></div><button class="btn-plain" id="card-stop" style="margin-top:20px">停止生成</button></div></div>';
      el.querySelector('#card-stop').addEventListener('click', () => this.stopCurrent());
      const tick = () => {
        if (!CardState.generating) return;
        const target = el.querySelector('.gen-seconds');
        if (target) target.textContent = Math.round((Date.now() - CardState.genStart) / 1000);
        this._cardTimer = setTimeout(tick, 1000);
      };
      this._cardTimer = setTimeout(tick, 1000);
      return;
    }
    if (CardState.genError && !CardState.data) {
      el.innerHTML = '<div class="card-wrap"><div class="card-gen">' + icon('flame', 28) + '<br>理解失败<br><span style="font-size:12px">' + esc(CardState.genError) + '</span><br>' +
        '<button class="btn-primary" style="margin-top:12px" onclick="AI.understand()">重试</button></div></div>';
      return;
    }
    if (!CardState.data) {
      el.innerHTML = '<div class="card-wrap"><div class="card-gen">' + icon('sparkles', 30) + '<br>还没有论文卡片<br>' +
        '<span style="font-size:12px">点击「理解全文」，AI 通读后生成这张论文的核心资产卡片</span><br>' +
        '<button class="btn-primary" style="margin-top:14px" onclick="AI.understand()">' + icon('sparkles', 14) + ' 理解全文</button></div></div>';
      return;
    }
    if (CardState.editing) { this.renderCardEdit(el); return; }
    const c = CardState.data.card;
    const p = App.paper();
    const sec = (label, body) => body ? '<div class="sec"><div class="sec-label">' + label + '</div><div class="sec-body">' + body + '</div></div>' : '';
    el.innerHTML = '<div class="card-wrap">' +
      '<div class="card-head"><span class="ttl">论文卡片</span>' +
      '<span style="font-size:11px;color:var(--ink-3)">' + new Date(CardState.data.generatedAt).toLocaleString() + ' · ' + esc(CardState.data.model || '') + (CardState.data.editedAt ? ' · 已手动编辑' : '') + '</span>' +
      '<div class="acts"><button class="ibtn" id="card-edit" title="编辑">' + icon('edit', 15) + '</button></div></div>' +
      '<div class="pcard">' +
      '<div class="pc-title">' + esc(p ? p.title : '') + '</div>' +
      (c.oneSentence ? '<div class="pc-oneline">' + esc(c.oneSentence) + '</div>' : '') +
      sec('PROBLEM · 问题', esc(c.problem).replace(/\n/g, '<br>')) +
      sec('METHOD · 方法', esc(c.method).replace(/\n/g, '<br>')) +
      sec('FINDING · 发现', esc(c.finding).replace(/\n/g, '<br>')) +
      sec('CONTRIBUTION · 贡献', c.contribution.length ? '<ul>' + c.contribution.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      sec('LIMITATIONS · 局限', esc(c.limitations).replace(/\n/g, '<br>')) +
      (c.quotes.length ? '<div class="sec"><div class="sec-label">QUOTES · 值得引用</div>' +
        c.quotes.map(q => '<div class="quote-item"><div class="q-text">「' + esc(q.text) + '」</div>' +
          (q.note ? '<div class="q-note">' + esc(q.note) + '</div>' : '') +
          '<span class="q-jump" data-pg="' + q.page + '" data-q="' + esc(q.text.slice(0, 20)) + '">' + icon('book-open', 11) + ' P' + q.page + ' 跳转原文</span></div>').join('') + '</div>' : '') +
      '</div></div>';

    el.querySelector('#card-edit').addEventListener('click', () => { CardState.editing = true; this.renderCardTab(); });
    el.querySelectorAll('.q-jump').forEach(j => j.addEventListener('click', () => {
      Reader.jumpTo(+j.dataset.pg, j.dataset.q);
    }));
  },

  renderCardEdit(el) {
    if (!this._cardDraft || this._cardDraft.paperId !== CardState.data.paperId) this._cardDraft = structuredClone(CardState.data);
    const draft = this._cardDraft;
    const c = draft.card;
    const f = (id, label, val, rows) =>
      '<div class="field"><label>' + label + '</label><textarea id="' + id + '" rows="' + (rows || 3) + '">' + esc(val) + '</textarea></div>';
    el.innerHTML = '<div class="card-wrap card-edit">' +
      '<div class="card-head"><span class="ttl">编辑论文卡片</span></div>' +
      f('ce-one', '一句话', c.oneSentence, 2) +
      f('ce-problem', 'Problem · 问题', c.problem) +
      f('ce-method', 'Method · 方法', c.method) +
      f('ce-finding', 'Finding · 发现', c.finding) +
      '<div class="field"><label>Contribution · 贡献（每行一条）</label><textarea id="ce-contrib" rows="3">' + esc(c.contribution.join('\n')) + '</textarea></div>' +
      f('ce-limit', 'Limitations · 局限', c.limitations) +
      '<div class="field"><label>值得引用（每行格式：页码 | 摘录 | 理由）</label><textarea id="ce-quotes" rows="5">' +
      esc(c.quotes.map(q => q.page + ' | ' + q.text + ' | ' + q.note).join('\n')) + '</textarea></div>' +
      '<div class="btn-row"><button class="btn-plain" id="ce-cancel">取消</button><button class="btn-primary" id="ce-save">保存卡片</button></div>' +
      '</div>';
    const collect = () => {
      if (this._cardDraft !== draft) return;
      c.oneSentence = el.querySelector('#ce-one').value.trim();
      c.problem = el.querySelector('#ce-problem').value.trim();
      c.method = el.querySelector('#ce-method').value.trim();
      c.finding = el.querySelector('#ce-finding').value.trim();
      c.contribution = el.querySelector('#ce-contrib').value.split('\n').map(x => x.trim()).filter(Boolean);
      c.limitations = el.querySelector('#ce-limit').value.trim();
      c.quotes = el.querySelector('#ce-quotes').value.split('\n').map(line => {
        const parts = line.split('|');
        if (parts.length < 2) return null;
        return { page: parseInt(parts[0].trim(), 10) || 1, text: parts[1].trim(), note: (parts[2] || '').trim() };
      }).filter(Boolean);
      draft.editedAt = Date.now(); this._cardEditDirty = true; this._cardEditVersion = (this._cardEditVersion || 0) + 1;
    };
    el.querySelectorAll('textarea').forEach(t => t.addEventListener('input', collect));
    el.querySelector('#ce-cancel').addEventListener('click', () => { this._cardDraft = null; this._cardEditDirty = false; CardState.editing = false; this.renderCardTab(); });
    el.querySelector('#ce-save').addEventListener('click', async () => {
      collect();
      try {
        await this.flushCardEdit();
        if (this.paperId !== draft.paperId) return;
        this._cardDraft = null; CardState.editing = false; this.renderCardTab(); this.renderChat(); UI.toast('卡片已保存');
      } catch (e) { saveError(e); }
    });
  },

  async flushCardEdit() {
    if (!this._cardDraft || !this._cardEditDirty) return;
    const draft = this._cardDraft, record = structuredClone(draft), version = this._cardEditVersion;
    await DB.put('cards', record);
    if (this._cardDraft !== draft) return;
    if (version !== this._cardEditVersion) return this.flushCardEdit();
    if (this.paperId === record.paperId) CardState.data = record;
    this._cardEditDirty = false;
  }
};
