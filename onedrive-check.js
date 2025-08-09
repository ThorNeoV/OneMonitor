// OneDriveCheckService Monitor for MeshCentral
// shortName: onedrivecheck
//
// Folder layout:
//   onedrivecheck.js
//   config.json
//   webui/onedrivecheck-webui.js
//
// Requires: "hasAdminPanel": true in config.json

module.exports = function(parent, toolkit, config) {
  const plugin = this;

  // ---- Settings & in-plugin state -----------------------------------------
  // Stored via toolkit.config under key "settings"
  let settings = { meshId: null, pollInterval: 60 }; // seconds
  let pollTimer = null;

  // ---- Helpers for per-device status persistence --------------------------
  // We store each device status as key "status:<nodeId>"
  const statusKey = (id) => `status:${id}`;
  function saveStatus(deviceId, obj, cb) {
    toolkit.config.set(statusKey(deviceId), obj, () => cb && cb());
  }
  function getStatus(deviceId, cb) {
    toolkit.config.get(statusKey(deviceId), (v) => cb && cb(v || null));
  }

  // ---- Backend startup: load settings & schedule polling -------------------
  plugin.server_startup = function() {
    toolkit.config.get('settings', function(val) {
      if (val) settings = Object.assign(settings, val);
      schedulePolling();
    });
  };

  function schedulePolling(forceRunNow) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!settings.meshId) return;
    const intervalMs = Math.max(10, parseInt(settings.pollInterval || 60, 10)) * 1000;
    pollTimer = setInterval(pollDevices, intervalMs);
    if (forceRunNow) pollDevices();
  }

  // ---- Admin Panel (HTML) --------------------------------------------------
  function adminHtml() {
    const meshIdVal = settings.meshId ? String(settings.meshId) : '';
    const pollVal = String(settings.pollInterval || 60);
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheckService Monitor</title></head>
<body style="font-family:sans-serif; padding:20px;">
  <h2>OneDriveCheckService Monitor — Settings</h2>
  <form method="POST" action="/plugin/onedrivecheck/admin">
    <label><strong>Mesh Group ID (meshId)</strong></label><br/>
    <input type="text" name="meshId" value="${meshIdVal}" required style="width:420px" /><br/><br/>
    <label><strong>Polling Interval</strong> (seconds, min 10)</label><br/>
    <input type="number" min="10" name="pollInterval" value="${pollVal}" style="width:120px"/><br/><br/>
    <input type="submit" value="Save" />
  </form>
  <p style="margin-top:14px;color:#555">Tip: Find your Mesh Group ID under <em>Groups → Info</em> in MeshCentral.</p>
</body></html>`;
  }

  // ---- Wire HTTP handlers (admin + status API + static web UI js) ---------
  plugin.hook_setupHttpHandlers = function(app, express) {
    // Admin UI (GET)
    app.get('/plugin/onedrivecheck/admin', function(req, res) {
      if (!req.user || !req.user.siteadmin) { res.status(403).end('Forbidden'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(adminHtml());
    });

    // Admin UI (POST)
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

    // Serve the Web UI JS
    app.get('/plugin/onedrivecheck/ui.js', function(req, res) {
      if (!req.user) { res.status(403).end('Forbidden'); return; }
      try {
        // Read the file from the plugin folder
        // parent.webserver.pluginHandlerPath is usually set; fall back to relative path.
        const fs = require('fs');
        const path = require('path');
        const base = config && config.__plugindir ? config.__plugindir : __dirname;
        const p = path.join(base, 'webui', 'onedrive-check.js');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(p));
      } catch (e) {
        res.status(404).end('// ui.js not found');
      }
    });
  };

  // ---- Inject our UI script after Web UI startup ---------------------------
  // MeshCentral will append what this returns to the page.
  plugin.onWebUIStartupEnd = function(req, res) {
    // Keep this tiny; load the real code from /plugin/onedrivecheck/ui.js
    return `<script src="/plugin/onedrivecheck/ui.js"></script>`;
  };

  // ---- Polling logic -------------------------------------------------------
  async function pollDevices() {
    try {
      if (!settings.meshId) return;

      // Get devices in the configured mesh group
      // This API is typical; if your MC build differs, we can adjust.
      const allDevices = parent.webserver.MeshServer.GetMeshDevices(settings.meshId);
      if (!allDevices) return;

      for (const nodeId in allDevices) {
        const device = allDevices[nodeId];
        if (!device) continue;

        // Only Windows agents
        const osd = (device.osdesc || '').toLowerCase();
        if (!osd.includes('windows')) continue;

        // Run TCP checks (PowerShell)
        const port20707 = await checkPort(device, 20707);
        const port20773 = await checkPort(device, 20773);

        const status = {
          status: (port20707 ? 'App Online' : (port20773 ? 'Not signed in' : 'Offline')),
          port20707: !!port20707,
          port20773: !!port20773,
          lastChecked: Date.now()
        };

        // Save for UI
        saveStatus(device._id, status);

        // If both closed, restart service
        if (!port20707 && !port20773) {
          await restartService(device);
        }
      }
    } catch (err) {
      try { parent.debug('onedrivecheck poll error: ' + (err && err.stack || err)); } catch (e) {}
    }
  }

  function sendShell(device, cmd) {
    return new Promise((resolve) => {
      // parent.sendCommand(nodeId, 'shell', { cmd }, cb) is common; if your build differs I can adapt
      parent.sendCommand(device._id, 'shell', { cmd: cmd }, function(resp) {
        resolve(resp && resp.data ? String(resp.data) : '');
      });
    });
  }

  async function checkPort(device, port) {
    const out = await sendShell(device, `powershell -command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`);
    return /true/i.test(out);
  }

  async function restartService(device) {
    await sendShell(device, `powershell -command "Try { Restart-Service -Name OneDriveCheckService -Force -ErrorAction Stop; 'OK' } Catch { 'ERR:' + $_ }"`);
    try { parent.debug(`onedrivecheck: Restarted OneDriveCheckService on ${device.name || device._id}`); } catch (e) {}
  }

  return plugin;
};

