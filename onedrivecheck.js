"use strict";

/**
 * OneDriveCheck – Admin panel only (safe)
 * - No UI injection, no express routes, no DB writes.
 * - Endpoints (when logged in):
 *   • /pluginadmin.ashx?pin=onedrivecheck&admin=1          ← admin panel (in Mesh UI)
 *   • /pluginadmin.ashx?pin=onedrivecheck&health=1
 *   • /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *   • /pluginadmin.ashx?pin=onedrivecheck&listonline=1     ← local server only (peering note)
 *   • /pluginadmin.ashx?pin=onedrivecheck&svc=1&id=<id>    ← status for service + ports
 *   • /pluginadmin.ashx?pin=onedrivecheck&restart=1&id=<id>← restart service, then status
 *
 * Uses RunCommands with reply:true and resolves replies via hook_processAgentData.
 * Works when the agent is connected to this server OR to a peer (>=1.1.40).
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Only the hooks we actually use
  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  // ---- config
  const SERVICE_NAME = "OneDriveCheckService";

  // ---- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ---- helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v)=> /^true$/i.test(String(v).trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));
  function isAgentOnline(nodeId){ try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]); } catch { return false; } }

  // Local-online list (in peering this only shows agents connected to THIS server)
  function listOnline() {
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const key of Object.keys(a)) {
      try {
        const n = a[key].dbNode || a[key].dbNodeKey || null;
        out[key] = {
          key,
          name: (n && (n.name || n.computername)) || null,
          os:   (n && (n.osdesc || n.agentcaps)) || null
        };
      } catch { out[key] = { key }; }
    }
    return out;
  }

  // ---- pending replies (responseid -> {resolve,reject,timeout})
  const pend = new Map();
  const makeResponseId = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Resolve agent replies for RunCommands
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (p) {
          pend.delete(command.responseid);
          clearTimeout(p.timeout);
          // MeshCentral sends console output in `console` or `result`
          const raw = (command.console || command.result || '').toString();
          p.resolve({ ok:true, raw });
        }
        return;
      }
    } catch (e) { err(e); }
  };

  // Send RunCommands and await reply (local or peer)
  function runCommandsAndWait(nodeId, type, lines, runAsUser){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                     // 'bat' | 'ps' | 'sh' (we'll use 'bat')
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,   // false = run as agent
        reply: true,
        responseid
      };

      // timeout safety
      const to = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout: to });

      // Local?
      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
        return;
      }

      // Peering?
      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }

      // No route
      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  // Fast port probe (no admin required)
  function cmdProbePorts() {
    // Outputs two lines: p1=True|False and p2=True|False
    return '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & (netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)';
  }

  function cmdServiceQuery(name) {
    return 'sc query "' + name.replace(/"/g,'""') + '" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning';
  }

  function cmdServiceRestart(name) {
    const n = name.replace(/"/g,'""');
    return 'sc stop "'+n+'" & sc start "'+n+'" & ' + cmdServiceQuery(n);
  }

  function parseSvc(raw) {
    const m = /svc\s*=\s*(Running|NotRunning)/i.exec(String(raw||''));
    return m ? m[1] : 'Unknown';
  }
  function parsePorts(raw) {
    const m1 = /p1\s*=\s*(true|false)/i.exec(String(raw||''));
    const m2 = /p2\s*=\s*(true|false)/i.exec(String(raw||''));
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;
    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : 'Offline');
    return { status, port20707: !!p1, port20773: !!p2 };
  }

  async function getStatusBundle(nodeId) {
    // do both in parallel
    const [svc, prt] = await Promise.all([
      runCommandsAndWait(nodeId, 'bat', cmdServiceQuery(SERVICE_NAME), false),
      runCommandsAndWait(nodeId, 'bat', cmdProbePorts(), false)
    ]);
    const svcState = parseSvc(svc.raw);
    const ports = parsePorts(prt.raw);
    return { ok:true, id:nodeId, service: svcState, ports, raw: { svc: svc.raw || '', ports: prt.raw || '' }, meta: svc.meta || prt.meta };
  }

  async function restartAndReport(nodeId) {
    const res = await runCommandsAndWait(nodeId, 'bat', cmdServiceRestart(SERVICE_NAME), false);
    const svcState = parseSvc(res.raw);
    // also re-check ports after restart
    const prt = await runCommandsAndWait(nodeId, 'bat', cmdProbePorts(), false);
    const ports = parsePorts(prt.raw);
    return { ok:true, id:nodeId, restarted:true, service: svcState, ports, raw: { svcRestart: res.raw || '', ports: prt.raw || '' }, meta: res.meta || prt.meta };
  }

  // ---- Admin bridge
  obj.handleAdminReq = async function (req, res, user) {
    try {
      // JSON helpers
      if (req.query.health == 1) { res.json({ ok:true, plugin:"onedrivecheck", exports:obj.exports }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user: summarizeUser(user) }); return;
      }
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents: listOnline() }); return;
      }

      // Status
      if (req.query.svc == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        let id = req.query.id; if (!id) { res.json({ ok:false, reason:"missing id" }); return; }
        id = normalizeId(id);
        if (!isAgentOnline(id) && !(obj.meshServer && obj.meshServer.multiServer)) {
          res.json({ ok:false, reason:"agent_offline_or_no_peer" }); return;
        }
        const out = await getStatusBundle(id);
        res.json(out); return;
      }

      // Restart
      if (req.query.restart == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        let id = req.query.id; if (!id) { res.json({ ok:false, reason:"missing id" }); return; }
        id = normalizeId(id);
        if (!isAgentOnline(id) && !(obj.meshServer && obj.meshServer.multiServer)) {
          res.json({ ok:false, reason:"agent_offline_or_no_peer" }); return;
        }
        const out = await restartAndReport(id);
        res.json(out); return;
      }

      // Admin panel (renders inside MeshCentral Plugins UI)
      if (req.query.admin == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:16px;color:#222}
  h2{margin:0 0 14px 0}
  .row{display:flex;gap:8px;align-items:center;margin:0 0 12px 0;flex-wrap:wrap}
  input[type=text]{padding:6px 8px;border:1px solid #ccc;border-radius:8px;min-width:360px}
  button{padding:6px 10px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer}
  button:hover{background:#efefef}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:8px}
  .card{border:1px solid #ddd;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .label{font-size:12px;color:#666}
  .big{font-weight:700}
  pre{white-space:pre-wrap;word-break:break-word;background:#fafafa;border:1px solid #eee;border-radius:8px;padding:8px;max-height:240px;overflow:auto;margin:8px 0 0 0}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #ccc;font-size:12px;font-weight:700}
  .ok{color:#0a0;border-color:#0a0}
  .warn{color:#b80;border-color:#b80}
  .bad{color:#c00;border-color:#c00}
  .muted{color:#666;font-size:12px}
  table{width:100%;border-collapse:collapse}
  td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
</style>
</head>
<body>
  <h2>OneDriveCheck</h2>
  <div class="row">
    <input id="nodeid" type="text" placeholder="Paste node id (short or long)…">
    <button onclick="doStatus()">Get Status</button>
    <button onclick="doRestart()">Restart Service</button>
    <button onclick="loadLocal()">Refresh Local Online</button>
  </div>

  <div class="cards">
    <div class="card">
      <div class="label">Service</div>
      <div id="svc" class="big">—</div>
      <div class="label" style="margin-top:8px">Ports</div>
      <div id="ports" class="big">—</div>
      <div id="chips" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="label">Diagnostics (raw)</div>
      <pre id="raw">—</pre>
    </div>

    <div class="card">
      <div class="label">Local Online (this server)</div>
      <div class="muted" style="margin:6px 0">Click a row to copy the node id</div>
      <div id="online">Loading…</div>
    </div>
  </div>

<script>
(function(){
  const svcEl = document.getElementById('svc');
  const portsEl = document.getElementById('ports');
  const rawEl = document.getElementById('raw');
  const chipsEl = document.getElementById('chips');
  const onlineEl = document.getElementById('online');
  const input = document.getElementById('nodeid');
  const j = (x)=>JSON.stringify(x,null,2);

  function pill(txt, cls){ const s=document.createElement('span'); s.className='pill '+(cls||''); s.textContent=txt; return s; }
  function clearUi(){
    svcEl.textContent='—';
    portsEl.textContent='—';
    rawEl.textContent='—';
    chipsEl.innerHTML='';
  }
  function normId(id){ return id && !id.startsWith('node//') ? 'node//'+id : id; }

  async function get(qs){
    const u='/pluginadmin.ashx?pin=onedrivecheck&'+qs;
    const r = await fetch(u, { credentials:'same-origin' });
    if(!r.ok){ return { ok:false, status:r.status }; }
    return await r.json();
  }

  function paintOnline(list){
    if(!list || !Object.keys(list).length){ onlineEl.textContent='None'; return; }
    const rows = Object.keys(list).map(k=>{
      const o=list[k];
      return '<tr data-id="'+o.key+'"><td><code>'+o.key+'</code></td><td>'+(o.name||'')+'</td><td>'+(o.os||'')+'</td></tr>';
    }).join('');
    onlineEl.innerHTML = '<table><thead><tr><th>Node Id</th><th>Name</th><th>OS</th></tr></thead><tbody>'+rows+'</tbody></table>';
    onlineEl.querySelectorAll('tbody tr').forEach(tr=>{
      tr.onclick=()=>{ navigator.clipboard.writeText(tr.dataset.id).catch(()=>{}); input.value=tr.dataset.id; };
    });
  }

  function paintStatus(r){
    const svc = r && r.service || 'Unknown';
    const p = r && r.ports;
    const state = p ? (p.port20707 ? 'online' : (p.port20773 ? 'notsigned' : 'offline')) : 'offline';

    svcEl.textContent = svc;
    portsEl.textContent = p ? (p.status + ' (20707:'+(p.port20707?'open':'closed')+', 20773:'+(p.port20773?'open':'closed')+')') : '—';

    chipsEl.innerHTML='';
    chipsEl.appendChild(pill(svc, svc==='Running'?'ok':(svc==='NotRunning'?'bad':'')));
    if (p) {
      chipsEl.appendChild(pill(p.status, state==='online'?'ok':(state==='notsigned'?'warn':'bad')));
    }

    rawEl.textContent = j(r && r.raw ? r.raw : r);
  }

  window.doStatus = async function(){
    clearUi();
    const id = normId(input.value.trim());
    if(!id){ rawEl.textContent='Please paste a node id.'; return; }
    const r = await get('svc=1&id='+encodeURIComponent(id));
    paintStatus(r);
  };

  window.doRestart = async function(){
    clearUi();
    const id = normId(input.value.trim());
    if(!id){ rawEl.textContent='Please paste a node id.'; return; }
    const r = await get('restart=1&id='+encodeURIComponent(id));
    paintStatus(r);
  };

  window.loadLocal = async function(){
    const r = await get('listonline=1');
    paintOnline(r && r.agents);
  };

  // initial
  loadLocal();
})();
</script>
</body></html>`);
        return;
      }

      // nothing matched
      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck admin-only loaded");
  return obj;
};
