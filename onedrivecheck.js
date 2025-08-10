"use strict";

/**
 * OneDriveCheck – backend-only, zero UI hooks (won’t break Mesh UI)
 * Endpoints (open in a NEW TAB while logged in):
 *   /pluginadmin.ashx?pin=onedrivecheck&page=1   ← simple HTML page
 *   /pluginadmin.ashx?pin=onedrivecheck&health=1
 *   /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *   /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *   /pluginadmin.ashx?pin=onedrivecheck&svc=1&id=<nodeId or shortId>
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Only backend bridge. No UI hooks exported.
  obj.exports = ["handleAdminReq"];

  const SERVICE_NAME = "OneDriveCheckService";
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v)=> /^true$/i.test(String(v||"").trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));
  function isAgentOnline(nodeId){ try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]); } catch { return false; } }

  function listOnlineLocal() {
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

  // Super-simple runcommands with reply:true is avoided here to keep this file
  // 100% UI-safe. We’ll do a quick bat one-liner and assume immediate output.
  // If your environment needs proper reply handling, we can add it back later.
  function runCommandsFireOnce(nodeId, type, line){
    return new Promise((resolve)=>{
      try {
        const agent = wsserver && wsserver.wsagents && wsserver.wsagents[nodeId];
        if (!agent || agent.authenticated !== 2) return resolve({ ok:false, raw:"", meta:"no_local_agent" });

        const cmd = { action:'runcommands', type, cmds:[String(line||"")], runAsUser:false, reply:true, responseid:'odc_'+Date.now() };
        // Try/catch; if send fails, return quickly.
        try { agent.send(JSON.stringify(cmd)); } catch { return resolve({ ok:false, raw:"", meta:"send_fail" }); }

        // Give it a very short window to answer; if not, we still don’t crash UI
        const t = setTimeout(()=>resolve({ ok:false, raw:"", meta:"timeout" }), 2000);
        // Listen one-time on agent console stream
        const onMsg = (data)=>{
          try {
            const c = JSON.parse(data);
            if (c && c.action === 'runcommands' && c.responseid === cmd.responseid) {
              clearTimeout(t);
              agent.removeListener('message', onMsg);
              resolve({ ok:true, raw: String(c.console || c.result || "") });
            }
          } catch { /* ignore */ }
        };
        // Mesh agent ws object is a ws; hook message
        try { agent.on('message', onMsg); } catch { /* ignore */ }
      } catch {
        resolve({ ok:false, raw:"", meta:"error" });
      }
    });
  }

  async function getSvcAndPorts(nodeId){
    // Netstat + service in one pass (fast)
    const bat = [
      '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & (netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)',
      `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning`
    ].join(' & ');

    const res = await runCommandsFireOnce(nodeId, 'bat', bat);
    const raw = (res && res.raw) ? String(res.raw) : '';
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const mS = /svc\s*=\s*(Running|NotRunning)/i.exec(raw);
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;
    const svc = mS ? mS[1] : (res && res.meta === 'timeout' ? 'Unknown' : 'Unknown');
    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : 'Offline');

    return { ok: !!res?.ok, status, port20707: !!p1, port20773: !!p2, service: svc, raw, meta: res && res.meta };
  }

  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (req.query.health == 1) { res.json({ ok:true, plugin:'onedrivecheck', exports:obj.exports }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:'no user' }); return; }
        res.json({ ok:true, user:summarizeUser(user) }); return;
      }
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.json({ ok:true, agents:listOnlineLocal() }); return;
      }
      if (req.query.svc == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        let id = req.query.id; if (!id) { res.json({ ok:false, reason:'missing id' }); return; }
        id = normalizeId(id);
        if (!isAgentOnline(id)) { res.json({ ok:true, id, status:'Offline', port20707:false, port20773:false, service:'Unknown', raw:'' }); return; }
        const out = await getSvcAndPorts(id);
        res.json({ id, ...out }); return;
      }

      if (req.query.page == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<!doctype html>
<meta charset="utf-8">
<title>OneDriveCheck (safe)</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:16px;color:#222}
  h2{margin:0 0 12px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
  .card{border:1px solid #ddd;border-radius:10px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .row{display:flex;align-items:center;gap:8px;margin:0 0 8px}
  input[type=text]{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:8px}
  button{padding:6px 10px;border-radius:8px;border:1px solid #bbb;background:#f7f7f7;cursor:pointer}
  button:hover{background:#f0f0f0}
  pre{white-space:pre-wrap;word-break:break-word;background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px;max-height:300px;overflow:auto;margin:8px 0 0}
  .muted{color:#666;font-size:12px}
</style>
<h2>OneDriveCheck (safe)</h2>
<div class="grid">
  <div class="card">
    <div class="row"><strong>Health</strong><button onclick="loadHealth()">Refresh</button></div>
    <pre id="out-health">Loading…</pre>
  </div>
  <div class="card">
    <div class="row"><strong>Who am I</strong><button onclick="loadWho()">Refresh</button></div>
    <pre id="out-who">Loading…</pre>
  </div>
  <div class="card">
    <div class="row"><strong>Online (this server)</strong><button onclick="loadOnline()">Refresh</button></div>
    <pre id="out-online">Loading…</pre>
    <div class="muted">Peering note: only shows agents connected to THIS server.</div>
  </div>
  <div class="card">
    <div class="row"><strong>Check a node</strong></div>
    <input id="nodeId" type="text" placeholder="short id or node//long id">
    <div class="row" style="margin-top:6px;gap:6px">
      <button onclick="checkNode()">Check service & ports</button>
    </div>
    <pre id="out-node">Enter an id, then click “Check”.</pre>
    <div class="muted">Service: ${SERVICE_NAME} • Ports: 20707 / 20773</div>
  </div>
</div>
<script>
(function(){
  function j(x){ try{return JSON.stringify(x,null,2);}catch(e){return String(x)} }
  function show(id,val){ document.getElementById(id).textContent = j(val); }
  async function get(qs){
    try{
      const r = await fetch('/pluginadmin.ashx?pin=onedrivecheck&' + qs, { credentials:'same-origin' });
      if(!r.ok) return { ok:false, status:r.status };
      return await r.json();
    }catch(e){ return { ok:false, error:String(e) }; }
  }
  window.loadHealth = async ()=> show('out-health', await get('health=1'));
  window.loadWho    = async ()=> show('out-who',    await get('whoami=1'));
  window.loadOnline = async ()=> show('out-online', await get('listonline=1'));
  window.checkNode  = async ()=>{
    const id = document.getElementById('nodeId').value.trim();
    if(!id){ show('out-node', { ok:false, error:'Please enter an id'}); return; }
    show('out-node', { loading:true });
    const d = await get('svc=1&id=' + encodeURIComponent(id));
    show('out-node', d);
  };
  loadHealth(); loadWho(); loadOnline();
})();
</script>`);
        return;
      }

      res.sendStatus(404);
    } catch (e) { try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{}; res.sendStatus(500); }
  };

  return obj;
};
