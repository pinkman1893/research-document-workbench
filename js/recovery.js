/* Synchronous close-time journal. IndexedDB is authoritative after commit. */
const Recovery = {
  key: 'rd_recovery_v1',
  checkpoint() {
    const rows = [];
    if (Notes.paperId && Notes._dirty) rows.push({ store: 'notes', record: { paperId: Notes.paperId, text: Notes.text, updatedAt: Date.now() } });
    if (Reader.paperId && Reader._annosDirty) rows.push({ store: 'annos', record: { ...Reader.annos, paperId: Reader.paperId, updatedAt: Date.now() } });
    if (AI.paperId && (AI._chatDirty || AI._chatSaving)) rows.push({ store: 'chats', record: { paperId: AI.paperId, messages: AI.messages, updatedAt: Date.now() } });
    if (AI._cardEditDirty && AI._cardDraft) rows.push({ store: 'cards', record: AI._cardDraft });
    if (!rows.length) return { ok: true, token: null };
    const journal = { token: uid(), rows };
    try { localStorage.setItem(this.key, JSON.stringify(journal)); return { ok: true, token: journal.token }; }
    catch (error) { console.warn('关闭恢复日志写入失败', error); return { ok: false, token: null }; }
  },
  clear(token) {
    if (!token) return;
    try { if (JSON.parse(localStorage.getItem(this.key) || 'null')?.token === token) localStorage.removeItem(this.key); } catch (_) {}
  },
  async restore() {
    let journal;
    try { journal = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (_) { return; }
    if (!journal || !Array.isArray(journal.rows)) return;
    const rows = [];
    for (const row of journal.rows) {
      if (!['notes', 'annos', 'chats', 'cards'].includes(row.store) || !row.record?.paperId) continue;
      if (!await DB.get('papers', row.record.paperId)) continue;
      const current = await DB.get(row.store, row.record.paperId);
      const stamp = x => x?.updatedAt || x?.editedAt || x?.generatedAt || 0;
      if (stamp(current) <= stamp(row.record)) rows.push(row);
    }
    if (rows.length) await DB.batch([...new Set(rows.map(row => row.store))], t => {
      for (const row of rows) t.objectStore(row.store).put(row.record);
    });
    this.clear(journal.token);
    if (rows.length) UI.toast('已恢复上次关闭前尚未保存的内容');
  }
};
