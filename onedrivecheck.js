"use strict";

/** OneDriveCheck – UI via pluginadmin bridge (auth-safe, LIVE status) */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ----- helpers
  function summarizeUser(u){
    if (!u) return null;
    const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = u;
    return { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser };
  }
  function briefHeaders(req){
    const h = (req && req.headers) || {};
    const keep = ["host","user-agent","x-forwarded-for","x-forwarded-proto","x-forwarded-host","cf-ray","accept"];
    const o = {}; keep.forEach(k=>{ if(h[k]) o[k]=h[k]; });
    o.cookieLength = (h.cookie||"").length;
    return o;
  }

  // ===== LIVE STATUS CHECKS =====
  const CACHE_TTL_MS = 15000; // 15s
  const cache = new Map(); // nodeId -> { t:number, val:{status,port20707,port20773} }

  function isAgentOnline(nodeId){
    try {
      const a = obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
      return !!(a && a[nodeId]);
    } catch { return false; }
  }

  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      const payload = { cmd, type: "powershell" };
      let done = false;
      const timer = setTimeout(()=>{ if(!done){ done=true; resolve(""); } }, 6000); // 6s timeout
      try {
        obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp){
          if (done) return;
          done = true; clearTimeout(timer);
          resolve(resp && resp.data ? String(resp.data) : "");
        });
      } catch(e){
        if (done) return;
        done = true; clearTimeout(timer);
        resolve("");
      }
    });
  }

  function parseBool(s){ return /true/i.test(String(s||"")); }

  async function checkNodeLive(nodeId){
    // If agent is offline, report Offline straight away
    if (!isAgentOnline(nodeId)) {
      return { status:"Offline", port20707:false, port20773:false };
    }

    // Single PowerShell to test two ports and print simple CSV: "p1=true;p2=false"
    const ps = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
      "\"$p1=(Test-NetConnection -ComputerName localhost -Port 20707 -WarningAction SilentlyContinue).TcpTestSucceeded; " +
      "$p2=(Test-NetConnection -ComputerName localhost -Port 20773 -WarningAction SilentlyContinue).TcpTestSucceeded; " +
      "Write-Output ('p1=' + $p1 + ';p2=' + $p2)\"";

    const out = await sendShell(nodeId, ps);
    const m = /p1\s*=\s*(true|false).*?p2\s*=\s*(true|false)/i.exec(out||"");
    const p1 = m ? parseBool(m[1]) : false;
    const p2 = m ? parseBool(m[2]) : false;

    const status = p1 ? "App Online" : (p2 ? "Not signed in" : "Offline");
    return { status, port20707: !!p1, port20773: !!p2 };
  }

  async function getStatusFor(nodeId){
    // cache
    const now = Date.now();
    const c = cache.get(nodeId);
    if (c && (now - c.t) < CACHE_TTL_MS) return c.val;

    const val = await checkNodeLive(nodeId);
    cache.set(nodeId, { t: now, val });
    return val;
  }

  // ========== AUTHENTICATED BRIDGE ==========
  // /pluginadmin.ashx?pin=onedrivecheck&debug=1
  // /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  // /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>[&id=...]
  // /pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js
  obj.handleAdminReq = async function(req, res, user) {
    try {
      // include UI
      if (req.query.include == 1) {
        const file = String(req.query.path||"").replace(/\\/g,"/").trim();
        if (file !== "ui.js") { res.sendStatus(404); return; }
        res.setHeader("Content-Type","application/javascript; charset=utf-8");
        res.end(buildClientJS());
        return;
      }

      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session), headers: briefHeaders(req) });
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
        // limit concurrency a bit
        const queue = ids.slice();
        const MAX_PAR = 5;
        async function worker(){
          while(queue.length){
            const id = queue.shift();
            try { out[id] = await getStatusFor(id); }
            catch(e){ err(e); out[id] = { status:"Offline", port20707:false, port20773:false }; }
          }
        }
        const workers = Array.from({length: Math.min(MAX_PAR, ids.length)}, worker);
        await Promise.all(workers);

        res.json(out);
        return;
      }

      res.sendStatus(404);
    } catch (e) {
      err(e); res.sendStatus(500);
    }
  };

  // Inject UI script everywhere
  obj.onWebUIStartupEnd = function () {
    const v = (Date.now() % 1e6);
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js&v=${v}"></script>`;
  };

  // --------- Client JS (column + device pill; robust selectors/observers)
  function buildClientJS(){
    return `(function(){
  "use strict";

  function badge(){
    var bar = document.getElementById('deviceToolbar') ||
              document.querySelector('.DeviceToolbar') ||
              document.querySelector('#Toolbar') ||
              document.querySelector('#devicestoolbar') ||
              document.querySelector('.TopBar');
    if(!bar || document.getElementById('odc-badge')) return;
    var b=document.createElement('span');
    b.id='odc-badge';
    b.textContent='ODC';
    b.style.marginLeft='8px'; b.style.padding='2px 6px';
    b.style.border='1px solid #999'; b.style.borderRadius='6px';
    b.style.fontWeight='600'; b.style.fontSize='12px';
    bar.appendChild(b);
  }

  function apiStatus(ids){
    var url = '/pluginadmin.ashx?pin=onedrivecheck&status=1' + ids.map(function(id){ return '&id='+encodeURIComponent(id); }).join('');
    return fetch(url, { credentials:'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }

  // ===== Device List =====
  function table(){
    return document.querySelector('#devices') ||
           document.querySelector('#devicesTable') ||
           document.querySelector('table#devicetable') ||
           document.querySelector('table[data-list="devices"]');
  }
  function rowId(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           row.getAttribute('nodeid')   || row.dataset.nodeid   ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           null;
  }
  function addHeader(){
    var g=table(); if(!g) return false;
    var thead=g.querySelector('thead'); if(!thead) return false;
    var tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById('col_onedrivecheck')){
      var th=document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDriveCheck';
      th.style.whiteSpace='nowrap';
      tr.appendChild(th);
    }
    return true;
  }
  function ensureCells(){
    var g=table(); if(!g) return [];
    var tbody=g.querySelector('tbody'); if(!tbody) return [];
    var rows=tbody.querySelectorAll('tr'); var ids=[];
    rows.forEach(function(r){
      if(!r.querySelector('.onedrivecheck-cell')){
        var td=document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—';
        td.style.whiteSpace='nowrap';
        r.appendChild(td);
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
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; td.style.color=''; td.style.fontWeight=''; return; }
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
    var explicit = document.querySelector('[data-nodeid]'); if (explicit && explicit.dataset.nodeid) return explicit.dataset.nodeid;
    var info = document.getElementById('deviceInfo'); if(info && info.dataset && info.dataset.nodeid) return info.dataset.nodeid;
    var h=location.hash||''; var m=h.match(/nodeid=([^&]+)/i); return m?decodeURIComponent(m[1]):null;
  }
  function ensureDevicePill(){
    var host = document.querySelector('#p11') || document.querySelector('#p1') ||
               document.getElementById('deviceInfo') || document.querySelector('.DeviceInfo') ||
               document.getElementById('deviceSummary') || document.querySelector('.General') ||
               document.querySelector('#p10');
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

  function onNav(){ setTimeout(function(){ badge(); tickList(); tickDevice(); }, 250); }
  window.addEventListener('hashchange', onNav);

  document.addEventListener('DOMContentLoaded', function(){
    onNav();
    var root = document.getElementById('Content') || document.body;
    try {
      var mo = new MutationObserver(function(){ tickList(); });
      mo.observe(root, { childList:true, subtree:true });
    } catch (e) {}
  });

  setInterval(function(){
    badge();
    if (table() && !document.getElementById('col_onedrivecheck')) tickList();
    tickDevice();
  }, 6000);
})();`;
  }

  log("onedrivecheck loaded (pluginadmin-only UI; LIVE checks with caching)");
  return obj;
};
