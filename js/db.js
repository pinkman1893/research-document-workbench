/* IndexedDB 本地持久化封装 —— 所有数据真实落盘，重启完整恢复 */
const DB = (() => {
  let _db = null;
  const DB_NAME = 'rd_db';
  const VERSION = 2;
  const STORES = ['workspaces', 'papers', 'blobs', 'notes', 'annos', 'cards', 'chats', 'usage', 'searchDocs', 'backups'];
  const pending = new Set();

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('workspaces')) d.createObjectStore('workspaces', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('papers')) {
          const papers = d.createObjectStore('papers', { keyPath: 'id' });
          papers.createIndex('wsId', 'wsId', { unique: false });
        }
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('annos')) d.createObjectStore('annos', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('usage')) d.createObjectStore('usage', { autoIncrement: true });
        if (!d.objectStoreNames.contains('searchDocs')) d.createObjectStore('searchDocs', { keyPath: 'paperId' });
        if (!d.objectStoreNames.contains('backups')) {
          const backups = d.createObjectStore('backups', { keyPath: 'id' });
          backups.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      r.onsuccess = () => {
        _db = r.result;
        _db.onversionchange = () => { _db.close(); _db = null; UI.toast('数据库已更新，请刷新此页面', 'error'); };
        resolve(_db);
      };
      r.onerror = () => reject(r.error);
    });
  }

  function transaction(stores, mode, fn) {
    const promise = new Promise((resolve, reject) => {
      if (!_db) { reject(new Error('数据库未打开')); return; }
      let t, result;
      try {
        t = _db.transaction(stores, mode);
        t.oncomplete = () => resolve(result);
        t.onabort = () => reject(t.error || new Error('数据库事务已取消，数据未保存'));
        t.onerror = () => {}; // request 错误默认中止整个事务；只在 onabort 拒绝。
        fn(t, value => { result = value; });
      } catch (err) { if (t) { try { t.abort(); } catch (_) {} } reject(err); }
    });
    if (mode === 'readwrite') {
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
    }
    return promise;
  }

  function req(store, mode, fn) {
    return transaction([store], mode, (t, done) => {
      const r = fn(t.objectStore(store));
      r.onsuccess = () => done(r.result);
    });
  }

  return {
    open,
    get: (store, key) => req(store, 'readonly', s => s.get(key)),
    put: (store, val) => req(store, 'readwrite', s => s.put(val)),
    del: (store, key) => req(store, 'readwrite', s => s.delete(key)),
    all: (store) => req(store, 'readonly', s => s.getAll()),
    entries: store => transaction([store], 'readonly', (t, done) => {
      const values = [];
      const r = t.objectStore(store).openCursor();
      r.onsuccess = () => {
        const cursor = r.result;
        if (!cursor) { done(values); return; }
        values.push({ key: cursor.primaryKey, value: cursor.value });
        cursor.continue();
      };
    }),
    clear: (store) => req(store, 'readwrite', s => s.clear()),
    batch: (stores, fn) => transaction(stores, 'readwrite', t => fn(t)),
    flush: () => Promise.all([...pending]),
    hasPending: () => pending.size > 0,
    isOpen: () => !!_db,
    stores: () => STORES.slice(),
    version: () => VERSION
  };
})();

/* localStorage 保存的轻量设置（AI 模型配置等） */
const Settings = {
  KEY: 'rd_settings_v1',
  data: { aiProfiles: [], activeProfileId: null, ui: {} },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) {
        const d = JSON.parse(raw);
        this.data = Object.assign(this.data, d);
      }
    } catch (e) { /* 忽略损坏的设置 */ }
    if (!Array.isArray(this.data.aiProfiles)) this.data.aiProfiles = [];
  },
  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) {
      UI.toast('设置保存失败：' + e.message, 'error');
    }
  },
  profiles() { return this.data.aiProfiles; },
  activeProfile() {
    return this.data.aiProfiles.find(p => p.id === this.data.activeProfileId) || this.data.aiProfiles[0] || null;
  },
  setActive(id) { this.data.activeProfileId = id; this.save(); },
  upsertProfile(p) {
    const i = this.data.aiProfiles.findIndex(x => x.id === p.id);
    if (i >= 0) this.data.aiProfiles[i] = p; else this.data.aiProfiles.push(p);
    this.save();
  },
  removeProfile(id) {
    this.data.aiProfiles = this.data.aiProfiles.filter(p => p.id !== id);
    if (this.data.activeProfileId === id) this.data.activeProfileId = this.data.aiProfiles.length ? this.data.aiProfiles[0].id : null;
    this.save();
  },
  newProfile() {
    return {
      id: uid(), name: '新模型配置', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat',
      thinking: 'off', sendReasoning: true, inPrice: 0, outPrice: 0, maxChars: 120000
    };
  }
};
