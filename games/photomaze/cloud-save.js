// Cloud saves for Photomaze, like Crispy the Cat's.
//
// The game's own "Save Game" / "Load Game" (Harlowe's (save-game:) and
// (load-game:)) keep working as before and save to this browser's
// localStorage. When the player is logged in to steelfishstudios.com, this
// script also uploads each save to their account, and on startup it puts the
// account's save into localStorage, so "Load Game" picks it up on any device.
//
// Loaded by the story's JavaScript (Twine → Story → JavaScript), so it survives
// republishing from Twine. Shows its status in any element with the class
// "cloud-status" (the Main Menu and Maze Select passages have one).
//
// Server side: /api/account/save?game=photomaze in netlify/functions/account-api.mjs.
(function () {
  if (window.__photomazeCloudSave) return;
  window.__photomazeCloudSave = true;

  var GAME = 'photomaze';
  var IFID = '1B5A44EE-7331-428D-94C0-826B70C274D3'; // from <tw-storydata ifid=…>
  var SLOT = 'Game File';                            // the name passed to (save-game:)
  var SAVE_KEY = '(Saved Game ' + IFID + ') ' + SLOT;
  var NAME_KEY = '(Saved Game Filename ' + IFID + ') ' + SLOT;
  // What we know about the local save: { account, revision, savedMs, dirty }.
  // dirty = saved here but not uploaded yet.
  var META_KEY = 'sfs-cloud-save:' + GAME;
  var API = '/api/account/save?game=' + GAME;

  var setItem = Storage.prototype.setItem;
  var status = 'checking';
  var account = null; // { id, name } while logged in
  var queue = Promise.resolve();

  // ---- localStorage ----

  function store(key, value) {
    try { setItem.call(localStorage, key, value); } catch (e) { /* storage full or blocked */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function readMeta() {
    try { return JSON.parse(read(META_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeMeta(meta) { store(META_KEY, JSON.stringify(meta)); }

  // Notice every time the game saves.
  Storage.prototype.setItem = function (key, value) {
    var result = setItem.apply(this, arguments);
    if (this === localStorage && key === SAVE_KEY) {
      var meta = readMeta();
      meta.savedMs = Date.now();
      meta.dirty = true;
      writeMeta(meta);
      run(function () { return account ? upload() : null; });
    }
    return result;
  };

  // ---- Packing: the save is gzipped so long games still fit ----

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function pack(state, name, savedMs) {
    var out = { v: 1, savedMs: savedMs, name: name || '' };
    if (!window.CompressionStream) return Promise.resolve(JSON.stringify(Object.assign(out, { state: state })));
    var stream = new Blob([state]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return JSON.stringify(Object.assign(out, { gz: toBase64(new Uint8Array(buf)) }));
    });
  }

  function unpack(text) {
    var data = JSON.parse(text);
    if (!data.gz) return Promise.resolve(data);
    var stream = new Blob([fromBase64(data.gz)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text().then(function (state) { data.state = state; return data; });
  }

  // ---- Server ----

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.httpStatus = res.status;
        return data;
      });
    });
  }

  // Uploads the local save. Pressing Save is the player saying "this one", so
  // if another device saved since, this save still replaces it.
  function upload(retried) {
    var state = read(SAVE_KEY);
    if (!state || !account) return null;
    var meta = readMeta();
    var base = meta.account === account.id ? meta.revision || 0 : 0;
    setStatus('saving');
    return pack(state, read(NAME_KEY), meta.savedMs || Date.now()).then(function (save) {
      return api('POST', API, { save: save, base_revision: base });
    }).then(function (res) {
      if (res.httpStatus === 409 && !retried) {
        writeMeta(Object.assign(readMeta(), { account: account.id, revision: res.revision || 0 }));
        return upload(true);
      }
      if (res.httpStatus === 401) return loggedOut();
      if (res.httpStatus !== 200) throw new Error(res.error || 'Upload failed');
      writeMeta(Object.assign(readMeta(), { account: account.id, revision: res.revision, dirty: false }));
      setStatus('saved');
    });
  }

  // Puts the account's save in localStorage, where "Load Game" looks.
  function useCloud(cloud) {
    return unpack(cloud.save).then(function (data) {
      store(SAVE_KEY, data.state);
      store(NAME_KEY, data.name || '');
      writeMeta({ account: account.id, revision: cloud.revision, savedMs: data.savedMs || 0, dirty: false });
    });
  }

  function loggedOut() {
    account = null;
    setStatus('out');
  }

  // On startup (and when coming back after logging in in another tab), match
  // this browser's save with the account's.
  function sync() {
    if (!/(?:^|;\s*)sfs_user=/.test(document.cookie)) return loggedOut();
    setStatus('checking');
    return api('GET', '/api/account/me').then(function (me) {
      if (me.httpStatus === 401) return loggedOut();
      if (me.httpStatus !== 200) throw new Error(me.error || 'Not reachable');
      account = { id: me.account.account_id, name: me.account.display_name };
      return api('GET', API);
    }).then(function (cloud) {
      if (!account) return;
      if (cloud.httpStatus !== 200) throw new Error(cloud.error || 'Not reachable');
      var meta = readMeta();
      var local = read(SAVE_KEY);
      var mine = meta.account === account.id;

      if (!cloud.save) return local ? upload() : setStatus('on');
      if (!local) return useCloud(cloud).then(function () { setStatus('loaded'); });
      if (mine && !meta.dirty) {
        if (meta.revision === cloud.revision) return setStatus('on');
        return useCloud(cloud).then(function () { setStatus('loaded'); }); // saved on another device
      }
      // Both have a save we haven't matched up: the newer one wins.
      return unpack(cloud.save).then(function (data) {
        if ((meta.savedMs || 0) > (data.savedMs || 0)) {
          writeMeta(Object.assign(meta, { account: account.id, revision: cloud.revision }));
          return upload();
        }
        return useCloud(cloud).then(function () { setStatus('loaded'); });
      });
    });
  }

  // One server conversation at a time.
  function run(task) {
    queue = queue.then(task).catch(function (err) {
      console.warn('Cloud save:', err);
      setStatus('error');
    });
  }

  // ---- Status line ----

  function setStatus(s) {
    status = s;
    render();
  }

  function render() {
    var els = document.querySelectorAll('.cloud-status');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = status + '|' + (account ? account.name : '');
      if (el.getAttribute('data-shown') === key) continue;
      el.setAttribute('data-shown', key);
      el.textContent = '';
      var who = account ? 'Logged in as ' + account.name + '. ' : '';
      if (status === 'out') {
        el.appendChild(document.createTextNode('Saves stay in this browser. '));
        var a = document.createElement('a');
        a.href = '/account.html';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Log in';
        el.appendChild(a);
        el.appendChild(document.createTextNode(' to keep them in the cloud and play on any device.'));
      } else {
        el.textContent = {
          checking: 'Checking your cloud save…',
          on: '☁ ' + who + 'Your saves go to the cloud.',
          loaded: '☁ ' + who + 'Your cloud save is ready to load.',
          saving: '☁ Saving to the cloud…',
          saved: '☁ ' + who + 'Saved to the cloud.',
          error: 'Couldn\'t reach the cloud, so this save is only in this browser for now. It will upload next time.'
        }[status] || '';
      }
    }
  }

  // Harlowe redraws passages, so fill in new status lines as they appear.
  new MutationObserver(render).observe(document.documentElement, { childList: true, subtree: true });

  // Logged in from another tab? Check again on coming back.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !account) run(sync);
  });

  run(sync);
})();
