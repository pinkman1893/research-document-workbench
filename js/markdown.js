/* Local Markdown renderer. Never insert Marked output before sanitizing it. */
const Markdown = {
  render(value, citations = false) {
    const text = String(value || '');
    if (!text) return '';
    if (!window.marked || !window.DOMPurify) return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    const html = marked.parse(text, { gfm: true, breaks: true, async: false });
    const fragment = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p','br','strong','em','del','s','code','pre','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','hr','a','img','table','thead','tbody','tr','th','td','input'],
      ALLOWED_ATTR: ['href','src','alt','title','start','type','checked','disabled','align'],
      ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
    });
    const safeURL = raw => {
      try { const u = new URL(raw, location.href); return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null; }
      catch (_) { return null; }
    };
    fragment.querySelectorAll('a').forEach(a => {
      const url = safeURL(a.getAttribute('href') || '');
      if (!url) a.removeAttribute('href');
      else { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    // Remote image URLs may contain private model context. Do not fetch them automatically.
    fragment.querySelectorAll('img').forEach(img => {
      const a = document.createElement('a'), url = safeURL(img.getAttribute('src') || '');
      a.textContent = '图片：' + (img.getAttribute('alt') || '点击查看');
      if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      img.replaceWith(a);
    });
    fragment.querySelectorAll('input').forEach(input => {
      if (input.getAttribute('type') !== 'checkbox') input.remove();
      else input.disabled = true;
    });
    fragment.querySelectorAll('table').forEach(table => {
      const wrap = document.createElement('div'); wrap.className = 'md-table-wrap';
      table.replaceWith(wrap); wrap.appendChild(table);
    });
    if (citations) {
      // Only replace text nodes; code, links and attributes must remain literal.
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        if (node.parentElement?.closest('pre, code, a')) continue;
        const re = /[（【\[]\s*[Pp](\d+)\s*(?:[|｜]([^\]】）]{1,80}))?\s*[\]】）]/g;
        let match, last = 0; const replacement = document.createDocumentFragment();
        while ((match = re.exec(node.textContent))) {
          replacement.append(node.textContent.slice(last, match.index));
          const cite = document.createElement('span'); cite.className = 'cite';
          cite.dataset.page = match[1]; cite.dataset.q = (match[2] || '').trim();
          cite.title = cite.dataset.q || '跳转到 P' + match[1]; cite.textContent = 'P' + match[1];
          replacement.append(cite); last = re.lastIndex;
        }
        if (last) { replacement.append(node.textContent.slice(last)); node.replaceWith(replacement); }
      }
      fragment.querySelectorAll('p').forEach(p => {
        if (!/^(评[:：]|（评）)/.test(p.textContent.trim())) return;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent.trim()) continue;
          const prefix = node.textContent.match(/^\s*(?:评[:：]|（评）)\s*/);
          if (prefix) node.textContent = node.textContent.slice(prefix[0].length);
          break;
        }
        const tag = document.createElement('span');
        tag.className = 'opinion-tag'; tag.textContent = '我的看法';
        p.prepend(tag);
        p.classList.add('ai-opinion');
      });
    }
    const wrapper = document.createElement('div'); wrapper.append(fragment); return wrapper.innerHTML;
  }
};
