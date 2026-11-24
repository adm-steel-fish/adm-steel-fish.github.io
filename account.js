// The account page: log in with Google or Discord, link or unlink the other,
// log out. The session is an HttpOnly cookie set by /api/account (see
// netlify/functions/account-api.mjs), so this page only ever calls the API.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { google: 'Google', discord: 'Discord' };

  var MESSAGES = {
    ok: 'You\'re logged in.',
    expired: 'That login took too long or was opened in another browser. Please try again.',
    cancelled: 'Login cancelled.',
    provider: 'We couldn\'t reach {p}. Please try again.',
    taken: 'That {p} account already has its own Steel Fish account. Log out and log in with {p} to use that one instead.',
    has_other: 'This account already has a different {p} account linked. Unlink it first.',
    login_first: 'Please log in first.'
  };

  function showMessage(text, isError) {
    var el = $('account-message');
    el.textContent = text;
    el.className = 'account-message' + (isError ? ' is-error' : '');
    el.hidden = !text;
  }

  // Turn ?auth=… from the login round trip into a message, then tidy the URL.
  function readResult() {
    var params = new URLSearchParams(location.search);
    var result = params.get('auth');
    if (!result) return;
    var p = NAMES[params.get('provider')] || 'that service';
    if (result === 'ok') showMessage(MESSAGES.ok);
    else if (result === 'linked') showMessage(p + ' is now linked. You can log in with either one.');
    else showMessage((MESSAGES[params.get('reason')] || 'Something went wrong. Please try again.').replace(/\{p\}/g, p), true);
    history.replaceState(null, '', location.pathname);
  }

  function api(method, path, body) {
    return fetch('/api/account/' + path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || 'Something went wrong.'); err.status = res.status; throw err; }
        return data;
      });
    });
  }

  function render(account) {
    $('account-loading').hidden = true;
    $('account-logged-out').hidden = !!account;
    $('account-logged-in').hidden = !account;
    if (!account) return;

    $('account-name').textContent = account.display_name;
    var avatar = $('account-avatar');
    avatar.hidden = !account.avatar_url;
    if (account.avatar_url) avatar.src = account.avatar_url;

    var tier = account.supporter && account.supporter.tier;
    $('account-supporter').hidden = !tier;
    if (tier) $('account-supporter').textContent = 'Supporter: ' + account.supporter.name + '. Thank you!';

    var logins = account.logins || {};
    var count = (logins.google ? 1 : 0) + (logins.discord ? 1 : 0);
    document.querySelectorAll('.login-list li').forEach(function (li) {
      var provider = li.getAttribute('data-provider');
      var info = logins[provider];
      li.querySelector('.login-detail').textContent = info
        ? (provider === 'google' ? (info.email || info.name) : '@' + info.username)
        : 'Not linked';
      li.querySelector('[data-action="link"]').hidden = !!info;
      var unlink = li.querySelector('[data-action="unlink"]');
      unlink.hidden = !info;
      unlink.disabled = count < 2;
      unlink.title = count < 2 ? 'Link another way to log in first.' : '';
    });
  }

  function load() {
    api('GET', 'me').then(function (data) { render(data.account); }).catch(function (err) {
      render(null);
      if (err.status !== 401) showMessage(err.message, true);
    });
  }

  document.querySelectorAll('.login-list [data-action="unlink"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var provider = btn.closest('li').getAttribute('data-provider');
      if (!confirm('Unlink ' + NAMES[provider] + '? You won\'t be able to log in with it until you link it again.')) return;
      btn.disabled = true;
      api('POST', 'unlink', { provider: provider }).then(function (data) {
        showMessage(NAMES[provider] + ' is no longer linked.');
        render(data.account);
      }).catch(function (err) { showMessage(err.message, true); btn.disabled = false; });
    });
  });

  $('account-logout').addEventListener('click', function () {
    api('POST', 'logout').catch(function () {}).then(function () {
      showMessage('You\'re logged out.');
      render(null);
      var nav = $('nav-account');
      if (nav) nav.textContent = 'Log in';
    });
  });

  readResult();
  load();
})();
