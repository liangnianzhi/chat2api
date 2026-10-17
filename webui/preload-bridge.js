/*
 * Preload-environment shim injected before upstream's preload bundle.
 *
 * This file is a template: webui/server.js concatenates it with the upstream
 * preload output so that `require('electron')`, `contextBridge` and
 * `ipcRenderer` behave inside a plain browser.
 *
 * Kept separate from the server so the browser-side logic is readable.
 */
(function () {
  var listeners = Object.create(null);
  var stream = null;
  var connected = false;
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

  // Open a URL in a real tab. Called directly where possible so it does not
  // depend on the event stream being up.
  function openTab(url) {
    try {
      var w = window.open(url, '_blank', 'noopener');
      if (w) { try { w.opener = null; } catch (e) {} }
      return !!w;
    } catch (e) {
      return false;
    }
  }

  function flushPending() {
    var queued = pendingOpens;
    pendingOpens = [];
    queued.forEach(openTab);
  }

  function connect() {
    if (stream || typeof EventSource === 'undefined') return;
    stream = new EventSource('/__ipc/events');
    stream.onopen = function () { connected = true; flushPending(); };
    stream.onerror = function () { connected = false; };
    stream.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.channel === '__c2a:openExternal') {
        // A tab opened long after the click is usually blocked as a popup, so
        // this path is the fallback for opens that had no direct opportunity.
        if (!openTab(msg.args[0])) pendingOpens.push(msg.args[0]);
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

  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      // shell.openExternal arrives here as a channel from upstream code paths
      // that go through IPC rather than the shell module; open it right away
      // while the click is still the user gesture, then let the backend run.
      var isOpenExternal = /openExternal$/i.test(String(channel));
      var url = args && args[0];
      var opened = null;
      if (isOpenExternal && typeof url === 'string') opened = openTab(url);
      return rpc(channel, args).catch(function (err) {
        if (opened) return null; // the tab is already open; the RPC detail is moot
        throw err;
      });
    },
    send: function (channel) {
      rpc(channel, Array.prototype.slice.call(arguments, 1)).catch(function () {});
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
        // Synchronous open, inside the caller's stack: still a user gesture.
        if (!openTab(u)) pendingOpens.push(u);
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
