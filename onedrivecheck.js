"use strict";

/**
 * OneDriveCheck – service status (SAFE: admin-bridge only)
 *
 * URLs (while logged in):
 *   /pluginadmin.ashx?pin=onedrivecheck&admin=1
 *   /pluginadmin.ashx?pin=onedrivecheck&health=1
 *   /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *   /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *   /pluginadmin.ashx?pin=onedrivecheck&servicestatus=1&name=OneDriveCheckService&id=<id>[&id=...]
 *   /pluginadmin.ashx?pin=onedrivecheck&servicerestart=1&name=OneDriveCheckService&id=<id>[&id=...]
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Only safe hooks
  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  // ---- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ---- helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));

  function listOnline() {
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const key of Object.keys(a)) {
      try {
        const n = a[key].dbNode || a[key].dbNodeKey || null;
        out[key] = { key, name:(n && (n.name||n.computername))||null, os:(n && (n.osdesc||n.agentcaps))||null };
      } catch { out[key] = { key }; }
    }
    return out;
  }

  // ---- runcommands (with reply) plumbing
  const pend = new Map(); // responseid -> { resolve, timeout }
  const makeResponseId = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;

      // Standard runcommands reply
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (p) {
          pend.delete(command.responseid);
          clearTimeout(p.timeout);
          // On recent builds, the output is in command.console (or command.result)
          const raw = (command.console || command.result || '').toString();
          p.resolve({ ok:true, raw });
        }
        return;
      }
    } catch (e) { err(e); }
  };

  function runCommandsAndWait(nodeId, type /* 'bat'|'ps' */, lines, runAsUser /* bool */) {
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,   // false = run as agent service
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);
      pend.set(responseid, { resolve, timeout });

      // If local agent, send direct; else Dispatch to peers
      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
        return;
      }
      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }
      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  // ---- service helpers
  function parseSvcRaw(raw) {
    // We emit exactly one of: svc=Running | svc=NotRunning | svc=NotFound
    const m = /svc\s*=\s*([A-Za-z]+)/.exec(String(raw||''));
    const svc = m ? m[1] : '';
    if (/^Running$/i.test(svc)) return 'Running';
    if (/^NotRunning$/i.test(svc)) return 'NotRunning';
    if (/^NotFound$/i.test(svc)) return 'NotFound';
    // Fallback (if someone ran a different build of sc):
    if (/\bSTATE\s*:\s*4\s+RUNNING/i.test(raw)) return 'Running';
    if (/The specified service does not exist/i.test(raw)) return 'NotFound';
    if (/STOPPED|PAUSED|STOP_PENDING|START_PENDING/i.test(raw)) return 'NotRunning';
    return 'Unknown';
  }

  async function checkService(nodeId, svcName) {
    // Fast CMD probe, agent context (LOCAL SYSTEM). No admin UAC prompt.
    const bat = `sc query "${svcName}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning`;
    const out = await runCommandsAndWait(nodeId, 'bat', bat, false);
    const status = out.ok ? parseSvcRaw(out.raw) : 'Unknown';
    return { ok: out.ok, service: svcName, status, raw: String(out.raw||''), meta: out.meta };
  }

  async function restartService(nodeId, svcName) {
    // Basic stop & start (best-effort)
    const bat = `sc stop "${svcName}" & sc start "${svcName}" & (sc query "${svcName}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning)`;
    const out = await runCommandsAndWait(nodeId, 'bat', bat, false);
    const status = out.ok ? parseSvcRaw(out.raw) : 'Unknown';
    return { ok: out.ok, service: svcName, status, raw: String(out.raw||''), meta: out.meta };
  }

  // ---- admin bridge
  obj.handleAdminReq = async function (req, res, user) {
    try {
      if (req.query.health == 1) { res.json({ ok:true, plugin:"onedrivecheck", exports:obj.exports }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user: summarizeUser(user) }); return;
      }
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents: listOnline() }); return;
      }

      // Service status over a set of node ids
      if (req.query.servicestatus == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const svc = (req.query.name || 'OneDriveCheckService').toString();
        let ids = req.query.id; if (!ids) { res.json({ ok:true, results:{} }); return; }
        if (!Array.isArray(ids)) ids = [ids];
        ids = ids.map(normalizeId);

        const out = {};
        const queue = ids.slice();
        const MAX_PAR = 8;
        async function worker() {
          while (queue.length) {
            const id = queue.shift();
            try {
              out[id] = await checkService(id, svc);
            } catch (e) { err(e); out[id] = { ok:false, service:svc, status:'Unknown', raw:'' }; }
          }
        }
        await Promise.all(Array.from({ length: Math.min(MAX_PAR, ids.length) }, worker));
        res.json({ ok:true, service:svc, results:out });
        return;
      }

      // Optional: restart a service
      if (req.query.servicerestart == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const svc = (req.query.name || 'OneDriveCheckService').toString();
        let ids = req.query.id; if (!ids) { res.json({ ok:true, results:{} }); return; }
        if (!Array.isArray(ids)) ids = [ids];
        ids = ids.map(normalizeId);

        const out = {};
        const queue = ids.slice();
        const MAX_PAR = 4; // throttle a bit for restarts
        async function worker() {
          while (queue.length) {
            const id = queue.shift();
            try {
              out[id] = await restartService(id, svc);
            } catch (e) { err(e); out[id] = { ok:false, service:svc, status:'Unknown', raw:'' }; }
          }
        }
        await Promise.all(Array.from({ length: Math.min(MAX_PAR, ids.length) }, worker));
        res.json({ ok:true, service:svc, results:out });
        return;
      }

      // Minimal admin page (keeps things safe)
      if (req.query.admin == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html>
<meta charset="utf-8">
<title>OneDriveCheck – Admin</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:20px;color:#222}
 h2{margin:0 0 12px}
 input,button{font:inherit}
 code{background:#f6f6f6;padding:2px 4px;border-radius:6px}
 .box{border:1px solid #ddd;border-radius:10px;padding:12px;margin-top:12px}
 pre{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .ok{color:#0a0}.bad{color:#c00}.warn{color:#b80}
</style>
<h2>OneDriveCheck – Admin</h2>

<div class="box">
  <div class="row">
    <label>Service name:</label>
    <input id="svc" value="OneDriveCheckService" style="min-width:280px">
    <button onclick="loadWho()">Who am I</button>
    <button onclick="loadOnline()">List Online</button>
  </div>
  <div class="row" style="margin-top:8px">
    <input id="ids" placeholder="Paste one or more node IDs, separated by spaces" style="flex:1;min-width:420px">
  </div>
  <div class="row" style="margin-top:8px">
    <button onclick="statusNow()">Service Status</button>
    <button onclick="restartNow()">Restart Service</button>
  </div>
</div>

<div class="box">
  <strong>Output</strong>
  <pre id="out">Ready.</pre>
</div>

<script>
(function(){
  function j(x){ try{return JSON.stringify(x,null,2);}catch(e){return String(x);} }
  function show(o){ document.getElementById('out').textContent = j(o); }
  function getIds(){
    const raw = (document.getElementById('ids').value || '').trim();
    if (!raw) return [];
    return raw.split(/\\s+/g);
  }
  async function call(qs){
    const u = '/pluginadmin.ashx?pin=onedrivecheck&' + qs;
    try{ const r = await fetch(u, { credentials:'same-origin' }); return await r.json(); }
    catch(e){ return { ok:false, error:String(e) }; }
  }

  window.loadWho = async ()=> show(await call('whoami=1'));
  window.loadOnline = async ()=> show(await call('listonline=1'));

  window.statusNow = async ()=>{
    const svc = encodeURIComponent(document.getElementById('svc').value || 'OneDriveCheckService');
    const ids = getIds(); if (!ids.length) { show({ok:false, reason:'no ids'}); return; }
    const qs = 'servicestatus=1&name='+svc + ids.map(id=>'&id='+encodeURIComponent(id)).join('');
    show(await call(qs));
  };
  window.restartNow = async ()=>{
    const svc = encodeURIComponent(document.getElementById('svc').value || 'OneDriveCheckService');
    const ids = getIds(); if (!ids.length) { show({ok:false, reason:'no ids'}); return; }
    const qs = 'servicerestart=1&name='+svc + ids.map(id=>'&id='+encodeURIComponent(id)).join('');
    show(await call(qs));
  };
})();
</script>`);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck service-status loaded");
  return obj;
};
