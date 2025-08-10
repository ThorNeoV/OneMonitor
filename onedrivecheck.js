"use strict";

/**
 * OneDriveCheck – single-file, safe UI column + device pill
 * - Admin bridge endpoints (while logged in):
 *    • /pluginadmin.ashx?pin=onedrivecheck&debug=1
 *    • /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *    • /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *    • /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<shortOrLongId>[&id=...]   (returns Running/Stopped/Offline/Unknown)
 *    • /pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js                   (UI injector)
 *
 * - UI adds a “OneDriveCheck” column on device list + a pill on device page.
 * - Peering-safe runcommands with reply:true; replies handled in hook_processAgentData.
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer.webserver;

  // Mesh sometimes only calls hooks listed in exports:
  obj.exports = ["handleAdminReq", "hook_processAgentData", "onWebUIStartupEnd"];

  // ---- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ---- constants
  const SERVICE_NAME = 'OneDriveCheckService';
  const CACHE_TTL_MS = 15000; // per-node cache to avoid spamming runcommands

  // ---- helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v)=> /^true$/i.test(String(v).trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));

  function isAgentOnline(nodeId){
    try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]); } catch { return false; }
  }

  function listOnline() {
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const k of Object.keys(a)) {
      try {
        const n = a[k].dbNode || a[k].dbNodeKey || null;
        out[k] = { key:k, name:(n && (n.name||n.computername))||null, os:(n && (n.osdesc||n.agentcaps))||null };
      } catch { out[k] = { key:k }; }
    }
    return out;
  }

  // ---- pending replies (responseid -> {resolve,reject,timeout})
  const pend = new Map();
  function makeResponseId(){ return 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // Handle agent replies for runcommands
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (p) {
          pend.delete(command.responseid);
          clearTimeout(p.timeout);
          const raw = (command.console || command.result || '').toString();
          p.resolve({ ok:true, raw });
        }
      }
    } catch (e) { err(e); }
  };

  function runCommandsAndWait(nodeId, type, lines, runAsUser){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                               // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,             // false => run as agent (service)
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) { pend.delete(responseid); }
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      // Local
      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
        return;
      }

      // Peers
      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }

      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  // ---- cache: nodeId -> { t, result }
  const cache = new Map();

  // FAST check first: netstat for ports (very quick + non-admin).
  // If that yields both closed, try SC query for service status to disambiguate.
  async function probeNode(nodeId){
    // cache
    const now = Date.now();
    const c = cache.get(nodeId);
    if (c && (now - c.t) < CACHE_TTL_MS) return c.result;

    // 1) quick ports via CMD
    const netstatLine =
      '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & ' +
      '(netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)';
    const r1 = await runCommandsAndWait(nodeId, 'bat', netstatLine, false);
    const raw1 = (r1 && r1.raw) ? String(r1.raw) : '';
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw1);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw1);
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;

    let result;
    if (!r1 || r1.ok !== true) {
      // Could not run commands (peering gap, perms, etc.)
      result = { status:'Unknown', port20707:false, port20773:false };
    } else if (p1) {
      result = { status:'Running', port20707:true,  port20773:p2 };
    } else if (p2) {
      // OneDrive app “not signed in” state we used earlier maps to listening on 20773
      result = { status:'Running (No Sign-In)', port20707:false, port20773:true };
    } else {
      // 2) fall back to SC query to check service state (fast, still cmd)
      const scLine = `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=Stopped`;
      const r2 = await runCommandsAndWait(nodeId, 'bat', scLine, false);
      const raw2 = (r2 && r2.raw) ? String(r2.raw) : '';
      const ms = /svc\s*=\s*(Running|Stopped)/i.exec(raw2);
      if (r2 && r2.ok === true && ms) {
        const svcRunning = /Running/i.test(ms[1]);
        result = { status: (svcRunning ? 'Running' : 'Stopped'), port20707:false, port20773:false };
      } else {
        result = { status:'Unknown', port20707:false, port20773:false };
      }
    }

    const wrapped = result;
    cache.set(nodeId, { t: now, result: wrapped });
    return wrapped;
  }

  // ===== Admin bridge endpoints =====
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (req.query.include == 1) {
        const file = String(req.query.path||"").replace(/\\/g,"/").trim();
        if (file !== 'ui.js') { res.sendStatus(404); return; }
        res.setHeader('Content-Type','application/javascript; charset=utf-8');
        res.end(buildClientJS());
        return;
      }

      if (req.query.debug == 1) { res.json({ ok:true, hasUser:!!user, user:summarizeUser(user) }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:'no user' }); return; }
        res.json({ ok:true, user:summarizeUser(user) }); return;
      }
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.json({ ok:true, agents:listOnline() }); return;
      }

      if (req.query.status == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        let ids = req.query.id; if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];
        ids = ids.map(normalizeId);

        const out = {};
        const queue = ids.slice();
        const MAX_PAR = 6;
        async function worker(){
          while(queue.length){
            const id = queue.shift();
            try {
              if (!isAgentOnline(id)) { out[id] = { status:'Offline', port20707:false, port20773:false }; continue; }
              out[id] = await probeNode(id);
            } catch (e) { err(e); out[id] = { status:'Unknown', port20707:false, port20773:false }; }
          }
        }
        await Promise.all(Array.from({length: Math.min(MAX_PAR, ids.length)}, worker));
        res.json(out);
        return;
      }

      // tiny landing page (optional)
      if (req.query.admin == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(`<!doctype html><meta charset="utf-8"><title>OneDriveCheck</title>
          <h2>OneDriveCheck</h2>
          <p>Column appears on the device list; a pill appears on the device page.</p>
          <ul>
            <li><a href="?pin=onedrivecheck&debug=1">debug</a></li>
            <li><a href="?pin=onedrivecheck&listonline=1">listonline</a></li>
          </ul>`);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // Inject UI (CSP-safe, served by admin bridge)
  obj.onWebUIStartupEnd = function () {
    const v = (Date.now() % 1e6);
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js&v=${v}"></script>`;
  };

  // ====== Client JS (column + pill; no raw output shown) ======
  function buildClientJS(){
    return `(()=>{"use strict";
  const tidy = s => (s||"").trim();

  // Resolve device list table across skins
  function table(){
    return document.querySelector('#devices')
        || document.querySelector('#devicesTable')
        || document.querySelector('table#devicetable')
        || document.querySelector('table[data-list="devices"]')
        || null;
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
        td.style.whiteSpace='nowrap'; td.style.fontWeight='600';
        r.appendChild(td);
      }
      const id=rowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function colorFor(status){
    const s = tidy(status).toLowerCase();
    if (s.startsWith('running')) return '#0a0';
    if (s === 'offline') return '#c00';
    if (s === 'stopped') return '#c00';
    return '#666'; // unknown
  }
  function paintList(map){
    const g=table(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(r=>{
      const short=rowId(r); const td=r.querySelector('.onedrivecheck-cell'); if(!td) return;
      const data = map && (map['node//'+short] || map[short]);
      if(!data){ td.textContent='—'; td.style.color='#666'; return; }
      const label = data.status || 'Unknown';
      td.textContent = label;
      td.style.color = colorFor(label);
    });
  }
  function apiStatusShort(shortIds){
    const qs = shortIds.map(id=>'&id='+encodeURIComponent(id)).join('');
    return fetch('/pluginadmin.ashx?pin=onedrivecheck&status=1'+qs, { credentials:'same-origin' })
      .then(r=>r.json()).catch(()=>({}));
  }
  function tickList(){
    if(!addHeader()) return;
    const ids=ensureCells(); if(ids.length===0) return;
    apiStatusShort(ids).then(paintList);
  }

  // ===== Device page pill =====
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
    }
    return pill;
  }
  function paintDevice(map){
    const short=currentNodeId(); if(!short) return;
    const pill=ensureDevicePill(); if(!pill) return;
    const data = map && (map['node//'+short] || map[short]);
    if(!data){ pill.textContent='OneDriveCheck: —'; pill.style.color='#666'; return; }
    const label = data.status || 'Unknown';
    pill.textContent = 'OneDriveCheck: ' + label;
    pill.style.color = ('${''}'.length ? '#06c' : (label.toLowerCase().startsWith('running') ? '#0a0' : (label.toLowerCase()==='stopped'||label.toLowerCase()==='offline') ? '#c00' : '#666'));
    // ^ keep simple: green running, red stopped/offline, gray unknown
  }
  function tickDevice(){
    const id=currentNodeId(); if(!id) return;
    apiStatusShort([id]).then(paintDevice);
  }

  // Hooks + polling
  document.addEventListener('meshcentralDeviceListRefreshEnd', ()=> setTimeout(tickList, 250));
  document.addEventListener('meshcentralDeviceRefreshEnd', ()=> setTimeout(tickDevice, 250));
  window.addEventListener('hashchange', ()=> setTimeout(()=>{ tickList(); tickDevice(); }, 250));
  setInterval(()=>{ tickList(); tickDevice(); }, 7000);
  setTimeout(()=>{ tickList(); tickDevice(); }, 800);
})();`;
  }

  log("onedrivecheck loaded");
  return obj;
};
