// OneDriveCheckService Monitor for MeshCentral
// shortName: onedrivecheck
//
// Minimal two-file plugin (no webui folder).
// - Admin page at  /plugin/onedrivecheck/admin
// - Status API at   /plugin/onedrivecheck/status
// - UI is injected inline via onWebUIStartupEnd()

module.exports = function(parent, toolkit, config) {
  const plugin = this;

  // ---- Settings & state ----------------------------------------------------
  // Stored via toolkit.config under key "settings"
  let settings = { meshId: null, pollInterval: 60 }; // seconds (min 10)
  let pollTimer = null;

  // ---- Per-device status persistence --------------------------------------
  const statusKey = (id) => `status:${id}`;
  function saveStatus(deviceId, obj, cb) {
    toolkit.config.set(statusKey(deviceId), obj, () => cb && cb());
  }
  function getStatus(deviceId, cb) {
    toolkit.config.get(statusKey(deviceId), (v) => cb && cb(v || null));
  }

  // ---- Startup -------------------------------------------------------------
  plugin.server_startup = function() {
    toolkit.config.get('settings', function(val) {
      if (val) settings = Object.assign(settings, val);
      schedulePolling(true);
    });
  };

  function schedulePolling(forceRunNow) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!settings.meshId) return;
    const intervalMs = Math.max(10, parseInt(settings.pollInterval || 60, 10)) * 1000;
    pollTimer = setInterval(pollDevices, intervalMs);
    if (forceRunNow) pollDevices();
  }

  // ---- Admin HTML ----------------------------------------------------------
  function adminHtml() {
    const meshIdVal = settings.meshId ? String(settings.meshId) : '';
    const pollVal = String(settings.pollInterval || 60);
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheckService Monitor</title></head>
<body style="font-family:sans-serif; padding:20px; max-width:860px;">
  <h2>OneDriveCheckService Monitor — Settings</h2>
  <form method="POST" action="/plugin/onedrivecheck/admin">
    <label><strong>Mesh Group ID (meshId)</strong></label><br/>
    <input type="text" name="meshId" value="${meshIdVal}" required style="width:420px" /><br/><br/>
    <label><strong>Polling Interval</strong> (seconds, min 10)</label><br/>
    <input type="number" min="10" name="pollInterval" value="${pollVal}" style="width:120px"/><br/><br/>
    <input type="submit" value="Save" />
  </form>
  <p style="margin-top:14px;color:#555">
    Tip: Find your Mesh Group ID under <em>Groups → Info</em> in MeshCentral.
  </p>
</body></html>`;
  }

  // ---- HTTP Handlers -------------------------------------------------------
  plugin.hook_setupHttpHandlers = function(app, express) {
    // Admin UI
    app.get('/plugin/onedrivecheck/admin', function(req, res) {
      if (!req.user || !req.user.siteadmin) { res.status(403).end('Forbidden'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(adminHtml());
    });

    app.post('/plugin/onedrivecheck/admin', express.urlencoded({ extended: true }), function(req, res) {
      if (!req.user || !req.user.siteadmin) { res.status(403).end('Forbidden'); return; }
      if (typeof req.body.meshId === 'string') settings.meshId = req.body.meshId.trim();
      if (req.body.pollInterval) settings.pollInterval = Math.max(10, parseInt(req.body.pollInterval, 10) || 60);
      toolkit.config.set('settings', settings, function() {
        schedulePolling(true);
        res.writeHead(302, { Location: '/plugin/onedrivecheck/admin' });
        res.end();
      });
    });

    // Status API: /plugin/onedrivecheck/status?id=<nodeId>&id=<nodeId>...
    app.get('/plugin/onedrivecheck/status', function(req, res) {
      if (!req.user || !req.user.siteadmin) { res.status(403).end('Forbidden'); return; }
      let ids = req.query.id;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];

      let out = {};
      let pending = ids.length;
      ids.forEach((id) => {
        getStatus(id, function(v) {
          out[id] = v;
          if (--pending === 0) res.json(out);
        });
      });
    });
  };

  // ---- UI Injection (inline; no separate webui file needed) ----------------
  plugin.onWebUIStartupEnd = function() {
    // This script adds the OneDriveCheck column & filter, and fetches statuses.
    return `
<script>
(function(){
  function getRowDeviceId(row) {
    return row.getAttribute('deviceid') ||
           row.dataset.deviceid ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           row.getAttribute('nodeid') ||
           row.dataset.nodeid || null;
  }

  function addColumnHeader() {
    var grid = document.getElementById('devices');
    if (!grid) return false;
    var thead = grid.querySelector('thead');
    if (!thead) return false;
    var tr = thead.querySelector('tr');
    if (!tr) return false;
    if (!document.getElementById('col_onedrivecheck')) {
      var th = document.createElement('th');
      th.id = 'col_onedrivecheck';
      th.textContent = 'OneDriveCheck';
      tr.appendChild(th);
    }
    return true;
  }

  function ensureCells() {
    var grid = document.getElementById('devices');
    if (!grid) return [];
    var rows = grid.querySelectorAll('tbody tr');
    var ids = [];
    rows.forEach(function(row){
      if (!row.querySelector('.onedrivecheck-cell')) {
        var td = document.createElement('td');
        td.className = 'onedrivecheck-cell';
        td.textContent = '—';
        row.appendChild(td);
      }
      var id = getRowDeviceId(row);
      if (id) ids.push(id);
    });
    return ids;
  }

  function paintRows(statusMap) {
    var rows = document.querySelectorAll('#devices tbody tr');
    rows.forEach(function(row){
      var id = getRowDeviceId(row);
      var td = row.querySelector('.onedrivecheck-cell');
      if (!td) return;
      var s = (id && statusMap && statusMap[id]) ? statusMap[id] : null;
      if (!s) { td.textContent = '—'; td.dataset.state = ''; td.title = ''; return; }
      td.textContent = s.status || '—';
      td.title = '20707:' + (s.port20707 ? 'open' : 'closed') + ', 20773:' + (s.port20773 ? 'open' : 'closed');
      td.dataset.state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
    });
  }

  function fetchStatus(ids) {
    if (!ids || ids.length === 0) return Promise.resolve({});
    var url = '/plugin/onedrivecheck/status?' + ids.map(function(id){ return 'id=' + encodeURIComponent(id); }).join('&');
    return fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }

  function applyFilter() {
    var sel = document.getElementById('filter_onedrivecheck');
    if (!sel) return;
    var mode = sel.value;
    var rows = document.querySelectorAll('#devices tbody tr');
    rows.forEach(function(r){
      var td = r.querySelector('.onedrivecheck-cell');
      var state = td ? td.dataset.state : '';
      var show = true;
      if (mode === 'offline')   show = (state === 'offline');
      if (mode === 'notsigned') show = (state === 'notsigned');
      if (mode === 'online')    show = (state === 'online');
      r.style.display = show ? '' : 'none';
    });
  }

  function addFilterUI() {
    var bar = document.getElementById('deviceToolbar') || document.querySelector('.DeviceToolbar') || document.querySelector('#Toolbar');
    if (!bar) return;
    if (document.getElementById('filter_onedrivecheck')) return;
    var label = document.createElement('span');
    label.style.marginLeft = '10px';
    label.textContent = 'OneDriveCheck: ';
    var sel = document.createElement('select');
    sel.id = 'filter_onedrivecheck';
    var opts = [
      {v:'all',      t:'All'},
      {v:'offline',  t:'App Offline (20707 closed & 20773 closed)'},
      {v:'notsigned',t:'Not signed in (20773 open)'},
      {v:'online',   t:'Online (20707 open)'}
    ];
    opts.forEach(function(o){
      var opt = document.createElement('option'); opt.value = o.v; opt.text = o.t; sel.appendChild(opt);
    });
    sel.onchange = applyFilter;
    bar.appendChild(label);
    bar.appendChild(sel);
  }

  function refreshNow() {
    if (!addColumnHeader()) return;
    addFilterUI();
    var ids = ensureCells();
    fetchStatus(ids).then(function(map){
      paintRows(map);
      applyFilter();
    });
  }

  document.addEventListener('meshcentralDeviceListRefreshEnd', refreshNow);
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(refreshNow, 500); });
  setInterval(function(){
    var grid = document.getElementById('devices');
    if (grid && !document.getElementById('col_onedrivecheck')) refreshNow();
  }, 4000);
})();
</script>`;
  };

  // ---- Polling logic -------------------------------------------------------
  // Safer device enumeration across MC builds: read nodes from DB & filter by meshid.
  function getDevicesInMesh(meshId) {
    return new Promise((resolve) => {
      try {
        parent.db.GetAllType('node', (nodes) => {
          const map = {};
          (nodes || []).forEach((n) => {
            if (n.meshid === meshId) map[n._id] = n;
          });
          resolve(map);
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function sendShell(deviceId, cmd) {
    return new Promise((resolve) => {
      // Many builds expose parent.sendCommand(nodeId, 'shell', payload, cb)
      // If your build differs, I can adjust.
      const payload = { cmd: cmd, type: 'powershell' };
      parent.sendCommand(deviceId, 'shell', payload, function(resp) {
        // resp.data is agent stdout (string/Buffer)
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
    try { parent.debug('onedrivecheck: Restarted OneDriveCheckService on ' + deviceId); } catch (e) {}
  }

  async function pollDevices() {
    try {
      if (!settings.meshId) return;
      const allDevices = await getDevicesInMesh(settings.meshId);
      const ids = Object.keys(allDevices || {});
      for (const nodeId of ids) {
        const device = allDevices[nodeId];
        if (!device) continue;

        // Only Windows nodes
        const osd = (device.osdesc || '').toLowerCase();
        if (!osd.includes('windows')) continue;

        const port20707 = await checkPort(nodeId, 20707);
        const port20773 = await checkPort(nodeId, 20773);

        const status = {
          status: (port20707 ? 'App Online' : (port20773 ? 'Not signed in' : 'Offline')),
          port20707: !!port20707,
          port20773: !!port20773,
          lastChecked: Date.now()
        };

        saveStatus(nodeId, status);

        // If both closed, try restart
        if (!port20707 && !port20773) {
          await restartService(nodeId);
        }
      }
    } catch (err) {
      try { parent.debug('onedrivecheck poll error: ' + (err && err.stack || err)); } catch (e) {}
    }
  }

  return plugin;
};
