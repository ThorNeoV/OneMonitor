"use strict";

/** OneDriveCheck – UI via pluginadmin bridge (auth-safe, no express routes) */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // tiny file store for mock status (replace later with real checks if you want)
  const fs = require("fs");
  const path = require("path");
  const statusFile = path.join(__dirname, "statuses.json");
  function readStatuses(){ try{ return JSON.parse(fs.readFileSync(statusFile,"utf8")); }catch{ return {}; } }
  function writeStatuses(v){ try{ fs.writeFileSync(statusFile, JSON.stringify(v||{},null,2)); }catch(e){ err(e); } }
  function hashCode(s){ let h=0; for (let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i); h|=0;} return h; }
  function mockStatusFor(id){
    const h = readStatuses();
    if (!h[id]) {
      const states = [
        { status:"App Online",    port20707:true,  port20773:false },
        { status:"Not signed in", port20707:false, port20773:true  },
        { status:"Offline",       port20707:false, port20773:false }
      ];
      h[id] = states[Math.abs(hashCode(id)) % states.length];
      writeStatuses(h);
    }
    return h[id];
  }

  function summarizeUser(u){
    if (!u) return null;
    const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = u;
    return { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser };
  }

  // -------- ADMIN BRIDGE (authenticated on your setup)
  // URLs:
  //   /pluginadmin.ashx?pin=onedrivecheck&debug=1
  //   /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  //   /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>[&id=...]
  //   /pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js
  obj.handleAdminReq = function(req, res, user) {
    try {
      // serve UI script
      if (req.query.include == 1) {
        const file = String(req.query.path||"").replace(/\\/g,"/").trim();
        if (file !== "ui.js") { res.sendStatus(404); return; }
        res.setHeader("Content-Type","application/javascript; charset=utf-8");
        res.end(buildClientJS());
        return;
      }

      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!req.session, headers: headerBrief(req) });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user:summarizeUser(user) });
        return;
      }

      if (req.query.status == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];
        const out = {};
        ids.forEach((id)=>{ out[id] = mockStatusFor(id); });
        res.json(out);
        return;
      }

      res.sendStatus(404);
    } catch (e) {
      err(e); res.sendStatus(500);
    }
  };

  function headerBrief(req){
    const h = req && req.headers || {};
    const keep = ["host","cookie","user-agent","x-forwarded-for","x-forwarded-proto","x-forwarded-host","cf-ray","cf-visitor","accept"];
    const o = {}; keep.forEach(k=>{ if(h[k]) o[k]=h[k]; });
    o.cookieLength = (h.cookie||"").length;
    return o;
  }

  // Inject our UI
  obj.onWebUIStartupEnd = function () {
    // cache-bust lightly so updates show up
    const t = Date.now() % 100000;
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js&v=${t}"></script>`;
  };

  // ---- client code
  function buildClientJS(){
    return `(function(){
  "use strict";

  // small toolbar badge so you can see it's loaded
  function badge(){
    var bar = document.getElementById('deviceToolbar') || document.querySelector('.DeviceToolbar') || document.querySelector('#Toolbar') || document.querySelector('#devicestoolbar') || document.querySelector('.TopBar');
    if(!bar) return;
    if(document.getElementById('odc-badge')) return;
    var b=document.createElement('span');
    b.id='odc-badge';
    b.textContent='ODC';
    b.style.marginLeft='8px'; b.style.padding='2px 6px'; b.style.border='1px solid #999'; b.style.borderRadius='6px'; b.style.fontWeight='600'; b.style.fontSize='12px';
    bar.appendChild(b);
  }

  function apiStatus(ids){
    var url = '/pluginadmin.ashx?pin=onedrivecheck&status=1' + ids.map(function(id){ return '&id='+encodeURIComponent(id); }).join('');
    return fetch(url, { credentials:'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }

  // ===== Device List =====
  function table(){ return document.querySelector('#devices, #devicesTable'); }
  function rowId(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           row.getAttribute('nodeid') || row.dataset.nodeid || null;
  }
  function addHeader(){
    var g=table(); if(!g) return false;
    var thead=g.querySelector('thead'); if(!thead) return false;
    var tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById('col_onedrivecheck')){
      var th=document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDriveCheck'; tr.appendChild(th);
    }
    return true;
  }
  function ensureCells(){
    var g=table(); if(!g) return [];
    var rows=g.querySelectorAll('tbody tr'); var ids=[];
    rows.forEach(function(r){
      if(!r.querySelector('.onedrivecheck-cell')){
        var td=document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—'; r.appendChild(td);
      }
      var id=rowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function paintList(map){
    var g=table(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(function(r){
      var id=rowId(r); var td=r.querySelector('.onedrivecheck-cell'); if(!td) return;
      var s=(id && map && map[id])?map[id]:null;
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; td.style.color=''; return; }
      td.textContent = s.status || '—';
      td.title = '20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed');
      var state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
      td.dataset.state = state;
      td.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
      td.style.fontWeight = '600';
    });
  }
  function tickList(){
    if(!addHeader()) return;
    var ids=ensureCells(); if(ids.length===0) return;
    apiStatus(ids).then(paintList);
  }

  // ===== Device Page =====
  function currentNodeId(){
    var e=document.querySelector('[data-nodeid], #deviceInfo');
    if(e && e.dataset && e.dataset.nodeid) return e.dataset.nodeid;
    var h=location.hash||''; var m=h.match(/nodeid=([^&]+)/i); return m?decodeURIComponent(m[1]):null;
  }
  function ensureDevicePill(){
    var host=document.querySelector('#p11, #p1, #deviceInfo, .DeviceInfo, #deviceSummary, .General') || document.querySelector('#p10');
    if(!host) return null;
    var id='onedrivecheck-pill';
    var pill=document.getElementById(id);
    if(!pill){
      pill=document.createElement('div'); pill.id=id;
      pill.style.marginTop='6px'; pill.style.fontWeight='600';
      host.appendChild(pill);
    }
    return pill;
  }
  function paintDevice(map){
    var id=currentNodeId(); if(!id) return;
    var s=map[id]; var pill=ensureDevicePill(); if(!pill) return;
    if(!s){ pill.textContent='OneDriveCheck: —'; pill.style.color='#666'; return; }
    var state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
    pill.textContent='OneDriveCheck: ' + (s.status||'—') + '  (20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed')+')';
    pill.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
  }
  function tickDevice(){
    var id=currentNodeId(); if(!id) return;
    apiStatus([id]).then(paintDevice);
  }

  // events + gentle polling
  document.addEventListener('meshcentralDeviceListRefreshEnd', function(){ setTimeout(tickList, 200); });
  document.addEventListener('meshcentralDeviceRefreshEnd', function(){ setTimeout(tickDevice, 200); });

  // first run + keep-alive
  setTimeout(function(){ badge(); tickList(); tickDevice(); }, 600);
  setInterval(function(){
    badge();
    if (table() && !document.getElementById('col_onedrivecheck')) tickList();
  }, 5000);
})();`;
  }

  log("onedrivecheck loaded (pluginadmin-only UI)");
  return obj;
};
