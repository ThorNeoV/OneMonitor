"use strict";

/**
 * OneDriveCheck – tiny admin dashboard (SAFE: admin-bridge only)
 *
 * URLs (while logged in):
 *   /pluginadmin.ashx?pin=onedrivecheck&admin=1      → dashboard page
 *   /pluginadmin.ashx?pin=onedrivecheck&health=1
 *   /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *   /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Only expose the admin bridge handler
  obj.exports = ["handleAdminReq"];

  // Log helpers
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // Summaries
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;

  // Local-online list (note: in peering this only shows agents on THIS node)
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

  // Admin bridge
  obj.handleAdminReq = function (req, res, user) {
    try {
      // Basic JSON endpoints
      if (req.query.health == 1) {
        res.json({ ok:true, plugin:"onedrivecheck", exports:obj.exports });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user: summarizeUser(user) });
        return;
      }

      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents: listOnline() });
        return;
      }

      // Simple admin dashboard page
      if (req.query.admin == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>OneDriveCheck – Admin</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; margin:20px; color:#222;}
  h2{margin:0 0 14px 0}
  .grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px;}
  .card{border:1px solid #ddd; border-radius:10px; padding:14px; box-shadow:0 1px 2px rgba(0,0,0,0.04);}
  .row{display:flex; align-items:center; gap:8px; margin:0 0 8px 0}
  button{padding:6px 10px; border-radius:8px; border:1px solid #bbb; background:#f8f8f8; cursor:pointer}
  button:hover{background:#f0f0f0}
  pre{white-space:pre-wrap; word-break:break-word; background:#fafafa; border:1px solid #eee; border-radius:8px; padding:10px; max-height:320px; overflow:auto; margin:8px 0 0 0}
  code{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;}
  .muted{color:#666; font-size:12px}
</style>
</head>
<body>
  <h2>OneDriveCheck – Admin</h2>
  <div class="muted">This page shows the raw JSON of the three endpoints. Use the refresh buttons to re-run.</div>
  <div class="grid" style="margin-top:12px">
    <div class="card">
      <div class="row">
        <strong>Health</strong>
        <button onclick="loadHealth()">Refresh</button>
      </div>
      <pre id="out-health">Loading…</pre>
      <div class="muted"><code>?pin=onedrivecheck&amp;health=1</code></div>
    </div>

    <div class="card">
      <div class="row">
        <strong>Who am I</strong>
        <button onclick="loadWho()">Refresh</button>
      </div>
      <pre id="out-who">Loading…</pre>
      <div class="muted"><code>?pin=onedrivecheck&amp;whoami=1</code></div>
    </div>

    <div class="card">
      <div class="row">
        <strong>List Online (local server)</strong>
        <button onclick="loadOnline()">Refresh</button>
      </div>
      <pre id="out-online">Loading…</pre>
      <div class="muted"><code>?pin=onedrivecheck&amp;listonline=1</code><br>Note: in peering, this only shows agents connected to this server.</div>
    </div>
  </div>

<script>
(function(){
  function j(x){ try{return JSON.stringify(x,null,2);}catch(e){return String(x);} }
  function show(id, data){ document.getElementById(id).textContent = j(data); }

  async function get(qs){
    const u = '/pluginadmin.ashx?pin=onedrivecheck&' + qs;
    try{
      const r = await fetch(u, { credentials:'same-origin' });
      if (!r.ok) return { ok:false, status:r.status };
      return await r.json();
    }catch(e){ return { ok:false, error:String(e) }; }
  }

  window.loadHealth = async function(){ show('out-health', await get('health=1')); };
  window.loadWho    = async function(){ show('out-who',    await get('whoami=1')); };
  window.loadOnline = async function(){ show('out-online', await get('listonline=1')); };

  // initial load
  loadHealth(); loadWho(); loadOnline();
})();
</script>
</body>
</html>`);
        return;
      }

      // nothing matched
      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck admin dashboard loaded");
  return obj;
};
