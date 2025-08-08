// OneDriveCheckService Monitor for MeshCentral
module.exports = function(parent, toolkit, config) {
  var plugin = this;
  var settings = { meshId: null, pollInterval: 60 }; // defaults

  // Load settings on startup
  plugin.server_startup = function() {
    toolkit.config.get('settings', function(val) {
      if (val) settings = val;
      schedulePolling();
    });
  };

  // Admin panel config: GET & POST
  plugin.getAdminPanel = function(res, req) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`
      <h2>OneDriveCheckService Monitor Settings</h2>
      <form method="POST" action="/plugin/onedrive_check/admin">
        <label>Mesh Group ID (meshId):</label>
        <input type="text" name="meshId" value="${settings.meshId || ''}" required/><br>
        <label>Polling Interval (seconds):</label>
        <input type="number" name="pollInterval" value="${settings.pollInterval}" min="10" /><br>
        <input type="submit" value="Save" />
      </form>
      <p>Find your Mesh Group ID under Groups > Info in MeshCentral.</p>
    `);
  };

  plugin.saveAdminPanel = function(res, req) {
    if (req.body.meshId) settings.meshId = req.body.meshId;
    if (req.body.pollInterval) settings.pollInterval = parseInt(req.body.pollInterval);
    toolkit.config.set('settings', settings, function() {
      res.writeHead(302, {Location: '/plugin/onedrive_check/admin'});
      res.end();
      schedulePolling(true);
    });
  };

  // Poll logic
  let pollTimer = null;
  function schedulePolling(force) {
    if (pollTimer) clearInterval(pollTimer);
    if (settings.meshId) {
      pollTimer = setInterval(pollDevices, (settings.pollInterval || 60) * 1000);
      if (force) pollDevices();
    }
  }

  // Poll devices in group, update status, restart if both ports closed
  async function pollDevices() {
    if (!settings.meshId) return;
    let devices = parent.webserver.MeshServer.GetMeshDevices(settings.meshId);
    for (let id in devices) {
      let device = devices[id];
      // Only run on Windows
      if (!device.osdesc || !device.osdesc.toLowerCase().includes('windows')) continue;

      let port20707 = await checkPort(device, 20707);
      let port20773 = await checkPort(device, 20773);
      // Save result for web UI
      device.onedriveCheck = {
        status: (port20707 ? "App Online" : (port20773 ? "Not signed in" : "Offline")),
        port20707, port20773,
        lastChecked: Date.now()
      };

      // If both closed, restart service
      if (!port20707 && !port20773) {
        restartService(device);
      }
    }
  }

  // PowerShell: test port open
  function checkPort(device, port) {
    return new Promise((resolve) => {
      parent.sendCommand(device._id, 'shell', { 
        cmd: `powershell -command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`
      }, function(resp) {
        resolve(resp && resp.data && resp.data.toString().toLowerCase().includes('true'));
      });
    });
  }

  // Restart OneDriveCheckService via PowerShell
  function restartService(device) {
    parent.sendCommand(device._id, 'shell', { 
      cmd: `powershell -command "Restart-Service -Name OneDriveCheckService -Force"`
    }, function(resp) {
      parent.debug(`Restarted OneDriveCheckService on ${device.name}`);
    });
  }

  // Serve data to web UI for device table
  plugin.hook_deviceSummary = function(device) {
    if (device.onedriveCheck) {
      return { onedriveCheck: device.onedriveCheck };
    }
    return {};
  };

  return plugin;
};