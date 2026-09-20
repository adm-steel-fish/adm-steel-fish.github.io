(function () {
  const unsupportedMsg = document.getElementById('unsupported-msg');

  const articleSelect = document.getElementById('article-select');
  const fieldTitle = document.getElementById('field-title');
  const fieldTag = document.getElementById('field-tag');
  const fieldDate = document.getElementById('field-date');
  const fieldSummary = document.getElementById('field-summary');
  const contentEditable = document.getElementById('content-editable');

  const thumbnailPreview = document.getElementById('thumbnail-preview');
  const thumbnailEmpty = document.getElementById('thumbnail-empty');
  const thumbnailFile = document.getElementById('thumbnail-file');
  const thumbnailLinkBtn = document.getElementById('thumbnail-link-btn');
  const thumbnailRemoveBtn = document.getElementById('thumbnail-remove-btn');

  const saveBtn = document.getElementById('save-btn');
  const saveStatus = document.getElementById('save-status');

  let rootDir = null;   // the site folder, granted once up front
  let fileHandle = null; // news-data.js inside it
  let headerText = '';
  let articles = [];
  let currentArticle = null; // null = new article
  let currentDateIso = '';
  let currentThumbnail = '';
  let savedRange = null;

  if (!window.showDirectoryPicker) {
    unsupportedMsg.hidden = false;
    document.getElementById('editor-form').hidden = true;
    return;
  }

  function todayIso() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // previewSrc lets a freshly uploaded file preview from memory: its recorded
  // path won't resolve until the new image is deployed alongside the article.
  function setThumbnail(path, previewSrc) {
    currentThumbnail = path || '';
    if (currentThumbnail) {
      thumbnailPreview.src = previewSrc || currentThumbnail;
      thumbnailPreview.hidden = false;
      thumbnailEmpty.hidden = true;
    } else {
      thumbnailPreview.src = '';
      thumbnailPreview.hidden = true;
      thumbnailEmpty.hidden = false;
    }
  }

  function populateArticleSelect() {
    articleSelect.innerHTML = '';
    const newOption = document.createElement('option');
    newOption.value = 'new';
    newOption.textContent = '+ New Article';
    articleSelect.appendChild(newOption);

    [...articles]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .forEach(article => {
        const option = document.createElement('option');
        option.value = String(article.id);
        option.textContent = formatDate(article.date) + ' — ' + article.title;
        articleSelect.appendChild(option);
      });
  }

  function loadArticleIntoForm(article) {
    currentArticle = article;
    if (article) {
      fieldTitle.value = article.title || '';
      fieldTag.value = article.tag || '';
      currentDateIso = article.date;
      fieldDate.value = formatDate(article.date);
      fieldSummary.value = article.summary || '';
      contentEditable.innerHTML = article.content || '';
      setThumbnail(article.thumbnail || '');
    } else {
      fieldTitle.value = '';
      fieldTag.value = '';
      currentDateIso = todayIso();
      fieldDate.value = formatDate(currentDateIso);
      fieldSummary.value = '';
      contentEditable.innerHTML = '';
      setThumbnail('');
    }
    saveStatus.textContent = '';
  }

  articleSelect.addEventListener('change', () => {
    if (articleSelect.value === 'new') {
      loadArticleIntoForm(null);
    } else {
      const id = parseInt(articleSelect.value, 10);
      const article = articles.find(a => a.id === id);
      loadArticleIntoForm(article || null);
    }
  });

  // ---- Loading / saving news-data.js ----

  const loadDataBtn = document.getElementById('load-data-btn');
  const dataStatus = document.getElementById('data-status');
  const editorForm = document.getElementById('editor-form');

  loadDataBtn.addEventListener('click', async () => {
    try {
      // One readwrite grant on the site folder covers both news-data.js and
      // the images/news/ folder that uploads are written into, so no other
      // step needs a file dialog of its own.
      const dir = await window.showDirectoryPicker({ id: 'sfs-site', mode: 'readwrite' });
      if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        dataStatus.textContent = 'Permission to write to that folder was denied.';
        return;
      }

      try {
        fileHandle = await dir.getFileHandle('news-data.js');
      } catch (err) {
        if (err.name !== 'NotFoundError') throw err;
        alert('No news-data.js in "' + dir.name + '". Please choose the folder that contains it (the Steel Fish Studios folder itself, not images/ or docs/).');
        dataStatus.textContent = 'No news-data.js in that folder.';
        return;
      }
      rootDir = dir;

      const file = await fileHandle.getFile();
      const text = await file.text();

      const marker = 'const NEWS_ARTICLES = [';
      const idx = text.indexOf(marker);
      if (idx === -1) {
        alert('Could not find "const NEWS_ARTICLES = [" in news-data.js.');
        rootDir = null;
        fileHandle = null;
        return;
      }
      headerText = text.slice(0, idx) + marker + '\n';

      const getArticles = new Function(text + '\nreturn NEWS_ARTICLES;');
      articles = getArticles();

      populateArticleSelect();
      loadArticleIntoForm(null);
      editorForm.hidden = false;
      dataStatus.textContent = 'Loaded ' + articles.length + ' article(s) from ' + dir.name + '/news-data.js.';
    } catch (err) {
      if (err.name !== 'AbortError') {
        alert('Error opening the site folder: ' + err.message);
        dataStatus.textContent = 'Error: ' + err.message;
      }
    }
  });

  // Filenames end up in a URL, so keep them to characters that survive one.
  function safeFileName(name) {
    const dot = name.lastIndexOf('.');
    const stem = (dot > 0 ? name.slice(0, dot) : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';
    const ext = (dot > 0 ? name.slice(dot + 1) : '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return ext ? stem + '.' + ext : stem;
  }

  async function uniqueName(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; ; n++) {
      try {
        await dir.getFileHandle(candidate); // resolves only if it already exists
      } catch (err) {
        if (err.name === 'NotFoundError') return candidate;
        throw err;
      }
      candidate = stem + '-' + n + ext;
    }
  }

  // Copies a picked file into images/news/ and returns the path to record.
  // No file dialog here: showSaveFilePicker() needs transient user activation,
  // which is already gone by the time an <input type="file"> change event
  // fires, so the write goes through the folder handle granted up front.
  async function saveMediaFile(file) {
    if (!rootDir) {
      alert('Choose your site folder first.');
      return null;
    }
    try {
      const images = await rootDir.getDirectoryHandle('images', { create: true });
      const newsDir = await images.getDirectoryHandle('news', { create: true });
      const name = await uniqueName(newsDir, safeFileName(file.name));
      const handle = await newsDir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return 'images/news/' + name;
    } catch (err) {
      alert('Error saving ' + file.name + ': ' + err.message);
      return null;
    }
  }

  // ---- Thumbnail controls ----

  thumbnailFile.addEventListener('change', async () => {
    const file = thumbnailFile.files[0];
    if (!file) return;
    const path = await saveMediaFile(file);
    if (path) setThumbnail(path, URL.createObjectURL(file));
    thumbnailFile.value = '';
  });

  thumbnailLinkBtn.addEventListener('click', () => {
    const url = prompt('Enter the image URL for the thumbnail:');
    if (url) setThumbnail(url.trim());
  });

  thumbnailRemoveBtn.addEventListener('click', () => {
    setThumbnail('');
  });

  // ---- Rich text content editor ----

  function rememberSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && contentEditable.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0);
    }
  }

  contentEditable.addEventListener('keyup', rememberSelection);
  contentEditable.addEventListener('mouseup', rememberSelection);
  contentEditable.addEventListener('blur', rememberSelection);

  // Clicking an image/video/iframe selects it as a whole, so Backspace/Delete removes it.
  contentEditable.addEventListener('click', (e) => {
    const target = e.target;
    if (target.tagName === 'IMG' || target.tagName === 'VIDEO' || target.tagName === 'IFRAME') {
      const range = document.createRange();
      range.selectNode(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      rememberSelection();
    }
  });

  function restoreSelection() {
    contentEditable.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (savedRange) {
      sel.addRange(savedRange);
    } else {
      const range = document.createRange();
      range.selectNodeContents(contentEditable);
      range.collapse(false);
      sel.addRange(range);
    }
  }

  function insertHtml(html) {
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    rememberSelection();
  }

  document.querySelectorAll('.rte-toolbar [data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      restoreSelection();
      const cmd = btn.dataset.cmd;
      const value = btn.dataset.value || null;
      document.execCommand(cmd, false, value);
      rememberSelection();
    });
  });

  document.getElementById('rte-link-btn').addEventListener('click', () => {
    const url = prompt('Enter the link URL:');
    if (!url) return;
    restoreSelection();
    const sel = window.getSelection();
    if (sel.toString().length > 0) {
      document.execCommand('createLink', false, url.trim());
    } else {
      const text = prompt('Enter the link text:', url);
      insertHtml('<a href="' + escapeHtml(url.trim()) + '" target="_blank">' + escapeHtml(text || url) + '</a>');
    }
    rememberSelection();
  });

  document.getElementById('rte-image-link-btn').addEventListener('click', () => {
    const url = prompt('Enter the image URL:');
    if (!url) return;
    insertHtml('<img src="' + escapeHtml(url.trim()) + '" alt="">');
  });

  document.getElementById('rte-image-file').addEventListener('change', async () => {
    const input = document.getElementById('rte-image-file');
    const file = input.files[0];
    if (!file) return;
    const path = await saveMediaFile(file);
    if (path) insertHtml('<img src="' + escapeHtml(path) + '" alt="">');
    input.value = '';
  });

  function youtubeEmbedUrl(url) {
    let id = null;
    let watchMatch = url.match(/[?&]v=([^&]+)/);
    let shortMatch = url.match(/youtu\.be\/([^?&]+)/);
    let embedMatch = url.match(/youtube\.com\/embed\/([^?&]+)/);
    let shortsMatch = url.match(/youtube\.com\/shorts\/([^?&]+)/);
    if (watchMatch) id = watchMatch[1];
    else if (shortMatch) id = shortMatch[1];
    else if (embedMatch) id = embedMatch[1];
    else if (shortsMatch) id = shortsMatch[1];
    return id ? 'https://www.youtube.com/embed/' + id : null;
  }

  document.getElementById('rte-video-link-btn').addEventListener('click', () => {
    const url = prompt('Enter a video URL (YouTube link, or a direct video file link):');
    if (!url) return;
    const trimmed = url.trim();
    const embedUrl = youtubeEmbedUrl(trimmed);
    if (embedUrl) {
      insertHtml(
        '<iframe width="560" height="315" src="' + escapeHtml(embedUrl) + '" title="Video Player" ' +
        'frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen loading="lazy"></iframe>'
      );
    } else {
      insertHtml('<video controls src="' + escapeHtml(trimmed) + '"></video>');
    }
  });

  document.getElementById('rte-video-file').addEventListener('change', async () => {
    const input = document.getElementById('rte-video-file');
    const file = input.files[0];
    if (!file) return;
    const path = await saveMediaFile(file);
    if (path) insertHtml('<video controls src="' + escapeHtml(path) + '"></video>');
    input.value = '';
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Save ----

  function serializeArticle(article) {
    const lines = [];
    lines.push('  {');
    lines.push('    id: ' + article.id + ',');
    lines.push('    date: ' + JSON.stringify(article.date) + ',');
    if (article.tag) lines.push('    tag: ' + JSON.stringify(article.tag) + ',');
    if (article.thumbnail) lines.push('    thumbnail: ' + JSON.stringify(article.thumbnail) + ',');
    lines.push('    title: ' + JSON.stringify(article.title) + ',');
    lines.push('    summary: ' + JSON.stringify(article.summary) + ',');
    lines.push('    content: ' + JSON.stringify(article.content || '') + ',');
    lines.push('  },');
    return lines.join('\n');
  }

  async function writeNewsData() {
    const body = articles.map(serializeArticle).join('\n');
    const fullText = headerText + body + '\n];\n';
    const writable = await fileHandle.createWritable();
    await writable.write(fullText);
    await writable.close();
  }

  saveBtn.addEventListener('click', async () => {
    const title = fieldTitle.value.trim();
    const tag = fieldTag.value.trim();
    const summary = fieldSummary.value.trim();
    const content = contentEditable.innerHTML.trim();

    if (!title || !summary) {
      saveStatus.textContent = 'Title and summary are required.';
      return;
    }

    if (currentArticle) {
      currentArticle.title = title;
      currentArticle.tag = tag;
      currentArticle.thumbnail = currentThumbnail;
      currentArticle.summary = summary;
      currentArticle.content = content;
    } else {
      const newId = articles.length ? Math.max(...articles.map(a => a.id)) + 1 : 1;
      currentArticle = {
        id: newId,
        date: currentDateIso,
        tag: tag,
        thumbnail: currentThumbnail,
        title: title,
        summary: summary,
        content: content,
      };
      articles.unshift(currentArticle);
    }

    try {
      await writeNewsData();
      populateArticleSelect();
      articleSelect.value = String(currentArticle.id);
      saveStatus.textContent = 'Saved!';
    } catch (err) {
      saveStatus.textContent = 'Error saving: ' + err.message;
    }
  });
})();
