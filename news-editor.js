(function () {
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

  const API = '/api/news/';
  const PASSWORD_KEY = 'sfs-editor-password';
  const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Netlify Functions cap request bodies at 6 MB

  let password = '';
  let articles = [];
  let currentArticle = null; // null = new article
  let currentDateIso = '';
  let currentThumbnail = '';
  let savedRange = null;
  // Uploads waiting to be committed with the next Save, as { path, sha }.
  let pendingMedia = [];
  // Uploaded files preview from memory (blob: URLs) until they're deployed;
  // this maps each preview URL back to the path recorded in the article.
  const previewPaths = new Map();

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

  // ---- Signing in / loading articles ----

  const loginForm = document.getElementById('login-form');
  const loginPassword = document.getElementById('login-password');
  const loginStatus = document.getElementById('login-status');
  const signedIn = document.getElementById('signed-in');
  const dataStatus = document.getElementById('data-status');
  const editorForm = document.getElementById('editor-form');

  async function api(action, body) {
    const res = await fetch(API + action, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'X-Editor-Password': password },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (err) { /* non-JSON error page */ }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function rememberPassword(value) {
    try {
      if (value) sessionStorage.setItem(PASSWORD_KEY, value);
      else sessionStorage.removeItem(PASSWORD_KEY);
    } catch (err) { /* storage unavailable; just ask again next time */ }
  }

  async function signIn(value) {
    password = value;
    loginStatus.textContent = 'Signing in…';
    try {
      const { name } = await api('login', {});
      loginStatus.textContent = 'Loading articles…';
      articles = (await api('articles')).articles;
      rememberPassword(value);
      populateArticleSelect();
      loadArticleIntoForm(null);
      loginForm.hidden = true;
      signedIn.hidden = false;
      editorForm.hidden = false;
      dataStatus.textContent = 'Signed in as ' + name + ' · ' + articles.length + ' article(s).';
      loginStatus.textContent = '';
    } catch (err) {
      password = '';
      rememberPassword('');
      loginStatus.textContent = err.message;
    }
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (loginPassword.value) signIn(loginPassword.value);
  });

  document.getElementById('sign-out-btn').addEventListener('click', () => {
    password = '';
    rememberPassword('');
    loginPassword.value = '';
    editorForm.hidden = true;
    signedIn.hidden = true;
    loginForm.hidden = false;
  });

  try {
    const stored = sessionStorage.getItem(PASSWORD_KEY);
    if (stored) signIn(stored);
  } catch (err) { /* storage unavailable */ }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Uploads a picked file and returns a blob: URL to preview it with (mapped
  // to its images/news/ path on Save), or null if it failed.
  async function uploadMedia(file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      alert(file.name + ' is larger than 4 MB. Please use a smaller file, or host it elsewhere (e.g. YouTube) and use the link button.');
      return null;
    }
    saveStatus.textContent = 'Uploading ' + file.name + '…';
    try {
      const { path, sha } = await api('media', {
        filename: file.name,
        contentBase64: await readAsBase64(file),
      });
      pendingMedia.push({ path, sha });
      const preview = URL.createObjectURL(file);
      previewPaths.set(preview, path);
      saveStatus.textContent = 'Uploaded ' + file.name + ' — it goes live when you save.';
      return preview;
    } catch (err) {
      saveStatus.textContent = '';
      alert('Error uploading ' + file.name + ': ' + err.message);
      return null;
    }
  }

  function withRealPaths(html) {
    previewPaths.forEach((path, preview) => { html = html.split(preview).join(path); });
    return html;
  }

  // ---- Thumbnail controls ----

  thumbnailFile.addEventListener('change', async () => {
    const file = thumbnailFile.files[0];
    if (!file) return;
    thumbnailFile.value = '';
    const preview = await uploadMedia(file);
    if (preview) setThumbnail(previewPaths.get(preview), preview);
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
    input.value = '';
    const preview = await uploadMedia(file);
    if (preview) insertHtml('<img src="' + escapeHtml(preview) + '" alt="">');
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
    input.value = '';
    const preview = await uploadMedia(file);
    if (preview) insertHtml('<video controls src="' + escapeHtml(preview) + '"></video>');
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Save ----

  saveBtn.addEventListener('click', async () => {
    const title = fieldTitle.value.trim();
    const summary = fieldSummary.value.trim();
    if (!title || !summary) {
      saveStatus.textContent = 'Title and summary are required.';
      return;
    }

    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';
    try {
      const { article } = await api('save', {
        article: {
          id: currentArticle ? currentArticle.id : null,
          date: currentDateIso,
          title: title,
          tag: fieldTag.value.trim(),
          thumbnail: currentThumbnail,
          summary: summary,
          content: withRealPaths(contentEditable.innerHTML.trim()),
        },
        media: pendingMedia,
      });
      pendingMedia = [];

      const i = articles.findIndex(a => a.id === article.id);
      if (i === -1) articles.unshift(article);
      else articles[i] = article;
      currentArticle = article;
      populateArticleSelect();
      articleSelect.value = String(article.id);
      saveStatus.textContent = 'Saved! The site updates in about a minute.';
    } catch (err) {
      saveStatus.textContent = 'Error saving: ' + err.message;
      if (err.status === 401) alert('Your editor password is no longer valid. Please sign out and sign in again.');
    } finally {
      saveBtn.disabled = false;
    }
  });
})();
