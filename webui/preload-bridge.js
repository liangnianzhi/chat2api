/*
 * Browser-side preload shim.
 *
 * Concatenated ahead of upstream's preload bundle by webui/server.js so that
 * `require('electron')`, `contextBridge` and `ipcRenderer` work in a plain
 * browser.
 *
 * Beyond providing the API surface, this fixes three things that only go wrong
 * once the renderer runs in a browser rather than an Electron renderer process:
 *
 *   1. OPENING A BROWSER TAB
 *      Upstream calls shell.openExternal (main process) to open a login page.
 *      That arrives here as an event, i.e. long after the click - and browsers
 *      block window.open() outside a user gesture. Channels that may lead to a
 *      browser open therefore pre-open a blank tab synchronously, inside the
 *      gesture, and navigate it when the URL arrives. If even that fails, a
 *      banner offers the link instead of failing silently.
 *
 *   2. window.open RETURN VALUE
 *      `window.open(url, '_blank', 'noopener')` returns null by specification,
 *      so a successful open looked like a failure. The feature string is not
 *      used any more; opener is cleared on the returned handle instead.
 *
 *   3. LOOPBACK MANAGEMENT URLS
 *      Upstream builds local management URLs as
 *      http://<proxyHost>:<proxyPort>/v0/management. Inside a container those
 *      point at the *visitor's* machine, so they can never connect. Requests to
 *      a loopback host on an internal port are rewritten to this origin, which
 *      serves the same paths.
 */
(function () {
  var listeners = Object.create(null);
  var stream = null;
  var pendingOpens = [];

  function rpc(channel, args) {
    return fetch('/__ipc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, args: args || [] })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.ok) return r.result;
      throw new Error((r && r.error) || ('ipc failed: ' + channel));
    });
  }

  /* ---------------------------------------------------------------- *
   * Opening tabs
   * ---------------------------------------------------------------- */
  var placeholder = null;

  function openTab(url) {
    try {
      // No 'noopener' here on purpose: it makes window.open() return null, so a
      // successful open would be indistinguishable from a blocked one.
      var w = window.open(url, '_blank');
      if (w) {
        try { w.opener = null; } catch (e) { /* cross-origin is fine */ }
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Opens a blank tab now, while the click is still the user gesture.
  function armPlaceholder() {
    try {
      if (placeholder && !placeholder.closed) return placeholder;
      placeholder = window.open('about:blank', '_blank');
      if (placeholder) {
        try {
          placeholder.document.write(
            '<title>正在打开登录页…</title>'
            + '<p style="font:14px system-ui,sans-serif;padding:24px;color:#333">'
            + '正在打开登录页，请稍候…</p>'
          );
        } catch (e) { /* ignore */ }
      }
      return placeholder;
    } catch (e) {
      return null;
    }
  }

  function navigatePlaceholder(url) {
    if (placeholder && !placeholder.closed) {
      var w = placeholder;
      placeholder = null;
      try { w.location.replace(url); return true; } catch (e) { /* fall through */ }
    }
    placeholder = null;
    return false;
  }

  // Last resort: make the URL clickable instead of dropping it.
  function showOpenBanner(url) {
    try {
      if (!document || !document.body) return;
      var id = '__c2a_open_banner';
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;'
          + 'background:#1f6feb;color:#fff;padding:10px 14px;border-radius:8px;'
          + 'font:13px/1.6 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)';
        document.body.appendChild(el);
      }
      el.textContent = '';
      var span = document.createElement('span');
      span.textContent = '浏览器拦截了自动打开登录页，请手动打开：';
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = url;
      a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:6px;word-break:break-all';
      var close = document.createElement('button');
      close.textContent = '关闭';
      close.style.cssText = 'margin-left:12px;background:transparent;color:#fff;'
        + 'border:1px solid rgba(255,255,255,.6);border-radius:4px;padding:2px 8px;cursor:pointer';
      close.onclick = function () { el.remove(); };
      el.appendChild(span);
      el.appendChild(a);
      el.appendChild(close);
    } catch (e) { /* nothing else to do */ }
  }

  function deliverOpen(url) {
    if (navigatePlaceholder(url)) return;
    if (openTab(url)) return;
    pendingOpens.push(url);
    showOpenBanner(url);
  }

  /* ---------------------------------------------------------------- *
   * Rewriting loopback management URLs to this origin
   * ---------------------------------------------------------------- */
  var INTERNAL_PORTS = ['18090', '18080', '8080'];
  var API_PATH = /^\/(v0\/|v1\/|management|health|api\/)/;

  function rewriteUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      var host = u.hostname;
      var isLoopback = host === '127.0.0.1' || host === 'localhost'
        || host === '0.0.0.0' || host === '::1' || host === '[::1]';
      if (!isLoopback) return url;
      var port = u.port || '';
      var portMatches = port === '' || INTERNAL_PORTS.indexOf(port) !== -1
        || port === window.location.port;
      if (!portMatches) return url;
      if (!API_PATH.test(u.pathname)) return url;
      // Same-origin request: the front server serves these paths.
      return u.pathname + u.search + u.hash;
    } catch (e) {
      return url;
    }
  }

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          var rewritten = rewriteUrl(input);
          if (rewritten !== input) input = rewritten;
        } else if (input && typeof input.url === 'string') {
          var r = rewriteUrl(input.url);
          if (r !== input.url) input = r;
        }
      } catch (e) { /* use the original request */ }
      return originalFetch(input, init);
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    var originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof url === 'string') args[1] = rewriteUrl(url);
      } catch (e) { /* use the original url */ }
      return originalOpen.apply(this, args);
    };
  }

  /* ---------------------------------------------------------------- *
   * IPC
   * ---------------------------------------------------------------- */
  function connect() {
    if (stream || typeof EventSource === 'undefined') return;
    stream = new EventSource('/__ipc/events');
    stream.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.channel === '__c2a:openExternal') {
        deliverOpen(msg.args[0]);
        return;
      }
      var set = listeners[msg.channel];
      if (!set) return;
      set.forEach(function (fn) {
        try { fn.apply(null, [{}].concat(msg.args || [])); }
        catch (err) { console.error('[ipc]', msg.channel, err); }
      });
    };
  }

  // Channels whose backend work ends in a browser opening. Arming a blank tab
  // for these keeps the open inside the user gesture.
  var MAY_OPEN_BROWSER = /openExternal$|:startLogin$|:startInAppLogin$|InAppLogin$/i;

  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (MAY_OPEN_BROWSER.test(String(channel))) armPlaceholder();
      return rpc(channel, args);
    },
    send: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (MAY_OPEN_BROWSER.test(String(channel))) armPlaceholder();
      rpc(channel, args).catch(function () {});
    },
    sendSync: function () { throw new Error('sendSync is not available over the HTTP bridge'); },
    on: function (channel, fn) {
      connect();
      (listeners[channel] = listeners[channel] || new Set()).add(fn);
      return ipcRenderer;
    },
    once: function (channel, fn) {
      var self = this;
      function wrapped() { self.removeListener(channel, wrapped); fn.apply(null, arguments); }
      return self.on(channel, wrapped);
    },
    removeListener: function (channel, fn) {
      if (listeners[channel]) listeners[channel].delete(fn);
      return ipcRenderer;
    },
    removeAllListeners: function (channel) {
      if (channel === undefined) listeners = Object.create(null);
      else delete listeners[channel];
      return ipcRenderer;
    },
    listenerCount: function (channel) {
      return listeners[channel] ? listeners[channel].size : 0;
    }
  };

  var electronStub = {
    ipcRenderer: ipcRenderer,
    contextBridge: { exposeInMainWorld: function (key, value) { window[key] = value; } },
    webFrame: { setZoomFactor: function () {}, getZoomFactor: function () { return 1; } },
    shell: {
      openExternal: function (u) {
        // Called synchronously from a click handler when the renderer goes
        // through the shell module directly.
        var opened = navigatePlaceholder(u) || openTab(u);
        if (!opened) showOpenBanner(u);
      }
    },
    clipboard: { writeText: function () {}, readText: function () { return ''; } }
  };

  window.__c2a_electron = electronStub;
  window.__c2a_require = function (name) {
    if (name === 'electron') return electronStub;
    throw new Error('unexpected require in preload bundle: ' + name);
  };
  window.__c2a_module = { exports: {} };
  window.__c2a_process = {
    env: { NODE_ENV: 'production' },
    platform: 'linux',
    versions: {},
    type: 'renderer',
    nextTick: function (f) { setTimeout(f, 0); }
  };
}());
