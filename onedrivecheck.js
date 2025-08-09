// OneDriveCheckService Monitor for MeshCentral
// shortName: onedrivecheck
//
// Compatible across MeshCentral variants:
// - Uses toolkit.config if present, else falls back to files in the plugin dir
// - Resolves the real Express app (or gracefully degrades)
// - Provides both default export and named export (exports.onedrivecheck)
// - Loads UI as external /plugin/onedrivecheck/ui.js (CSP safe) and prefixes with webRoot

module.exports = function(parent, toolkit, config) {
  const plugin = this;

  // ---------- Paths & storage ----------
  const fs = require('fs');
  const path = require('path');
  const plugindir = (config && config.__plugindir) ? config.__plugindir : __dirname;

  // file-backed store fallback (used if toolkit.config is not available)
  const fileStore = {
    _read(name) {
      try { return JSON.parse(fs.readFileSync(path.join(plugindir, name), 'utf8')); } catch { return null; }
    },
    _write(name, obj) {
      try { fs.writeFileSync(path.join(plugindir, name), JSON.stringify(obj || {}, null, 2)); } catch (e) { logError(e); }
    },
    get(key, cb) {
      if (key === 'settings') {
        cb(this._read('settings.json') || null);
      } else if (key.startsWith('status:')) {
        const all = this._read('statuses.json') || {};
        cb(all[key] || null);
      } else {
        cb(null);
      }
    },
    set(key, val, cb) {
      if (key === 'settings') {
        this._write('settings.json', val || {});
      } else if (key.startsWith('status:')) {
        const all = this._read('statuses.json') || {};
        all[key] = val || null;
        this._write('statuses.json', all);
      }
      cb && cb();
    }
  };

  const store = (toolkit && toolkit.config) ? toolkit.config : fileStore;

  // ---------- Logging ----------
  function logInfo(msg){ try { parent.info('onedrivecheck: ' + msg); } catch(_) {} }
  function logDebug(msg){ try { parent.debug('onedrivecheck: ' + msg); } catch(_) {} }
  function logError(err){ try { parent.debug('onedrivecheck error: ' + (err && err.stack || err)); } catch(_) {} }

  // ---------- Settings & status ----------
  let settings = { meshId: null, pollInterval: 60 };
  let pollTimer = null;

  const statusKey = (id) => `status:${id}`;
  function saveStatus(deviceId, obj, cb) {
    try { obj = obj || {}; obj.lastChecked = Date.now(); } catch(_) {}
    store.set(statusKey(deviceId), obj, () => cb && cb());
  }
  function getStatus(deviceId, cb) {
    store.get(statusKey(deviceId), (v) => cb && cb(v || null));
  }

  // ---------- Startup ----------
  plugin.server_startup = function() {
    logInfo('server_startup');
    store.get('settings', function(val) {
      if (val) settings = Object.assign(settings, val);
      logInfo('settings=' + JSON.stringify(settings));
      schedulePolling(true);
    });
  };

  function schedulePolling(forceRunNow) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!settings.meshId) { logInfo('no meshId set; not polling'); return; }
    const intervalMs = Math.max(10, parseInt(settings.pollInterval || 60, 10)) * 1000;
    logInfo('polling every ' + (intervalMs/1000) + 's');
    pollTimer = setInterval(pollDevices, intervalMs);
    if (forceRunNow) pollDevices();
  }

  // ---------- Admin HTML ----------
  function adminHtml() {
    const meshIdVal = settings.meshId ? String(settings.meshId) : '';
    const pollVal = String(settings.pollInterval || 60);
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheckService Monitor</title></head>
<body style="font-family:sans-serif; padding:20px; max-width:860px;">
  <h2>OneDriveCheckService Monitor — Settings</h2>
  <form method="POST" action="__ADMIN_POST__">
    <label><strong>Mesh Group ID (meshId)</strong></label><br/>
    <input type="text" name="meshId" value="${meshIdVal}" required style="width:420px" /><br/><br/>
    <label><strong>Polling Interval</strong> (seconds, min 10)</label><br/>
    <input type="number" min="10" name="pollInterval" value="${pollVal}" style="width:120px"/><br/><br/>
    <input type="submit" value="Save" />
  </form>
  <p style="margin-top:14px;color:#555">Tip: Groups → Info shows the meshId.</p>
</body></html>`;
  }

  // ---------- Express resolution & safe urlencoded ----------
  function resolveExpressApp(appOrWeb) {
    if (!appOrWeb) return null;
    if (typeof appOrWeb.get === 'function') return appOrWeb; // express app
    if (appOrWeb.app && typeof appOrWeb.app.get === 'function') return appOrWeb.app; // webserver.app
    if (parent && parent.webserver && parent.webserver.app && typeof parent.webserver.app.get === 'function') return parent.webserver.app;
    return null;
  }
  function resolveExpressLib(expressArg) {
    try {
      if (expressArg && typeof expressArg.urlencoded === 'function') return expressArg;
      if (parent && parent.webserver && parent.webserver.express && typeof parent.webserver.express.urlencoded === 'function') return parent.webserver.express;
      const e = require('express');
      if (e && typeof e.urlencoded === 'function') return e;
    } catch(_) {}
    return null;
  }
  function manualUrlencoded() {
    // very small, safe fallback for application/x-www-form-urlencoded
    return function(req, res, next) {
      if (req.method !== 'POST') return next();
      const ctype = (req.headers['content-type'] || '').toLowerCase();
      if (ctype.indexOf('application/x-www-form-urlencoded') === -1) return next();
      let data = '';
      req.on('data', (d) => { data += d; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const body = {};
        data.split('&').forEach(p => {
          if (!p) return;
          const eq = p.indexOf('=');
          const k = decodeURIComponent((eq === -1 ? p : p.substring(0, eq)).replace(/\+/g,' '));
          const v = decodeURIComponent((eq === -1 ? '' : p.substring(eq+1)).replace(/\+/g,' '));
          if (k) body[k] = v;
        });
        req.body = body;
        next();
      });
    };
  }

  function isAdminReq(req) {
    if (!req || !req.user) return false;
    const u = req.user;
    // cover a bunch of flags MeshCentral builds use
    return !!(u.siteadmin || u.domainadmin || u.admin || u.isadmin || u.superuser);
  }

  // ---------- HTTP Handlers ----------
  plugin.hook_setupHttpHandlers = function(appOrWeb, expressArg) {
    // Always use the post-auth app so req.user is set.
    const ws = parent && parent.webserver;
    const app = (ws && ws.app && typeof ws.app.get === 'function') ? ws.app : null;
    if (!app) { logError('post-auth express app not found'); return; }
  
    // Use Mesh webRoot so paths match your login origin
    const webRoot = (ws && ws.webRoot) || '/';
    const baseNoSlash = webRoot.endsWith('/') ? webRoot.slice(0, -1) : webRoot;
    function R(p) { return baseNoSlash + p; }
  
    const expressLib = resolveExpressLib(expressArg);
    const urlenc = expressLib ? expressLib.urlencoded({ extended: true }) : manualUrlencoded();
    
    // Debug: whoami (optional; remove later)
    app.get(R('/plugin/onedrivecheck/whoami'), function(req, res) {
      if (!req || !req.user) { res.status(401).json({ ok:false, reason:'no user' }); return; }
      const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = req.user;
      res.json({ ok:true, user:{ name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
    });

    // Admin UI
    app.get(R('/plugin/onedrivecheck/admin'), function(req, res) {
      if (!isAdminReq(req)) { res.status(403).end('Forbidden'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // patch the form action to include webRoot
      const html = adminHtml().replace('__ADMIN_POST__', R('/plugin/onedrivecheck/admin'));
      res.end(html);
    });

    app.post(R('/plugin/onedrivecheck/admin'), urlenc, function(req, res) {
      if (!isAdminReq(req)) { res.status(403).end('Forbidden'); return; }
      if (req.body && typeof req.body.meshId === 'string') settings.meshId = req.body.meshId.trim();
      if (req.body && req.body.pollInterval) settings.pollInterval = Math.max(10, parseInt(req.body.pollInterval, 10) || 60);
      store.set('settings', settings, function() {
        logInfo('settings saved: ' + JSON.stringify(settings));
        schedulePolling(true);
        res.writeHead(302, { Location: R('/plugin/onedrivecheck/admin') });
        res.end();
      });
    });

    // Status API
    app.get(R('/plugin/onedrivecheck/status'), function(req, res) {
      if (!isAdminReq(req)) { res.status(403).end('Forbidden'); return; }
      let ids = req.query.id;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];
      const out = {};
      let pending = ids.length;
      ids.forEach((id) => {
        getStatus(id, function(v) {
          out[id] = v;
          if (--pending === 0) res.json(out);
        });
      });
    });

    // UI JS (CSP-safe) — PUBLIC
    app.get(R('/plugin/onedrivecheck/ui.js'), function(req, res) {
      const js = String.raw`(function(){
        function queryDevicesTable(){ return document.querySelector('#devices, #devicesTable'); }
        function getRowDeviceId(row){
          return row.getAttribute('deviceid') || row.dataset.deviceid ||
                 (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
                 row.getAttribute('nodeid') || row.dataset.nodeid || null;
        }
        function addColumnHeader(){
          var grid = queryDevicesTable(); if(!grid) return false;
          var thead = grid.querySelector('thead'); if(!thead) return false;
          var tr = thead.querySelector('tr'); if(!tr) return false;
          if(!document.getElementById('col_onedrivecheck')){
            var th = document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDriveCheck'; tr.appendChild(th);
          }
          return true;
        }
        function ensureCells(){
          var grid = queryDevicesTable(); if(!grid) return [];
          var rows = grid.querySelectorAll('tbody tr'); var ids = [];
          rows.forEach(function(row){
            if(!row.querySelector('.onedrivecheck-cell')){
              var td = document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—'; row.appendChild(td);
            }
            var id = getRowDeviceId(row); if(id) ids.push(id);
          });
          return ids;
        }
        function paintRows(statusMap){
          var grid = queryDevicesTable(); if(!grid) return;
          var rows = grid.querySelectorAll('tbody tr');
          rows.forEach(function(row){
            var id = getRowDeviceId(row);
            var td = row.querySelector('.onedrivecheck-cell'); if(!td) return;
            var s = (id && statusMap && statusMap[id]) ? statusMap[id] : null;
            if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; return; }
            td.textContent = s.status || '—';
            td.title = '20707:' + (s.port20707 ? 'open' : 'closed') + ', 20773:' + (s.port20773 ? 'open' : 'closed');
            td.dataset.state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
          });
        }
        function fetchStatus(ids){
          if(!ids || ids.length===0) return Promise.resolve({});
          var url = '${R('/plugin/onedrivecheck/status')}' + '?' + ids.map(function(id){ return 'id='+encodeURIComponent(id); }).join('&');
          return fetch(url, { credentials:'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
        }
        function applyFilter(){
          var sel = document.getElementById('filter_onedrivecheck'); if(!sel) return;
          var mode = sel.value;
          var grid = queryDevicesTable(); if(!grid) return;
          var rows = grid.querySelectorAll('tbody tr');
          rows.forEach(function(r){
            var td = r.querySelector('.onedrivecheck-cell'); var state = td ? td.dataset.state : '';
            var show = true;
            if(mode==='offline')   show = (state==='offline');
            if(mode==='notsigned') show = (state==='notsigned');
            if(mode==='online')    show = (state==='online');
            r.style.display = show ? '' : 'none';
          });
        }
        function addFilterUI(){
          var bar = document.getElementById('deviceToolbar') || document.querySelector('.DeviceToolbar') || document.querySelector('#Toolbar') || document.querySelector('#devicestoolbar');
          if(!bar) return; if(document.getElementById('filter_onedrivecheck')) return;
          var label = document.createElement('span'); label.style.marginLeft='10px'; label.textContent='OneDriveCheck: ';
          var sel = document.createElement('select'); sel.id='filter_onedrivecheck';
          [{v:'all',t:'All'},{v:'offline',t:'App Offline (20707 closed & 20773 closed)'},{v:'notsigned',t:'Not signed in (20773 open)'},{v:'online',t:'Online (20707 open)'}]
            .forEach(function(o){ var opt=document.createElement('option'); opt.value=o.v; opt.text=o.t; sel.appendChild(opt); });
          sel.onchange = applyFilter; bar.appendChild(label); bar.appendChild(sel);
        }
        function refreshNow(){
          if(!addColumnHeader()) return;
          addFilterUI();
          var ids = ensureCells();
          fetchStatus(ids).then(function(map){ paintRows(map); applyFilter(); });
        }
        document.addEventListener('meshcentralDeviceListRefreshEnd', refreshNow);
        document.addEventListener('DOMContentLoaded', function(){ setTimeout(refreshNow, 500); });
        setInterval(function(){
          var grid = queryDevicesTable();
          if(grid && !document.getElementById('col_onedrivecheck')) refreshNow();
        }, 4000);
      })();`;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(js);
    });
  };

  // ---------- UI loader ----------
  plugin.onWebUIStartupEnd = function() {
    const ws = parent && parent.webserver;
    const webRoot = (ws && ws.webRoot) || '/';
    const base = webRoot.endsWith('/') ? webRoot : (webRoot + '/');
    return `<script src="${base}plugin/onedrivecheck/ui.js"></script>`;
  };

  // ---------- Device enumeration & shell ----------
  function getDevicesInMesh(meshId) {
    return new Promise((resolve) => {
      try {
        parent.db.GetAllType('node', (nodes) => {
          const map = {};
          (nodes || []).forEach((n) => { if (n.meshid === meshId) map[n._id] = n; });
          resolve(map);
        });
      } catch (e) { logError(e); resolve({}); }
    });
  }

  function sendShell(deviceId, cmd) {
    return new Promise((resolve) => {
      const payload = { cmd: cmd, type: 'powershell' };
      parent.sendCommand(deviceId, 'shell', payload, function(resp) {
        resolve(resp && resp.data ? String(resp.data) : '');
      });
    });
  }

  async function checkPort(deviceId, port) {
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`;
    const out = await sendShell(deviceId, cmd);
    return /true/i.test(out);
  }

  async function restartService(deviceId) {
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Try { Restart-Service -Name OneDriveCheckService -Force -ErrorAction Stop; 'OK' } Catch { 'ERR:' + $_ }"`;
    await sendShell(deviceId, cmd);
    logDebug('Restarted OneDriveCheckService on ' + deviceId);
  }

  async function pollDevices() {
    try {
      if (!settings.meshId) return;
      const allDevices = await getDevicesInMesh(settings.meshId);
      const ids = Object.keys(allDevices || {});
      for (const nodeId of ids) {
        const device = allDevices[nodeId];
        if (!device) continue;

        const osd = (device.osdesc || '').toLowerCase();
        if (!osd.includes('windows')) continue;

        const port20707 = await checkPort(nodeId, 20707);
        const port20773 = await checkPort(nodeId, 20773);

        const status = {
          status: (port20707 ? 'App Online' : (port20773 ? 'Not signed in' : 'Offline')),
          port20707: !!port20707,
          port20773: !!port20773
        };

        saveStatus(nodeId, status);

        if (!port20707 && !port20773) {
          await restartService(nodeId);
        }
      }
    } catch (err) { logError(err); }
  }

  return plugin;
};

// Also expose a named export for builds that call require(...)[shortName](...)
module.exports.onedrivecheck = module.exports;

