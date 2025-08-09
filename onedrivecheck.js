/**
 * OneDriveCheckService Monitor (devtools-style plugin)
 * shortName: onedrivecheck
 * - Exposes routes only after Mesh adds cookie-session (via hook_setupHttpHandlers)
 * - Injects CSP-safe UI via /plugin/onedrivecheck/ui.js
 */

"use strict";

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver; // Mesh webserver wrapper (has app, webRoot, etc.)

  // ---------- logging helpers (prefer Mesh logger, fall back to console)
  function log(m){ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ try{ console.log("onedrivecheck:", m);}catch{} } }
  function dbg(m){ try{ obj.meshServer.debug("onedrivecheck: " + m); }catch{ try{ console.debug("onedrivecheck:", m);}catch{} } }
  function err(e){ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ try{ console.error("onedrivecheck error:", e);}catch{} } }

  // ---------- webRoot helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0, -1) : webRoot;
  const R = (p) => baseNoSlash + p;

  // ---------- tiny file store (settings + per-node status)
  const fs = require("fs");
  const path = require("path");
  const plugindir = __dirname;
  const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(plugindir, n), "utf8")); } catch { return null; } };
  const writeJson = (n, v) => { try { fs.writeFileSync(path.join(plugindir, n), JSON.stringify(v || {}, null, 2)); } catch (e) { err(e); } };

  let settings = { meshId: null, pollInterval: 60 };
  let pollTimer = null;
  const statusesFile = "statuses.json";
  const statusKey = (id) => `status:${id}`;
  const getStatus = (id) => { const all = readJson(statusesFile) || {}; return all[statusKey(id)] || null; };
  const setStatus = (id, val) => {
    const all = readJson(statusesFile) || {};
    all[statusKey(id)] = Object.assign({ lastChecked: Date.now() }, val || {});
    writeJson(statusesFile, all);
  };

  // load persisted settings
  (function loadSettings() {
    const s = readJson("settings.json");
    if (s) settings = Object.assign(settings, s);
    log("settings=" + JSON.stringify(settings));
  })();

  // ---------- auth helper
  function isAdmin(req) {
    if (!req || !req.user) return false;
    const u = req.user;
    // Mesh sets siteadmin to a rights bitmask (number) for site-wide rights.
    return !!(u.superuser || u.domainadmin || u.admin || u.isadmin || (u.siteadmin && (u.siteadmin | 0) !== 0));
  }

  // ---------- route registration
  function attachRoutes(app) {
    // Debug route
    app.get(R("/plugin/onedrivecheck/debug"), function (req, res) {
      res.json({
        webRoot,
        url: req.originalUrl || req.url,
        hasUser: !!(req && req.user),
        hasSession: !!(req && req.session),
        cookiesHeaderPresent: !!(req && req.headers && req.headers.cookie),
        cookieLen: req && req.headers && req.headers.cookie ? req.headers.cookie.length : 0
      });
    });

    // Who am I
    app.get(R("/plugin/onedrivecheck/whoami"), function (req, res) {
      if (!req || !req.user) { res.status(401).json({ ok: false, reason: "no user" }); return; }
      const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = req.user;
      res.json({ ok: true, user: { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
    });

    // Admin GET
    app.get(R("/plugin/onedrivecheck/admin"), function (req, res) {
      if (!isAdmin(req)) { res.status(403).end("Forbidden"); return; }
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheckService Monitor</title></head>
<body style="font-family:sans-serif; padding:20px; max-width:860px;">
  <h2>OneDriveCheckService Monitor — Settings</h2>
  <form method="POST" action="${R('/plugin/onedrivecheck/admin')}">
    <label><strong>Mesh Group ID (meshId)</strong></label><br/>
    <input type="text" name="meshId" value="${settings.meshId ? String(settings.meshId) : ''}" required style="width:420px" /><br/><br/>
    <label><strong>Polling Interval</strong> (seconds, min 10)</label><br/>
    <input type="number" min="10" name="pollInterval" value="${String(settings.pollInterval || 60)}" style="width:120px"/><br/><br/>
    <input type="submit" value="Save" />
  </form>
  <p style="margin-top:14px;color:#555">Tip: Groups → Info shows the meshId.</p>
</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    });

    // x-www-form-urlencoded fallback (don’t rely on express.urlencoded version)
    function manualUrlencoded(req, res, next) {
      if (req.method !== "POST") return next();
      const ctype = (req.headers["content-type"] || "").toLowerCase();
      if (!ctype.includes("application/x-www-form-urlencoded")) return next();
      let data = "";
      req.on("data", (d) => { data += d; if (data.length > 1e6) req.destroy(); });
      req.on("end", () => {
        const body = {};
        (data || "").split("&").forEach(p => {
          if (!p) return;
          const eq = p.indexOf("=");
          const k = decodeURIComponent((eq === -1 ? p : p.slice(0, eq)).replace(/\+/g, " "));
          const v = decodeURIComponent((eq === -1 ? "" : p.slice(eq + 1)).replace(/\+/g, " "));
          if (k) body[k] = v;
        });
        req.body = body; next();
      });
    }

    // Admin POST
    app.post(R("/plugin/onedrivecheck/admin"), manualUrlencoded, function (req, res) {
      if (!isAdmin(req)) { res.status(403).end("Forbidden"); return; }
      if (req.body && typeof req.body.meshId === "string") settings.meshId = req.body.meshId.trim();
      if (req.body && req.body.pollInterval) settings.pollInterval = Math.max(10, parseInt(req.body.pollInterval, 10) || 60);
      writeJson("settings.json", settings);
      log("settings saved: " + JSON.stringify(settings));
      schedulePolling(true);
      res.writeHead(302, { Location: R("/plugin/onedrivecheck/admin") });
      res.end();
    });

    // Status API
    app.get(R("/plugin/onedrivecheck/status"), function (req, res) {
      if (!isAdmin(req)) { res.status(403).end("Forbidden"); return; }
      let ids = req.query.id;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];
      const out = {};
      ids.forEach((id) => { out[id] = getStatus(id); });
      res.json(out);
    });

    // UI JS
    app.get(R("/plugin/onedrivecheck/ui.js"), function (req, res) {
      const js = String.raw`(function(){
  function qTable(){ return document.querySelector('#devices, #devicesTable'); }
  function getRowId(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           row.getAttribute('nodeid') || row.dataset.nodeid || null;
  }
  function addHeader(){
    var g=qTable(); if(!g) return false;
    var thead=g.querySelector('thead'); if(!thead) return false;
    var tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById('col_onedrivecheck')){
      var th=document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDriveCheck'; tr.appendChild(th);
    }
    return true;
  }
  function ensureCells(){
    var g=qTable(); if(!g) return [];
    var rows=g.querySelectorAll('tbody tr'); var ids=[];
    rows.forEach(function(r){
      if(!r.querySelector('.onedrivecheck-cell')){
        var td=document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—'; r.appendChild(td);
      }
      var id=getRowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function paint(map){
    var g=qTable(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(function(r){
      var id=getRowId(r);
      var td=r.querySelector('.onedrivecheck-cell'); if(!td) return;
      var s=(id && map && map[id])?map[id]:null;
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; return; }
      td.textContent = s.status || '—';
      td.title = '20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed');
      td.dataset.state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
    });
  }
  function fetchStatus(ids){
    if(!ids || ids.length===0) return Promise.resolve({});
    var url = '${R('/plugin/onedrivecheck/status')}' + '?' + ids.map(function(id){ return 'id='+encodeURIComponent(id); }).join('&');
    return fetch(url, { credentials:'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }
  function addFilter(){
    var bar=document.getElementById('deviceToolbar')||document.querySelector('.DeviceToolbar')||document.querySelector('#Toolbar')||document.querySelector('#devicestoolbar');
    if(!bar) return; if(document.getElementById('filter_onedrivecheck')) return;
    var label=document.createElement('span'); label.style.marginLeft='10px'; label.textContent='OneDriveCheck: ';
    var sel=document.createElement('select'); sel.id='filter_onedrivecheck';
    [{v:'all',t:'All'},{v:'offline',t:'App Offline (20707 closed & 20773 closed)'},{v:'notsigned',t:'Not signed in (20773 open)'},{v:'online',t:'Online (20707 open)'}]
      .forEach(function(o){ var opt=document.createElement('option'); opt.value=o.v; opt.text=o.t; sel.appendChild(opt); });
    sel.onchange=function(){
      var mode=sel.value, rows=(qTable()||document).querySelectorAll('tbody tr');
      rows.forEach(function(r){
        var td=r.querySelector('.onedrivecheck-cell'); var st=td?td.dataset.state:'';
        var show=true;
        if(mode==='offline') show=(st==='offline');
        if(mode==='notsigned') show=(st==='notsigned');
        if(mode==='online') show=(st==='online');
        r.style.display=show?'':'none';
      });
    };
    bar.appendChild(label); bar.appendChild(sel);
  }
  function tick(){
    if(!addHeader()) return;
    addFilter();
    var ids=ensureCells();
    fetchStatus(ids).then(function(map){ paint(map); });
  }
  document.addEventListener('meshcentralDeviceListRefreshEnd', tick);
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(tick, 500); });
  setInterval(function(){ var g=qTable(); if(g && !document.getElementById('col_onedrivecheck')) tick(); }, 4000);
})();`;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(js);
    });

    log("routes attached at webRoot=" + webRoot);
  }

  // ---------- Mesh hook: attach after Mesh sets up middleware & auth
  obj.hook_setupHttpHandlers = function (appOrWeb /*, express */) {
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);

    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try {
      attachRoutes(app);
      log("hook_setupHttpHandlers: routes attached via Mesh hook");
    } catch (e) {
      err(e);
    }
  };

  // ---------- UI injection (adds our column/filter on device list pages)
  obj.onWebUIStartupEnd = function () {
    const base = webRoot.endsWith("/") ? webRoot : (webRoot + "/");
    return `<script src="${base}plugin/onedrivecheck/ui.js"></script>`;
  };

  // ---------- polling (Windows agents) — guarded so it can’t crash if API missing
  function sendShell(nodeId, cmd) {
    return new Promise((resolve) => {
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      const payload = { cmd, type: "powershell" };
      obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp) {
        resolve(resp && resp.data ? String(resp.data) : "");
      });
    });
  }
  async function checkPort(nodeId, port) {
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`;
    const out = await sendShell(nodeId, cmd);
    return /true/i.test(out);
  }
  async function restartService(nodeId) {
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Try { Restart-Service -Name OneDriveCheckService -Force -ErrorAction Stop; 'OK' } Catch { 'ERR:' + $_ }"`;
    await sendShell(nodeId, cmd);
    dbg("Restarted OneDriveCheckService on " + nodeId);
  }
  function getDevicesInMesh(meshId) {
    return new Promise((resolve) => {
      try {
        obj.meshServer.db.GetAllType("node", (nodes) => {
          const map = {}; (nodes || []).forEach((n) => { if (n.meshid === meshId) map[n._id] = n; });
          resolve(map);
        });
      } catch (e) { err(e); resolve({}); }
    });
  }
  async function poll() {
    try {
      if (!settings.meshId) return;
      const nodes = await getDevicesInMesh(settings.meshId);
      for (const nodeId of Object.keys(nodes || {})) {
        const d = nodes[nodeId]; const osd = (d.osdesc || "").toLowerCase();
        if (!osd.includes("windows")) continue;
        const port20707 = await checkPort(nodeId, 20707);
        const port20773 = await checkPort(nodeId, 20773);
        const status = {
          status: (port20707 ? "App Online" : (port20773 ? "Not signed in" : "Offline")),
          port20707: !!port20707,
          port20773: !!port20773
        };
        setStatus(nodeId, status);
        if (!port20707 && !port20773) await restartService(nodeId);
      }
    } catch (e) { err(e); }
  }
  function schedulePolling(runNow) {
    try {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (!settings.meshId) { log("no meshId set; not polling"); return; }
      const ms = Math.max(10, parseInt(settings.pollInterval || 60, 10)) * 1000;
      pollTimer = setInterval(poll, ms);
      if (runNow) poll();
    } catch (e) { err(e); }
  }
  schedulePolling(true);

  return obj;
};
