(function () {
  const params = new URLSearchParams(window.location.search);
  const id = parseInt(params.get('id'), 10);
  const article = NEWS_ARTICLES.find(function (a) { return a.id === id; });
  const container = document.getElementById('article-container');

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
    '<div class="news-article-meta" style="margin-top:1.25rem">' +
      (article.tag ? '<span class="news-article-tag">' + article.tag + '</span>' : '') +
      '<span class="news-article-date">' + formatDate(article.date) + '</span>' +
    '</div>' +
    '<h1 class="article-title">' + article.title + '</h1>' +
    '<div class="article-body">' + (article.content || '<p>' + article.summary + '</p>') + '</div>';
})();
