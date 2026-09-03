/* 启动入口 */
(async function boot() {
  Settings.load();
  UI.init();
  if (location.protocol === 'file:') {
    UI.fatal('请双击项目目录中的「启动工作台.bat」启动。<br>新版 PDF 引擎需要本地 HTTP 服务，不能直接打开 index.html。');
    return;
  }
  try {
    window.PDF_ASSET_BASE = new URL('vendor/pdfjs-6.2.108/', location.href).href;
    window.pdfjsLib = await import(PDF_ASSET_BASE + 'pdf.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_ASSET_BASE + 'pdf.worker.mjs';
  } catch (e) {
    UI.fatal('PDF 引擎加载失败：' + esc(e.message) + '<br>请重新运行启动工作台.bat，确认 vendor 目录完整。');
    return;
  }

  try {
    await DB.open();
    await Recovery.restore();
  } catch (e) {
    UI.fatal('无法打开本地数据库：' + esc(e.message || e) + '<br><br>如果你是直接双击打开本页面，请改用项目目录中的「启动工作台.bat」启动。');
    return;
  }

  try {
    await App.init();
  } catch (e) {
    UI.fatal('初始化数据失败：' + esc(e.message || e));
    return;
  }

  UI.render();
  AI.init();

  // 阅读器滚动监听
  const sc = document.getElementById('reader-scroll');
  let ticking = false;
  sc.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; Reader.onScroll(); });
  });

  // 窗口尺寸变化 → 阅读器重排
  window.addEventListener('resize', () => Reader.onResize());
  const resizeObserver = new ResizeObserver(() => Reader.onResize());
  resizeObserver.observe(sc);

  // 离开页面前保存进度与标注
  const flush = checkpoint => {
    Reader._finishGesture?.();
    const journal = checkpoint || Recovery.checkpoint();
    return Promise.all([Reader.saveProgressNow(), Reader.saveAnnosNow(), Notes.save(), AI.flushChat(), AI.flushCardEdit(), DB.flush()]).then(() => Recovery.clear(journal.token));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush().catch(saveError);
  });
  window.addEventListener('pagehide', () => { flush().catch(saveError); });
  window.addEventListener('beforeunload', e => {
    Reader._finishGesture?.();
    const journal = Recovery.checkpoint();
    flush(journal).catch(saveError);
    // Journal survived synchronously, so normal closes need no confirmation.
    // If storage is full/unavailable, let the browser protect the unsaved edit.
    if (!journal.ok) { e.preventDefault(); e.returnValue = ''; }
  });
})();
