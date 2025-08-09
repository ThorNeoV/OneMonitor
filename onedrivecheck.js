"use strict";

/** Minimal Port Check plugin (no timers, no persistence)
 * shortName: onedrivecheck
 */
module.exports.portcheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // logging helpers
  const log = (m)=>{ try{ obj.meshServer.info("portcheck: " + m); }catch{ console.log("portcheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("portcheck error: " + (e && e.stack || e)); }catch{ console.error("portcheck error:", e); } };

  // webRoot helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p) => baseNoSlash + p;

  // auth helper: keep super permissive for testing (any logged-in user)
  function isAuthed(req){ return !!(req && req.user); }

  // -------- agent helpers (safe, one-shot) ----------
  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      obj.meshServer.sendCommand(nodeId, "shell", { cmd, type: "powershell" }, (resp)=>{
        resolve(resp && resp.data ? String(resp.data) : "");
      });
    });
  }

  async function checkPortOnNode(nodeId, port){
    // Windows agents: quickest/no-dependency check
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`;
    const out = await sendShell(nodeId, cmd);
    return /true/i.test(out);
  }

  // -------- routes ----------
  function attachRoutes(app){
    const express = require("express");
    const router = express.Router();

    router.get("/debug", (req,res)=>{
      res.json({
        webRoot,
        url: req.originalUrl || req.url,
        hasUser: !!(req && req.user),
        hasSession: !!(req && req.session),
        cookie: !!(req && req.headers && req.headers.cookie)
      });
    });

    router.get("/whoami", (req,res)=>{
      if (!req || !req.user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
      const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = req.user;
      res.json({ ok:true, user:{ name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
    });

    // /status?id=<nodeId>&id=<nodeId>&port=20707
    router.get("/status", async (req,res)=>{
      if (!isAuthed(req)) { res.status(403).end("Forbidden"); return; }

      let ids = req.query.id;
      const port = parseInt(req.query.port, 10) || 20707;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];

      const out = {};
      for (const nodeId of ids) {
        try {
          out[nodeId] = { open: await checkPortOnNode(nodeId, port) };
        } catch(e) {
          err(e);
          out[nodeId] = { open: false, error: "check_failed" };
        }
      }
      res.json(out);
    });

    // UI injector
    router.get("/ui.js", (req,res)=>{
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
    if(!document.getElementById('col_portcheck')){
      var th=document.createElement('th'); th.id='col_portcheck'; th.textContent='PortCheck'; tr.appendChild(th);
    }
    return true;
  }
  function ensureCells(){
    var g=qTable(); if(!g) return [];
    var rows=g.querySelectorAll('tbody tr'); var ids=[];
    rows.forEach(function(r){
      if(!r.querySelector('.portcheck-cell')){
        var td=document.createElement('td'); td.className='portcheck-cell'; td.textContent='…'; r.appendChild(td);
      }
      var id=getRowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function paint(map){
    var g=qTable(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(function(r){
      var id=getRowId(r);
      var td=r.querySelector('.portcheck-cell'); if(!td) return;
      var s=id && map && map[id]; if(!s){ td.textContent='—'; td.title=''; return; }
      td.textContent = s.open ? 'open' : 'closed';
      td.title = s.open ? 'port open' : 'port closed';
    });
  }
  function fetchStatus(ids, port){
    if(!ids || ids.length===0) return Promise.resolve({});
    var url = '${R('/plugin/portcheck/status')}' + '?' + ids.map(function(id){ return 'id='+encodeURIComponent(id); }).join('&') + '&port=' + encodeURIComponent(port || 20707);
    return fetch(url, { credentials:'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }
  function addToolbar(){
    var bar=document.getElementById('deviceToolbar')||document.querySelector('.DeviceToolbar')||document.querySelector('#Toolbar')||document.querySelector('#devicestoolbar');
    if(!bar || document.getElementById('btn_portcheck')) return;
    var inp=document.createElement('input'); inp.type='number'; inp.min='1'; inp.value='20707'; inp.style.width='90px'; inp.id='port_portcheck';
    var btn=document.createElement('button'); btn.id='btn_portcheck'; btn.textContent='Check Port';
    btn.onclick=function(){
      var ids=ensureCells(); var p=parseInt(inp.value,10)||20707;
      fetchStatus(ids, p).then(paint);
    };
    var span=document.createElement('span'); span.style.marginLeft='10px'; span.appendChild(document.createTextNode('Port: ')); span.appendChild(inp); span.appendChild(btn);
    bar.appendChild(span);
  }
  function tickOnce(){ if(!addHeader()) return; addToolbar(); var ids=ensureCells(); }
  document.addEventListener('meshcentralDeviceListRefreshEnd', tickOnce);
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(tickOnce, 500); });
})();`;
      res.setHeader("Content-Type","application/javascript; charset=utf-8");
      res.end(js);
    });

    // Mount under BOTH base paths
    app.use(R('/plugin/portcheck'), router);
    app.use('/plugin/portcheck', router);

    log("routes mounted at " + R('/plugin/portcheck') + " and /plugin/portcheck");
  }

  // Mesh hook: after middleware/auth is ready
  obj.hook_setupHttpHandlers = function (appOrWeb /*, express */) {
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);
    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try { attachRoutes(app); } catch(e){ err(e); }
  };

  // Inject our UI on device pages
  obj.onWebUIStartupEnd = function () {
    const base = webRoot.endsWith("/") ? webRoot : (webRoot + "/");
    return `<script src="${base}plugin/portcheck/ui.js"></script>`;
  };

  return obj;
};
