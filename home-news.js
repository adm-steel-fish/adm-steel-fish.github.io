(function () {
  const container = document.getElementById('latest-news-card');
  if (!container || !Array.isArray(NEWS_ARTICLES) || NEWS_ARTICLES.length === 0) {
    if (container) {
      container.innerHTML = '<p class="news-empty">No news articles yet - check back soon!</p>';
    }
    return;
  }

  const latestArticle = [...NEWS_ARTICLES]
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  container.innerHTML =
    '<article class="news-article latest-news-card">' +
      '<div class="news-article-meta">' +
        (latestArticle.tag ? '<span class="news-article-tag">' + latestArticle.tag + '</span>' : '') +
        '<span class="news-article-date">' + formatDate(latestArticle.date) + '</span>' +
      '</div>' +
      '<h3 class="news-article-title">' + latestArticle.title + '</h3>' +
      '<p class="news-article-summary">' + latestArticle.summary + '</p>' +
      '<a class="news-article-more" href="./news-article.html?id=' + latestArticle.id + '">Read this article -></a>' +
    '</article>';
})();
