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

  let fileHandle = null;
  let headerText = '';
  let articles = [];
  let currentArticle = null; // null = new article
  let currentDateIso = '';
  let currentThumbnail = '';
  let savedRange = null;

  if (!window.showOpenFilePicker || !window.showSaveFilePicker) {
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

  function setThumbnail(path) {
    currentThumbnail = path || '';
    if (currentThumbnail) {
      thumbnailPreview.src = currentThumbnail;
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
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JavaScript file', accept: { 'text/javascript': ['.js'] } }],
        excludeAcceptAllOption: false,
      });
      fileHandle = handle;
      if ((await fileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        await fileHandle.requestPermission({ mode: 'readwrite' });
      }
      const file = await fileHandle.getFile();
      const text = await file.text();

      const marker = 'const NEWS_ARTICLES = [';
      const idx = text.indexOf(marker);
      if (idx === -1) {
        alert('Could not find "const NEWS_ARTICLES = [" in the selected file. Please make sure you opened news-data.js.');
        fileHandle = null;
        return;
      }
      headerText = text.slice(0, idx) + marker + '\n';

      const getArticles = new Function(text + '\nreturn NEWS_ARTICLES;');
      articles = getArticles();

      populateArticleSelect();
      loadArticleIntoForm(null);
      editorForm.hidden = false;
      dataStatus.textContent = 'Loaded ' + articles.length + ' article(s) from ' + fileHandle.name + '.';
    } catch (err) {
      if (err.name !== 'AbortError') {
        alert('Error opening news-data.js: ' + err.message);
        dataStatus.textContent = 'Error: ' + err.message;
      }
    }
  });

  async function saveMediaFile(file) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: file.name });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return 'images/news/' + handle.name;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      alert('Error saving file: ' + err.message);
      return null;
    }
  }

  // ---- Thumbnail controls ----

  thumbnailFile.addEventListener('change', async () => {
    const file = thumbnailFile.files[0];
    if (!file) return;
    const path = await saveMediaFile(file);
    if (path) setThumbnail(path);
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
    if (watchMatch) id = watchMatch[1];
    else if (shortMatch) id = shortMatch[1];
    else if (embedMatch) id = embedMatch[1];
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
