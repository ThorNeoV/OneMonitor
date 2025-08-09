"use strict";

/** OneDriveCheck – LIVE status + debug UI loader */
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
  const CACHE_TTL_MS = 15000;
  const cache = new Map(); // nodeId -> { t, val }

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
      const timer = setTimeout(()=>{ if(!done){ done=true; resolve(""); } }, 6000);
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
    if (!isAgentOnline(nodeId)) return { status:"Offline", port20707:false, port20773:false };

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
    const now = Date.now();
    const c = cache.get(nodeId);
    if (c && (now - c.t) < CACHE_TTL_MS) return c.val;
    const val = await checkNodeLive(nodeId);
    cache.set(nodeId, { t: now, val });
    return val;
  }

  // ========== AUTH BRIDGE ==========
  // /pluginadmin.ashx?pin=onedrivecheck&debug=1
  // /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  // /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>[&id=...]
  // /pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js
  obj.handleAdminReq = async function(req, res, user) {
    try {
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
        const queue = ids.slice();
        const MAX_PAR = 5;
        async function worker(){
          while(queue.length){
            const id = queue.shift();
            try { out[id] = await getStatusFor(id); }
            catch(e){ err(e); out[id] = { status:"Offline", port20707:false, port20773:false }; }
          }
        }
        await Promise.all(Array.from({length: Math.min(MAX_PAR, ids.length)}, worker));
        res.json(out);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // Inject UI script everywhere (cache-busted)
  obj.onWebUIStartupEnd = function () {
    const v = (Date.now() % 1e6);
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js&v=${v}"></script>`;
  };

  // --------- Client JS with DEBUG beacons
  function buildClientJS(){
    return `(()=>{"use strict";
  const DBG=(...a)=>{ try{ console.log("%c[ODC]", "color:#06c;font-weight:700", ...a);}catch{} };
  DBG("ui boot");

  // Always paint a tiny floating chip so we know the script loaded
  function chip(){
    if(document.getElementById("odc-chip")) return;
    const d=document.createElement("div");
    d.id="odc-chip";
    d.textContent="ODC running";
    Object.assign(d.style,{
      position:"fixed", right:"10px", bottom:"10px", padding:"2px 6px",
      background:"#eef", border:"1px solid #99c", borderRadius:"8px",
      fontSize:"12px", fontWeight:"600", zIndex:"2147483647"
    });
    document.body.appendChild(d);
  }

  function apiStatus(ids){
    const url = '/pluginadmin.ashx?pin=onedrivecheck&status=1' + ids.map(id=>'&id='+encodeURIComponent(id)).join('');
    return fetch(url, { credentials:'same-origin' })
      .then(r=>r.json()).catch(()=>({}));
  }

  // ===== Device List =====
  function table(){
    return document.querySelector('#devices') ||
           document.querySelector('#devicesTable') ||
           document.querySelector('table#devicetable') ||
           document.querySelector('table[data-list="devices"]') ||
           document.querySelector('table');
  }
  function rowId(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           row.getAttribute('nodeid')   || row.dataset.nodeid   ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           null;
  }
  function addHeader(){
    const g=table(); if(!g) return false;
    const thead=g.querySelector('thead'); if(!thead) return false;
    const tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById('col_onedrivecheck')){
      const th=document.createElement('th'); th.id='col_onedrivecheck'; th.textContent='OneDriveCheck';
      th.style.whiteSpace='nowrap';
      tr.appendChild(th);
      DBG("added header");
    }
    return true;
  }
  function ensureCells(){
    const g=table(); if(!g) return [];
    const tbody=g.querySelector('tbody'); if(!tbody) return [];
    const rows=tbody.querySelectorAll('tr'); const ids=[];
    rows.forEach(r=>{
      if(!r.querySelector('.onedrivecheck-cell')){
        const td=document.createElement('td'); td.className='onedrivecheck-cell'; td.textContent='—';
        td.style.whiteSpace='nowrap';
        r.appendChild(td);
      }
      const id=rowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function paintList(map){
    const g=table(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(r=>{
      const id=rowId(r); const td=r.querySelector('.onedrivecheck-cell'); if(!td) return;
      const s=(id && map && map[id])?map[id]:null;
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; td.style.color=''; td.style.fontWeight=''; return; }
      td.textContent = s.status || '—';
      td.title = '20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed');
      const state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
      td.dataset.state = state;
      td.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
      td.style.fontWeight = '600';
    });
  }
  function tickList(){
    if(!addHeader()) return;
    const ids=ensureCells(); if(ids.length===0) return;
    DBG("list ids", ids.length);
    apiStatus(ids).then(paintList);
  }

  // ===== Device Page =====
  function currentNodeId(){
    const explicit = document.querySelector('[data-nodeid]'); if (explicit && explicit.dataset.nodeid) return explicit.dataset.nodeid;
    const info = document.getElementById('deviceInfo'); if(info && info.dataset && info.dataset.nodeid) return info.dataset.nodeid;
    const h=location.hash||''; const m=h.match(/nodeid=([^&]+)/i); return m?decodeURIComponent(m[1]):null;
  }
  function ensureDevicePill(){
    const host = document.querySelector('#p11') || document.querySelector('#p1') ||
                 document.getElementById('deviceInfo') || document.querySelector('.DeviceInfo') ||
                 document.getElementById('deviceSummary') || document.querySelector('.General') ||
                 document.querySelector('#p10') || document.querySelector('#p00');
    if(!host) return null;
    const id='onedrivecheck-pill';
    let pill=document.getElementById(id);
    if(!pill){
      pill=document.createElement('div'); pill.id=id;
      pill.style.marginTop='6px'; pill.style.fontWeight='600';
      host.appendChild(pill);
      DBG("added device pill");
    }
    return pill;
  }
  function paintDevice(map){
    const id=currentNodeId(); if(!id) return;
    const s=map[id]; const pill=ensureDevicePill(); if(!pill) return;
    if(!s){ pill.textContent='OneDriveCheck: —'; pill.style.color='#666'; return; }
    const state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
    pill.textContent='OneDriveCheck: ' + (s.status||'—') + '  (20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed')+')';
    pill.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
  }
  function tickDevice(){
    const id=currentNodeId(); if(!id) return;
    DBG("device id", id);
    apiStatus([id]).then(paintDevice);
  }

  function onNav(){ setTimeout(()=>{ chip(); tickList(); tickDevice(); }, 250); }
  window.addEventListener('hashchange', onNav);

  document.addEventListener('DOMContentLoaded', function(){
    DBG("dom ready");
    chip(); onNav();
    const root = document.getElementById('Content') || document.body;
    try {
      const mo = new MutationObserver(()=>{ tickList(); });
      mo.observe(root, { childList:true, subtree:true });
      DBG("observer attached");
    } catch (e) { DBG("observer error", e); }
  });

  setInterval(function(){
    chip();
    if (table() && !document.getElementById('col_onedrivecheck')) tickList();
    tickDevice();
  }, 6000);
})();`;
  }

  log("onedrivecheck loaded (debug UI)");
  return obj;
};
