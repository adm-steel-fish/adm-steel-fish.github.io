(function () {
  const articles = [...NEWS_ARTICLES].sort((a, b) => new Date(b.date) - new Date(a.date));

  let currentPage = 1;
  let perPage = 10;

  const listEl = document.getElementById('news-list');
  const paginationEl = document.getElementById('news-pagination');
  const perPageSelect = document.getElementById('per-page');

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function totalPages() {
    return Math.max(1, Math.ceil(articles.length / perPage));
  }

  function renderArticles() {
    listEl.innerHTML = '';
    const start = (currentPage - 1) * perPage;
    const slice = articles.slice(start, start + perPage);

    if (slice.length === 0) {
      const p = document.createElement('p');
      p.className = 'news-empty';
      p.textContent = 'No articles yet — check back soon!';
      listEl.appendChild(p);
      return;
    }

    slice.forEach(article => {
      const el = document.createElement('article');
      el.className = 'news-article';
      el.innerHTML =
        '<div class="news-article-meta">' +
          (article.tag ? '<span class="news-article-tag">' + article.tag + '</span>' : '') +
          '<span class="news-article-date">' + formatDate(article.date) + '</span>' +
        '</div>' +
        '<h2 class="news-article-title">' + article.title + '</h2>' +
        '<p class="news-article-summary">' + article.summary + '</p>' +
        (article.content
          ? '<a class="news-article-more" href="./news-article.html?id=' + article.id + '">Read more →</a>'
          : '');
      listEl.appendChild(el);
    });
  }

  function getPageNumbers(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = new Set([1, total, current]);
    if (current - 1 >= 1) pages.add(current - 1);
    if (current + 1 <= total) pages.add(current + 1);
    const sorted = [...pages].sort((a, b) => a - b);
    const result = [];
    for (let i = 0; i < sorted.length; i++) {
      result.push(sorted[i]);
      if (i < sorted.length - 1 && sorted[i + 1] - sorted[i] > 1) {
        result.push('...');
      }
    }
    return result;
  }

  function makePageBtn(label, targetPage, disabled, active, ariaLabel) {
    const btn = document.createElement('button');
    btn.className = 'pagination-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    if (!disabled && !active) {
      btn.addEventListener('click', () => goTo(targetPage));
    }
    return btn;
  }

  function renderPagination() {
    paginationEl.innerHTML = '';
    const total = totalPages();
    if (total <= 1) return;

    paginationEl.appendChild(makePageBtn('«', 1, currentPage === 1, false, 'First page'));
    paginationEl.appendChild(makePageBtn('‹', currentPage - 1, currentPage === 1, false, 'Previous page'));

    getPageNumbers(currentPage, total).forEach(item => {
      if (item === '...') {
        const span = document.createElement('span');
        span.className = 'pagination-ellipsis';
        span.textContent = '…';
        paginationEl.appendChild(span);
      } else {
        paginationEl.appendChild(makePageBtn(item, item, false, item === currentPage, 'Page ' + item));
      }
    });

    paginationEl.appendChild(makePageBtn('›', currentPage + 1, currentPage === total, false, 'Next page'));
    paginationEl.appendChild(makePageBtn('»', total, currentPage === total, false, 'Last page'));
  }

  function goTo(page) {
    currentPage = page;
    renderArticles();
    renderPagination();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  perPageSelect.addEventListener('change', function () {
    perPage = parseInt(this.value, 10);
    currentPage = 1;
    renderArticles();
    renderPagination();
  });

  renderArticles();
  renderPagination();
})();
