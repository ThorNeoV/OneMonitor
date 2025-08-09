"use strict";

/** Minimal OneDriveCheck column plugin (safe admin detection)
 * shortName: onedrivecheck
 */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // Tell Mesh which hooks we implement
  obj.exports = ['onWebUIStartupEnd', 'handleAdminReq'];

  // -------- logging helpers
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // -------- webRoot helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p) => baseNoSlash + p;

  // -------- auth helpers (correct bitmask handling)
  function isAnyAdmin(user){
    if (!user) return false;
    // siteadmin is a bitmask; any non-zero => has site-wide admin rights
    const site = ((user.siteadmin >>> 0) !== 0);
    return !!(site || user.superuser || user.domainadmin || user.isadmin || user.admin);
  }
  const isAuthed = (req)=> !!(req && req.user);

  // -------- agent helpers (very simple demo “status”)
  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      obj.meshServer.sendCommand(nodeId, "shell", { cmd, type: "powershell" }, (resp)=>{
        resolve(resp && resp.data ? String(resp.data) : "");
      });
    });
  }
  async function checkOneDriveOnNode(nodeId){
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object -First 1"`;
    const out = await sendShell(nodeId, cmd);
    return /\S/.test(out); // any output => OneDrive is running
  }

  // -------- HTTP routes (mounted via Mesh hook)
  function attachRoutes(app){
    const express = require("express");
    const router = express.Router();

    router.get("/debug", (req,res)=>{
      res.json({
        webRoot,
        url: req.originalUrl || req.url,
        hasUser: !!(req && req.user),
        hasSession: !!(req && req.session)
      });
    });

    router.get("/whoami", (req,res)=>{
      if (!isAuthed(req)) { res.status(401).json({ ok:false, reason:"no user" }); return; }
      const u = req.user;
      res.json({ ok:true, user: {
        name: u.name, userid: u.userid, domain: u.domain,
        siteadmin: u.siteadmin, domainadmin: u.domainadmin, admin: u.admin, isadmin: u.isadmin, superuser: u.superuser
      }});
    });

    // Status: ?id=nodeid&id=nodeid...
    router.get("/status", async (req,res)=>{
      if (!isAuthed(req)) { res.status(403).end("Forbidden"); return; }
      let ids = req.query.id;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];
      const out = {};
      for (const nodeId of ids) {
        try { out[nodeId] = { running: await checkOneDriveOnNode(nodeId) }; }
        catch(e){ err(e); out[nodeId] = { running:false, error:"check_failed" }; }
      }
      res.json(out);
    });

    // Mount under both webRoot and root for safety
    app.use(R('/plugin/onedrivecheck'), router);
    app.use('/plugin/onedrivecheck', router);

    log("routes mounted at " + R('/plugin/onedrivecheck') + " and /plugin/onedrivecheck");
  }

  // Mesh hook: called after middleware/auth is ready
  obj.hook_setupHttpHandlers = function (appOrWeb /*, express */) {
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);
    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try { attachRoutes(app); } catch(e){ err(e); }
  };

  // -------- pluginadmin.ashx handler (admin page + serve UI js)
  const UI_JS = `(function(){
  function qTable(){return document.querySelector('#devices, #devicesTable');}
  function getRowId(row){
    return row.getAttribute('deviceid')||row.dataset.deviceid||
           (row.id&&row.id.startsWith('d_')?row.id.substring(2):null)||
           row.getAttribute('nodeid')||row.dataset.nodeid||null;
  }
  function addHeader(){
    var g=qTable(); if(!g) return false;
    var thead=g.querySelector('thead'); if(!thead) return false;
    var tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById('col_onedrivecheck')){
      var th=document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDrive'; tr.appendChild(th);
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
      var s=(id&&map&&map[id])?map[id]:null;
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; return; }
      var ok = !!s.running;
      td.textContent = ok ? 'Online' : 'Offline';
      td.dataset.state = ok?'online':'offline';
      td.style.color = ok ? '#0a0' : '#a00';
    });
  }
  function fetchStatus(ids){
    if(!ids||ids.length===0) return Promise.resolve({});
    var u = (window.webRoot||'/');
    if(u[u.length-1]!=='/') u+='/';
    u += 'plugin/onedrivecheck/status?' + ids.map(function(id){return 'id='+encodeURIComponent(id)}).join('&');
    return fetch(u, {credentials:'same-origin'}).then(function(r){return r.json()}).catch(function(){return{}});
  }
  function tick(){
    if(!addHeader()) return;
    var ids=ensureCells(); if(ids.length===0) return;
    fetchStatus(ids).then(function(map){ paint(map); });
  }
  document.addEventListener('meshcentralDeviceListRefreshEnd', tick);
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(tick, 600); });
  setInterval(function(){ var g=qTable(); if(g){ tick(); } }, 5000);
})();`;

  obj.handleAdminReq = function(req, res, user){
    // include assets (no auth needed beyond being logged-in via cookie)
    if (req.query && req.query.include == 1) {
      const p = (req.query.path || '').toString();
      if (p.endsWith('ui.js')) {
        res.contentType('text/javascript'); res.send(UI_JS); return;
      }
      res.sendStatus(404); return;
    }

    // admin page (require admin correctly)
    if (!isAnyAdmin(user)) { res.sendStatus(401); return; }

    if (req.query && req.query.admin == 1) {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck Admin</title></head>
<body style="font-family:sans-serif; padding:20px; max-width:860px;">
  <h2>OneDriveCheck – Admin</h2>
  <p>UI column is injected by: <code>pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js</code></p>
  <ul>
    <li><a href="${R('/plugin/onedrivecheck/debug')}" target="_blank">Debug JSON</a></li>
    <li><a href="${R('/plugin/onedrivecheck/whoami')}" target="_blank">WhoAmI</a></li>
  </ul>
</body></html>`;
      res.setHeader("Content-Type","text/html; charset=utf-8");
      res.end(html);
      return;
    }

    res.sendStatus(404);
  };

  // -------- UI injection (loads our column script)
  obj.onWebUIStartupEnd = function () {
    const base = webRoot.endsWith("/") ? webRoot : (webRoot + "/");
    // load via pluginadmin so it works behind Mesh’s CSP
    return `<script src="${base}pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js"></script>`;
  };

  return obj;
};
