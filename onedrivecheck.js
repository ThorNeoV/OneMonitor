"use strict";

/** OneDriveCheck (UI-only, safe)
 * shortName: onedrivecheck
 * - Keeps pluginadmin.ashx pages working (admin/user/debug)
 * - Adds /plugin/onedrivecheck/status and /plugin/onedrivecheck/ui.js
 * - Injects a DOM script to show a green/grey dot per device (agent online/offline)
 */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // ---------- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ---------- helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p)=> baseNoSlash + p;
  const isSiteAdmin = (user)=> !!user && ((user.siteadmin|0) & 0xFFFFFFFF) !== 0;

  // ========================================================================
  //  A) pluginadmin.ashx bridge (always available, proves auth/session)
  //     Examples (while logged in):
  //       /pluginadmin.ashx?pin=onedrivecheck&debug=1
  //       /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  //       /pluginadmin.ashx?pin=onedrivecheck&admin=1
  // ========================================================================
  obj.handleAdminReq = function(req, res, user) {
    try {
      if (req.query.debug == 1) {
        res.json({
          ok: true,
          via: "handleAdminReq",
          webRoot,
          hasUser: !!user,
          userSummary: user ? { name:user.name, userid:user.userid, domain:user.domain, siteadmin:user.siteadmin } : null
        });
        return;
      }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = user;
        res.json({ ok:true, user:{ name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
        return;
      }
      if (req.query.admin == 1) {
        if (!isSiteAdmin(user)) { res.sendStatus(401); return; }
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck – Admin</title></head>
<body style="font-family:sans-serif;padding:20px;max-width:860px">
  <h2>OneDriveCheck – Admin</h2>
  <p>Plugin installed. Your session is readable.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug JSON</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
  </ul>
  <p>UI injection adds a column to My Devices and a badge on device pages.</p>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }
      if (req.query.user == 1) {
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck</title></head>
<body style="font-family:sans-serif;padding:20px;max-width:860px">
  <h2>OneDriveCheck</h2>
  <p>Logged-in user page.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug JSON</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
  </ul>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }
      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // ========================================================================
  //  B) Express endpoints: /plugin/onedrivecheck/*
  // ========================================================================
  function attachExpress(app){
    // Basic debug
    app.get(R("/plugin/onedrivecheck/debug"), function(req,res){
      const u = req.user || null;
      res.json({
        ok: true,
        via: "express",
        webRoot,
        hasUser: !!u,
        userSummary: u ? { name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin } : null
      });
    });

    // Status: returns { "<nodeId>": { online: true|false } }
    app.get(R("/plugin/onedrivecheck/status"), function(req,res){
      try {
        // Must be authenticated (any logged-in user can read)
        if (!req.user) { res.status(401).json({ ok:false, reason:"no user" }); return; }

        // Accept id=... or repeated id=...&id=...
        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];

        const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
        const out = {};
        for (const id of ids) {
          out[id] = { online: !!wsagents[id] };
        }
        res.json(out);
      } catch (e) {
        err(e);
        res.status(500).json({});
      }
    });

    // The UI script we inject (heavily guarded, won’t break SPA if it fails)
    app.get(R("/plugin/onedrivecheck/ui.js"), function(req,res){
      const js = `(function(){
  "use strict";
  try {
    var BASE = ${JSON.stringify(webRoot.endsWith("/") ? webRoot : (webRoot + "/"))};
    var STATUS_URL = BASE + "plugin/onedrivecheck/status";

    function q(sel, root){ return (root||document).querySelector(sel); }
    function qa(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }

    function getRowNodeId(row){
      if (!row) return null;
      return row.getAttribute('deviceid') || row.dataset.deviceid ||
             (row.id && row.id.indexOf('d_')===0 ? row.id.substring(2) : null) ||
             row.getAttribute('nodeid') || row.dataset.nodeid || null;
    }

    // ---------- Devices list page ----------
    function addListHeader(){
      var table = q('#devices, #devicesTable');
      if (!table) return false;
      var thead = table.querySelector('thead');
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

    function ensureListCells(){
      var table = q('#devices, #devicesTable');
      if (!table) return [];
      var rows = qa('tbody tr', table), ids = [];
      rows.forEach(function(r){
        if (!r.querySelector('.onedrivecheck-cell')){
          var td = document.createElement('td');
          td.className = 'onedrivecheck-cell';
          td.textContent = '—';
          td.style.whiteSpace = 'nowrap';
          r.appendChild(td);
        }
        var id = getRowNodeId(r);
        if (id) ids.push(id);
      });
      return ids;
    }

    function paintList(map){
      var table = q('#devices, #devicesTable');
      if (!table) return;
      qa('tbody tr', table).forEach(function(r){
        var id = getRowNodeId(r);
        var td = r.querySelector('.onedrivecheck-cell');
        if (!td) return;
        var s = (id && map && map[id]) ? map[id] : null;

        // dot
        var dot = document.createElement('span');
        dot.style.display = 'inline-block';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.marginRight = '6px';
        dot.style.verticalAlign = 'middle';
        dot.style.background = (s && s.online) ? '#2ecc71' : '#bdc3c7';

        td.textContent = '';
        td.appendChild(dot);
        td.appendChild(document.createTextNode((s && s.online) ? 'Online' : 'Offline'));
        td.dataset.state = (s && s.online) ? 'online' : 'offline';
      });
    }

    function loadStatus(ids){
      if (!ids || !ids.length) return Promise.resolve({});
      var url = STATUS_URL + '?' + ids.map(function(id){ return 'id=' + encodeURIComponent(id); }).join('&');
      return fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
    }

    function tickList(){
      if (!addListHeader()) return;
      var ids = ensureListCells();
      loadStatus(ids).then(paintList);
    }

    // ---------- Single device page ----------
    function currentNodeId(){
      // Mesh often sets #deviceId or data-nodeid on main panel; try several options
      var el = q('#deviceId') || q('#deviceSummary') || q('[data-nodeid]');
      if (el){
        return el.getAttribute('data-nodeid') || el.getAttribute('nodeid') || el.textContent || null;
      }
      // Fallback: some rows mirror selected device
      var row = q('tr[selected], tr.current, tr.active');
      return getRowNodeId(row);
    }

    function paintDeviceBadge(state){
      var header = q('#DeviceHeader, #devDetailHeader, .deviceHeader, #MainTitle, h1, h2');
      if (!header) return;
      var old = q('#onedrivecheck-badge', header);
      if (old) old.remove();

      var badge = document.createElement('span');
      badge.id = 'onedrivecheck-badge';
      badge.style.display = 'inline-flex';
      badge.style.alignItems = 'center';
      badge.style.marginLeft = '10px';
      badge.style.fontSize = '0.9em';

      var dot = document.createElement('span');
      dot.style.display = 'inline-block';
      dot.style.width = '10px';
      dot.style.height = '10px';
      dot.style.borderRadius = '50%';
      dot.style.marginRight = '6px';
      dot.style.verticalAlign = 'middle';
      dot.style.background = state ? '#2ecc71' : '#bdc3c7';

      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(state ? 'OneDriveCheck: Online' : 'OneDriveCheck: Offline'));
      header.appendChild(badge);
    }

    function tickDevice(){
      var id = currentNodeId();
      if (!id) return;
      loadStatus([id]).then(function(map){
        var s = map[id];
        paintDeviceBadge(!!(s && s.online));
      });
    }

    // ---------- Wire up
    function safeTick(){
      try { tickList(); } catch(e){}
      try { tickDevice(); } catch(e){}
    }

    // Mesh fires custom events; also re-run periodically to be safe.
    document.addEventListener('meshcentralDeviceListRefreshEnd', function(){ setTimeout(safeTick, 100); });
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(safeTick, 400); });
    setInterval(safeTick, 4000);
  } catch(e) { /* never break the UI */ }
})();`;
      res.setHeader("Content-Type","application/javascript; charset=utf-8");
      res.end(js);
    });

    log("express routes mounted at /plugin/onedrivecheck/* (webRoot=" + webRoot + ")");
  }

  // Mesh calls this after it wires cookie-session/auth
  obj.hook_setupHttpHandlers = function(appOrWeb/*, express */){
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);
    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try { attachExpress(app); } catch(e){ err(e); }
  };

  // Inject our UI script safely
  obj.onWebUIStartupEnd = function () {
    const base = webRoot.endsWith("/") ? webRoot : (webRoot + "/");
    // Keep it simple: one small script tag. The script itself is fully guarded.
    return `<script src="${base}plugin/onedrivecheck/ui.js"></script>`;
  };

  return obj;
};
