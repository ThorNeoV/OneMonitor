"use strict";

/**
 * OneDriveCheck — minimal, UI-only plugin
 * - Injects a column in My Devices
 * - Adds a badge on each Device page (General section)
 * - Uses pluginadmin.ashx bridge for a simple status API:
 *    /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>[&id=<nodeId>...]
 *
 * Status colours:
 *   - Green  = port 20707 open (app online)
 *   - Amber  = only 20773 open (not signed in)
 *   - Red    = both closed (offline)
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // ----- tiny log helpers (prefer Mesh logger)
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ----- inject our client script into the Mesh UI
  obj.onWebUIStartupEnd = function () {
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js"></script>`;
  };

  // ----- pluginadmin.ashx bridge handler
  // Called at: /pluginadmin.ashx?pin=onedrivecheck&...
  obj.handleAdminReq = function (req, res, user) {
    // 1) Serve our client JS
    if (req.query.include == 1) {
      const file = (req.query.path || "").split("/").pop();
      if (file !== "ui.js") { res.sendStatus(404); return; }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(clientJS());
      return;
    }

    // 2) JSON status API
    if (req.query.status == 1) {
      if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }

      const testPort = (nodeId, port) => new Promise((resolve)=>{
        const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Test-NetConnection -ComputerName localhost -Port ${port}).TcpTestSucceeded"`;
        try {
          obj.meshServer.sendCommand(nodeId, "shell", { cmd, type: "powershell" }, (resp)=>{
            const out = (resp && resp.data) ? String(resp.data) : "";
            resolve(/true/i.test(out));
          });
        } catch (e) {
          err(e);
          resolve(false);
        }
      });

      (async ()=>{
        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];

        const out = {};
        for (const id of ids) {
          try {
            const p20707 = await testPort(id, 20707);
            const p20773 = await testPort(id, 20773);
            out[id] = { p20707, p20773 };
          } catch (e) {
            err(e);
            out[id] = { error: "check_failed" };
          }
        }
        res.json(out);
      })();
      return;
    }

    // Not our request
    res.sendStatus(401);
  };

  // ----- client JS (injected into UI)
  function clientJS(){ return String.raw`(function(){
  // Helpers
  function q(sel, root){return (root||document).querySelector(sel);}
  function qa(sel, root){return Array.from((root||document).querySelectorAll(sel));}
  function getNodeIdFromRow(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           row.getAttribute('nodeid') || row.dataset.nodeid || null;
  }
  function fetchStatus(ids){
    if(!ids || !ids.length) return Promise.resolve({});
    var url = '/pluginadmin.ashx?pin=onedrivecheck&status=1&' + ids.map(i=>'id='+encodeURIComponent(i)).join('&');
    return fetch(url, { credentials:'same-origin' }).then(r=>r.json()).catch(()=>({}));
  }
  function colorFor(s){
    if(!s) return '';
    if(s.p20707) return 'var(--good, #28a745)';    // green
    if(s.p20773) return 'var(--warn, #ff9800)';    // amber
    return 'var(--bad, #dc3545)';                  // red
  }
  function labelFor(s){
    if(!s) return '—';
    if(s.p20707) return 'Online';
    if(s.p20773) return 'Not signed in';
    return 'Offline';
  }

  // ===== My Devices list =====
  function ensureListColumn(){
    var table = q('#devices, #devicesTable'); if(!table) return false;
    var thead = q('thead', table); if(!thead) return false;
    var tr = q('tr', thead); if(!tr) return false;
    if(!q('#col_onedrivecheck', tr)){
      var th = document.createElement('th');
      th.id = 'col_onedrivecheck';
      th.textContent = 'OneDrive';
      tr.appendChild(th);
    }
    return true;
  }
  function collectListRows(){
    var table = q('#devices, #devicesTable'); if(!table) return {rows:[], ids:[]};
    var rows = qa('tbody tr', table);
    var ids = [];
    rows.forEach(function(r){
      if(!q('.onedrivecheck-cell', r)){
        var td=document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—'; r.appendChild(td);
      }
      var id=getNodeIdFromRow(r); if(id) ids.push(id);
    });
    return {rows: rows, ids: ids};
  }
  function paintList(map){
    var table = q('#devices, #devicesTable'); if(!table) return;
    qa('tbody tr', table).forEach(function(r){
      var id=getNodeIdFromRow(r);
      var td=q('.onedrivecheck-cell', r); if(!td) return;
      var s=(id && map)?map[id]:null;
      td.textContent = labelFor(s);
      td.style.color = colorFor(s);
      td.title = s ? ('20707:'+(s.p20707?'open':'closed')+'; 20773:'+(s.p20773?'open':'closed')) : '';
    });
  }
  function tickList(){
    if(!ensureListColumn()) return;
    var col = collectListRows();
    if(col.ids.length===0) return;
    fetchStatus(col.ids).then(paintList);
  }

  // ===== Device page =====
  function getCurrentNodeIdFromDevicePage(){
    try { if (window.currentNode && currentNode._id) return currentNode._id; } catch(e){}
    var el = q('[nodeid],[data-nodeid]');
    return el ? (el.getAttribute('nodeid') || el.dataset.nodeid) : null;
  }
  function ensureDeviceBadge(){
    var general = q('#p9info, #p10info, #p11info, #p12info') || q('#pDetails') || q('#DeviceInformation');
    if(!general) return null;
    if(q('#onedrivecheck-badge', general)) return q('#onedrivecheck-badge', general);
    var row = document.createElement('div');
    row.id = 'onedrivecheck-badge';
    row.style.margin = '6px 0';
    row.innerHTML = '<b>OneDrive:</b> <span id="onedrivecheck-badge-val">—</span>';
    general.appendChild(row);
    return row;
  }
  function tickDevice(){
    var nodeId = getCurrentNodeIdFromDevicePage();
    if(!nodeId) return;
    ensureDeviceBadge();
    fetchStatus([nodeId]).then(function(map){
      var s = map[nodeId];
      var span = q('#onedrivecheck-badge-val');
      if(span){
        span.textContent = labelFor(s);
        span.style.color = colorFor(s);
        span.title = s ? ('20707:'+(s.p20707?'open':'closed')+'; 20773:'+(s.p20773?'open':'closed')) : '';
      }
    });
  }

  // Mesh UI refresh hooks
  document.addEventListener('meshcentralDeviceListRefreshEnd', tickList);
  document.addEventListener('meshcentralDeviceRefresh', tickDevice);

  // First boots / resilience
  setInterval(function(){
    if(q('#devices, #devicesTable') && !q('#col_onedrivecheck')) tickList();
  }, 4000);
  setTimeout(function(){ tickList(); tickDevice(); }, 800);
})();`; }

  // no other hooks needed
  return obj;
};
