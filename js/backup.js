/* 完整数据备份：版本化 .rdwb 单文件、导入校验与浏览器内自动快照 */
const Backup = (() => {
  const MAGIC = new TextEncoder().encode('RDWB1\n');
  const FORMAT = 'research-document-workbench-backup';
  const FORMAT_VERSION = 1;
  const APP_VERSION = '1.3.0';
  const DATA_STORES = ['workspaces', 'papers', 'notes', 'annos', 'cards', 'chats', 'usage', 'searchDocs'];
  const LOCAL_KEYS = ['rd_last_ws', 'rd_collapsed'];
  let timer = null;

  const clone = value => JSON.parse(JSON.stringify(value));
  const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async value => hex(await crypto.subtle.digest('SHA-256', value));
  const sleepFrame = () => new Promise(resolve => setTimeout(resolve, 0));

  function config() {
    const defaults = { enabled: true, intervalHours: 24, retention: 2, lastAt: 0, lastAttemptAt: 0 };
    const saved = Settings.data.backup && typeof Settings.data.backup === 'object' ? Settings.data.backup : {};
    Settings.data.backup = Object.assign(defaults, saved);
    Settings.data.backup.intervalHours = Math.max(1, Math.min(168, Number(Settings.data.backup.intervalHours) || 24));
    Settings.data.backup.retention = Math.max(1, Math.min(5, Number(Settings.data.backup.retention) || 2));
    return Settings.data.backup;
  }

  async function flushLiveData() {
    Reader._finishGesture?.();
    await Promise.all([
      Reader.saveProgressNow?.(), Reader.saveAnnosNow?.(), Notes.save?.(),
      AI.flushChat?.(), AI.flushCardEdit?.()
    ]);
    await DB.flush();
  }

  function safeSettings(includeSecrets) {
    const data = clone(Settings.data);
    if (!includeSecrets && Array.isArray(data.aiProfiles)) {
      for (const profile of data.aiProfiles) profile.apiKey = '';
    }
    return data;
  }

  async function buildBundle(options) {
    const opts = Object.assign({ includeSecrets: false, flush: true }, options || {});
    if (opts.flush) await flushLiveData();
    const stores = {};
    for (const name of DATA_STORES) stores[name] = await DB.entries(name);
    const blobRecords = await DB.all('blobs');
    const localStorageData = { settings: safeSettings(opts.includeSecrets) };
    for (const key of LOCAL_KEYS) {
      try { localStorageData[key] = localStorage.getItem(key); } catch (_) { localStorageData[key] = null; }
    }
    const blobMeta = [];
    const blobParts = [];
    for (const rec of blobRecords) {
      if (!rec || !rec.paperId || !(rec.blob instanceof Blob)) throw new Error('发现无效的 PDF 数据');
      const bytes = await rec.blob.arrayBuffer();
      blobMeta.push({
        paperId: rec.paperId,
        type: rec.blob.type || 'application/pdf',
        size: bytes.byteLength,
        sha256: await sha256(bytes)
      });
      blobParts.push(rec.blob);
      await sleepFrame();
    }
    const recordsJSON = JSON.stringify({ stores, localStorage: localStorageData });
    const header = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      dbVersion: DB.version(),
      appVersion: APP_VERSION,
      createdAt: Date.now(),
      secretsIncluded: !!opts.includeSecrets,
      stores,
      localStorage: localStorageData,
      blobs: blobMeta,
      counts: {
        workspaces: stores.workspaces.length,
        papers: stores.papers.length,
        pdfs: blobMeta.length
      },
      integrity: { recordsSha256: await sha256(new TextEncoder().encode(recordsJSON)) }
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, headerBytes.byteLength, false);
    return new Blob([MAGIC, length, headerBytes, ...blobParts], { type: 'application/x-rdwb-backup' });
  }

  function assertArray(value, label) {
    if (!Array.isArray(value)) throw new Error(label + ' 格式无效');
    return value;
  }

  async function parseBundle(blob) {
    if (!(blob instanceof Blob)) throw new Error('请选择有效的备份文件');
    if (blob.size < MAGIC.length + 4) throw new Error('备份文件已截断');
    const prefix = new Uint8Array(await blob.slice(0, MAGIC.length + 4).arrayBuffer());
    if (!MAGIC.every((b, i) => prefix[i] === b)) throw new Error('这不是科研阅读工作台备份文件');
    const headerLength = new DataView(prefix.buffer, MAGIC.length, 4).getUint32(0, false);
    if (!headerLength || headerLength > 64 * 1024 * 1024 || MAGIC.length + 4 + headerLength > blob.size) {
      throw new Error('备份文件头损坏或不完整');
    }
    let header;
    try {
      const text = await blob.slice(MAGIC.length + 4, MAGIC.length + 4 + headerLength).text();
      header = JSON.parse(text);
    } catch (_) { throw new Error('无法解析备份文件头'); }
    if (header.format !== FORMAT || header.formatVersion !== FORMAT_VERSION) throw new Error('不支持的备份格式版本');
    if (!header.stores || typeof header.stores !== 'object') throw new Error('备份记录缺失');
    for (const name of DATA_STORES) assertArray(header.stores[name], '数据表 ' + name);
    assertArray(header.blobs, 'PDF 清单');

    const recordsJSON = JSON.stringify({ stores: header.stores, localStorage: header.localStorage });
    const recordsHash = await sha256(new TextEncoder().encode(recordsJSON));
    if (recordsHash !== header.integrity?.recordsSha256) throw new Error('备份记录校验失败，文件可能已损坏');

    const values = name => header.stores[name].map(entry => entry && entry.value);
    const workspaces = values('workspaces');
    const papers = values('papers');
    const wsIds = new Set();
    const paperIds = new Set();
    for (const ws of workspaces) {
      if (!ws || typeof ws.id !== 'string' || !ws.id || wsIds.has(ws.id)) throw new Error('工作区 ID 缺失或重复');
      wsIds.add(ws.id);
    }
    for (const paper of papers) {
      if (!paper || typeof paper.id !== 'string' || !paper.id || paperIds.has(paper.id)) throw new Error('文献 ID 缺失或重复');
      if (!wsIds.has(paper.wsId)) throw new Error('文献引用了不存在的工作区');
      paperIds.add(paper.id);
    }
    for (const name of ['notes', 'annos', 'cards', 'chats', 'searchDocs']) {
      const seen = new Set();
      for (const rec of values(name)) {
        if (!rec || !paperIds.has(rec.paperId) || seen.has(rec.paperId)) throw new Error(name + ' 中存在无效或重复的文献引用');
        seen.add(rec.paperId);
      }
    }
    for (const rec of values('usage')) {
      if (rec && rec.paperId != null && !paperIds.has(rec.paperId)) throw new Error('用量记录引用了不存在的文献');
    }
    const blobIds = new Set();
    let offset = MAGIC.length + 4 + headerLength;
    const blobs = [];
    for (const meta of header.blobs) {
      if (!meta || !paperIds.has(meta.paperId) || blobIds.has(meta.paperId)) throw new Error('PDF 清单引用无效或重复');
      if (!Number.isSafeInteger(meta.size) || meta.size < 0 || offset + meta.size > blob.size) throw new Error('PDF 数据长度无效');
      const pdfBlob = blob.slice(offset, offset + meta.size, meta.type || 'application/pdf');
      const actual = await sha256(await pdfBlob.arrayBuffer());
      if (actual !== meta.sha256) throw new Error('PDF 完整性校验失败：' + meta.paperId);
      blobs.push({ paperId: meta.paperId, blob: pdfBlob });
      blobIds.add(meta.paperId);
      offset += meta.size;
      await sleepFrame();
    }
    if (offset !== blob.size) throw new Error('备份文件包含无法识别的尾部数据');
    for (const paperId of paperIds) if (!blobIds.has(paperId)) throw new Error('备份缺少文献对应的 PDF 文件');
    return { header, blobs };
  }

  function putEntry(store, entry) {
    if (!entry || !('value' in entry)) throw new Error(store + ' 中存在无效记录');
    if (store === 'usage') return entry;
    return { key: undefined, value: entry.value };
  }

  async function applyReplace(parsed) {
    await flushLiveData();
    await App.leaveReader();
    const stores = [...DATA_STORES, 'blobs'];
    await DB.batch(stores, tx => {
      for (const name of stores) tx.objectStore(name).clear();
      for (const name of DATA_STORES) {
        const target = tx.objectStore(name);
        for (const raw of parsed.header.stores[name]) {
          const entry = putEntry(name, raw);
          if (name === 'usage' && entry.key != null) target.put(entry.value, entry.key);
          else target.put(entry.value);
        }
      }
      const target = tx.objectStore('blobs');
      for (const rec of parsed.blobs) target.put(rec);
    });
    const local = parsed.header.localStorage || {};
    if (local.settings && typeof local.settings === 'object') {
      const restored = clone(local.settings);
      if (!parsed.header.secretsIncluded && Array.isArray(restored.aiProfiles)) {
        const currentKeys = new Map((Settings.data.aiProfiles || []).map(profile => [profile.id, profile.apiKey || '']));
        for (const profile of restored.aiProfiles) profile.apiKey = currentKeys.get(profile.id) || '';
      }
      Settings.data = restored;
      Settings.save();
    }
    for (const key of LOCAL_KEYS) {
      try {
        if (local[key] == null) localStorage.removeItem(key); else localStorage.setItem(key, local[key]);
      } catch (_) {}
    }
    location.reload();
  }

  async function applyMerge(parsed) {
    await flushLiveData();
    const wsMap = new Map(), paperMap = new Map();
    const currentWsIds = new Set((await DB.all('workspaces')).map(x => x.id));
    const currentPaperIds = new Set((await DB.all('papers')).map(x => x.id));
    const mapped = {};
    for (const name of DATA_STORES) mapped[name] = [];
    for (const raw of parsed.header.stores.workspaces) {
      const ws = clone(raw.value);
      let id = ws.id;
      while (currentWsIds.has(id)) id = uid();
      currentWsIds.add(id); wsMap.set(ws.id, id); ws.id = id;
      if (id !== raw.value.id) ws.name = (ws.name || '工作区') + ' · 导入';
      mapped.workspaces.push(ws);
    }
    for (const raw of parsed.header.stores.papers) {
      const paper = clone(raw.value);
      let id = paper.id;
      while (currentPaperIds.has(id)) id = uid();
      currentPaperIds.add(id); paperMap.set(paper.id, id); paper.id = id; paper.wsId = wsMap.get(paper.wsId);
      mapped.papers.push(paper);
    }
    for (const name of ['notes', 'annos', 'cards', 'chats', 'searchDocs']) {
      for (const raw of parsed.header.stores[name]) {
        const value = clone(raw.value); value.paperId = paperMap.get(value.paperId); mapped[name].push(value);
      }
    }
    for (const raw of parsed.header.stores.usage) {
      const value = clone(raw.value);
      if (value.paperId != null) value.paperId = paperMap.get(value.paperId);
      mapped.usage.push(value);
    }
    const mappedBlobs = parsed.blobs.map(rec => ({ paperId: paperMap.get(rec.paperId), blob: rec.blob }));
    const stores = [...DATA_STORES, 'blobs'];
    await DB.batch(stores, tx => {
      for (const name of DATA_STORES) for (const value of mapped[name]) tx.objectStore(name).put(value);
      for (const rec of mappedBlobs) tx.objectStore('blobs').put(rec);
    });
    await App.init();
    UI.render();
    UI.toast('备份已合并：新增 ' + mapped.workspaces.length + ' 个工作区、' + mapped.papers.length + ' 篇文献');
  }

  function fileName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return '科研阅读工作台-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.rdwb';
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name || fileName();
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function exportDownload(includeSecrets) {
    UI.toast('正在生成完整备份…');
    try {
      const bundle = await buildBundle({ includeSecrets: !!includeSecrets });
      download(bundle);
      UI.toast('备份已下载（' + fmtSize(bundle.size) + '）');
    } catch (e) { UI.toast('导出失败：' + e.message, 'error'); }
  }

  async function importFile(file) {
    UI.toast('正在校验备份…');
    try {
      const parsed = await parseBundle(file);
      const h = parsed.header;
      const body = '<div class="backup-preview">' +
        '<div><b>' + esc(String(h.counts?.workspaces ?? h.stores.workspaces.length)) + '</b><span>工作区</span></div>' +
        '<div><b>' + esc(String(h.counts?.papers ?? h.stores.papers.length)) + '</b><span>文献</span></div>' +
        '<div><b>' + esc(fmtSize(file.size)) + '</b><span>文件大小</span></div></div>' +
        '<p>创建于 ' + esc(new Date(h.createdAt).toLocaleString()) + ' · 应用 v' + esc(h.appVersion || '未知') + '</p>' +
        (h.secretsIncluded ? '<div class="backup-warning">该备份包含模型 API Key。仅在你信任的设备上恢复。</div>' : '') +
        '<div class="backup-choice"><b>合并</b>会保留当前资料，并把备份作为新工作区加入。<br><b>替换</b>会以此备份覆盖当前全部资料与设置。</div>';
      UI.modal('导入已通过完整性校验', body, [
        { label: '取消' },
        { label: '合并导入', cls: 'btn-plain', onClick: () => { applyMerge(parsed).catch(e => UI.toast('导入失败：' + e.message, 'error')); } },
        { label: '替换全部', cls: 'btn-danger-main', onClick: () => { setTimeout(() => confirmReplace(parsed), 0); } }
      ], { wide: true });
    } catch (e) { UI.toast('无法导入：' + e.message, 'error'); }
  }

  async function confirmReplace(parsed) {
    const ok = await UI.confirm('确认替换全部数据', '当前工作区、PDF、笔记、标注、对话和设置都会被备份内容替换。建议先导出当前数据。', '确认替换', true);
    if (ok) applyReplace(parsed).catch(e => UI.toast('恢复失败，当前数据未被替换：' + e.message, 'error'));
  }

  async function snapshots() {
    return (await DB.all('backups')).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function pruneSnapshots(retention) {
    const all = await snapshots();
    for (const old of all.slice(retention)) await DB.del('backups', old.id);
  }

  async function createSnapshot(manual) {
    const cfg = config();
    cfg.lastAttemptAt = Date.now(); Settings.save();
    if (!(await DB.all('papers')).length) return null;
    try {
      const bundle = await buildBundle({ includeSecrets: false });
      const row = {
        id: uid(), createdAt: Date.now(), size: bundle.size,
        summary: { workspaces: (await DB.all('workspaces')).length, papers: (await DB.all('papers')).length },
        bundle
      };
      await DB.put('backups', row);
      await pruneSnapshots(cfg.retention);
      cfg.lastAt = row.createdAt; Settings.save();
      if (manual) UI.toast('本地快照已创建（' + fmtSize(bundle.size) + '）');
      return row;
    } catch (e) {
      if (manual) UI.toast('快照创建失败：' + e.message, 'error');
      throw e;
    }
  }

  async function deleteSnapshot(id) {
    await DB.del('backups', id); openManager();
  }

  async function restoreSnapshot(id) {
    const row = await DB.get('backups', id);
    if (!row) return UI.toast('找不到该快照', 'error');
    try { confirmReplace(await parseBundle(row.bundle)); }
    catch (e) { UI.toast('快照损坏：' + e.message, 'error'); }
  }

  async function openManager() {
    const cfg = config();
    const all = await snapshots();
    const rows = all.length ? all.map(row =>
      '<div class="backup-row" data-id="' + esc(row.id) + '"><div><b>' + esc(new Date(row.createdAt).toLocaleString()) + '</b>' +
      '<span>' + esc(String(row.summary?.papers || 0)) + ' 篇 · ' + esc(fmtSize(row.size || row.bundle?.size || 0)) + '</span></div>' +
      '<div><button class="btn-ghost-sm" data-act="download">下载</button><button class="btn-ghost-sm" data-act="restore">恢复</button><button class="ibtn danger" data-act="delete" aria-label="删除快照">' + icon('trash', 15) + '</button></div></div>'
    ).join('') : '<div class="backup-empty">还没有本地快照</div>';
    const body = '<div class="backup-actions"><button id="backup-export" class="btn-primary">' + icon('upload', 15) + ' 导出完整备份</button>' +
      '<button id="backup-import" class="btn-plain">导入 .rdwb</button></div>' +
      '<label class="backup-secret"><input type="checkbox" id="backup-secrets"> 导出时包含模型 API Key <span>（敏感信息，默认不包含）</span></label>' +
      '<div class="backup-auto"><label><input type="checkbox" id="backup-enabled"' + (cfg.enabled ? ' checked' : '') + '> 开启浏览器内自动快照</label>' +
      '<label>间隔 <select id="backup-interval"><option value="12">12 小时</option><option value="24">每天</option><option value="72">每 3 天</option><option value="168">每周</option></select></label>' +
      '<label>保留 <select id="backup-retention"><option value="1">1 份</option><option value="2">2 份</option><option value="3">3 份</option><option value="5">5 份</option></select></label>' +
      '<button id="backup-now" class="btn-plain">立即创建快照</button></div>' +
      '<div class="backup-warning">自动快照只保存在当前浏览器，并且不含 API Key。清除本站数据、重装浏览器或设备损坏时，快照也会消失；请定期下载完整备份。</div>' +
      '<h4 class="backup-list-title">浏览器内快照</h4><div class="backup-list">' + rows + '</div>';
    const layer = UI.modal('数据备份与恢复', body, [{ label: '完成' }], { wide: true });
    layer.querySelector('#backup-interval').value = String(cfg.intervalHours);
    layer.querySelector('#backup-retention').value = String(cfg.retention);
    layer.querySelector('#backup-export').onclick = () => exportDownload(layer.querySelector('#backup-secrets').checked);
    layer.querySelector('#backup-import').onclick = () => document.getElementById('backup-input').click();
    const saveCfg = () => {
      cfg.enabled = layer.querySelector('#backup-enabled').checked;
      cfg.intervalHours = Number(layer.querySelector('#backup-interval').value);
      cfg.retention = Number(layer.querySelector('#backup-retention').value);
      Settings.save(); pruneSnapshots(cfg.retention).catch(saveError);
    };
    layer.querySelectorAll('#backup-enabled,#backup-interval,#backup-retention').forEach(el => el.addEventListener('change', saveCfg));
    layer.querySelector('#backup-now').onclick = async () => { await createSnapshot(true).catch(() => {}); openManager(); };
    layer.querySelectorAll('.backup-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('[data-act="download"]').onclick = async () => { const rec = await DB.get('backups', id); if (rec) download(rec.bundle, fileName()); };
      row.querySelector('[data-act="restore"]').onclick = () => restoreSnapshot(id);
      row.querySelector('[data-act="delete"]').onclick = async () => { if (await UI.confirm('删除本地快照', '该快照将从当前浏览器中删除。', '删除', true)) deleteSnapshot(id); };
    });
  }

  async function maybeAutoBackup() {
    const cfg = config();
    if (!cfg.enabled || document.visibilityState === 'hidden') return;
    if (Date.now() - Number(cfg.lastAttemptAt || 0) < cfg.intervalHours * 3600000) return;
    await createSnapshot(false).catch(e => console.warn('自动备份失败', e));
  }

  function init() {
    config(); Settings.save();
    const input = document.getElementById('backup-input');
    input.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0]; e.target.value = '';
      if (file) importFile(file);
    });
    clearInterval(timer);
    timer = setInterval(maybeAutoBackup, 10 * 60 * 1000);
    setTimeout(maybeAutoBackup, 30000);
  }

  return { init, openManager, buildBundle, parseBundle, importFile, createSnapshot, snapshots, applyMerge, applyReplace };
})();
