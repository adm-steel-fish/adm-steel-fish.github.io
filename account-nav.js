// Shows who's logged in on the menu's "Log in" link. The name comes from the
// sfs_user cookie that /api/account sets on login, so this needs no request.
(function () {
  var link = document.getElementById('nav-account');
  if (!link) return;
  var match = document.cookie.match(/(?:^|;\s*)sfs_user=([^;]*)/);
  if (!match) return;
  var name = '';
  try { name = decodeURIComponent(match[1]); } catch (e) { name = ''; }
  if (!name) return;
  link.textContent = name.length > 20 ? name.slice(0, 19) + '…' : name;
  link.title = 'Your account';
})();
