(function () {
  const params = new URLSearchParams(window.location.search);
  const id = parseInt(params.get('id'), 10);
  const article = NEWS_ARTICLES.find(function (a) { return a.id === id; });
  const container = document.getElementById('article-container');
  const STORAGE_KEY = 'comments_article_' + id;

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatCommentDate(isoString) {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
      ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function loadComments() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveComments(comments) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(comments));
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderComments(comments, listEl) {
    if (comments.length === 0) {
      listEl.innerHTML = '<p class="comments-empty">No comments yet. Be the first!</p>';
      return;
    }
    listEl.innerHTML = comments.map(function (c) {
      return '<div class="comment">' +
        '<div class="comment-meta">' +
          '<span class="comment-author">' + escapeHtml(c.name) + '</span>' +
          '<span class="comment-date">' + formatCommentDate(c.datetime) + '</span>' +
        '</div>' +
        '<p class="comment-text">' + escapeHtml(c.text) + '</p>' +
      '</div>';
    }).join('');
  }

  if (!article) {
    container.innerHTML =
      '<a class="article-back" href="./news.html">← Back to News</a>' +
      '<p class="news-empty">Article not found.</p>';
    return;
  }

  document.title = article.title + ' — Steel Fish Studios';

  container.innerHTML =
    '<a class="article-back" href="./news.html">← Back to News</a>' +
    (article.thumbnail
      ? '<img class="news-article-thumbnail" src="' + article.thumbnail + '" alt="" style="margin-top:1.25rem">'
      : '') +
    '<div class="news-article-meta" style="margin-top:1.25rem">' +
      (article.tag ? '<span class="news-article-tag">' + article.tag + '</span>' : '') +
      '<span class="news-article-date">' + formatDate(article.date) + '</span>' +
    '</div>' +
    '<h1 class="article-title">' + article.title + '</h1>' +
    '<div class="article-body">' + (article.content || '<p>' + article.summary + '</p>') + '</div>' +
    '<section class="comments-section">' +
      '<h2 class="comments-heading">Comments</h2>' +
      '<div id="comments-list"></div>' +
      '<form id="comment-form" class="comment-form">' +
        '<div class="comment-form-row">' +
          '<input type="text" id="comment-name" class="comment-input" placeholder="Anonymous" maxlength="80" autocomplete="off">' +
        '</div>' +
        '<div class="comment-form-row">' +
          '<textarea id="comment-text" class="comment-textarea" placeholder="Write a comment..." maxlength="2000" rows="4"></textarea>' +
        '</div>' +
        '<button type="submit" class="comment-submit">Post Comment</button>' +
      '</form>' +
    '</section>';

  const comments = loadComments();
  const listEl = document.getElementById('comments-list');
  renderComments(comments, listEl);

  document.getElementById('comment-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const nameInput = document.getElementById('comment-name');
    const textInput = document.getElementById('comment-text');
    const text = textInput.value.trim();
    if (!text) return;
    const name = nameInput.value.trim() || 'Anonymous';
    const updated = loadComments();
    updated.push({ name: name, text: text, datetime: new Date().toISOString() });
    saveComments(updated);
    renderComments(updated, listEl);
    nameInput.value = '';
    textInput.value = '';
    listEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
