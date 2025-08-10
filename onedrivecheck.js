"use strict";

/**
 * OneDriveCheck (server) – peering-safe runcommands with reply
 * - Adds /pluginadmin.ashx?pin=onedrivecheck endpoints:
 *    • &debug=1
 *    • &whoami=1
 *    • &listonline=1
 *    • &status=1&id=<shortOrLongId>[&id=...]      → probes via CMD+netstat (fast)
 *    • &include=1&path=ui.js                      → serves UI injector JS
 * - UI injector adds a column in device list + a pill on device page.
 *
 * No risky Express hooks. Uses admin bridge only. Replies handled via hook_processAgentData.
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer.webserver;

  // Some Mesh builds call only hooks listed here
  obj.exports = ["handleAdminReq", "hook_processAgentData", "onWebUIStartupEnd"];

  // ---- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

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

  // Handle agent replies globally
  obj.hook_processAgentData = function(agent, command /* JSON from agent */) {
    try {
      if (!command) return;

      // Native runcommands reply path (when reply:true was set)
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (p) {
          pend.delete(command.responseid);
          clearTimeout(p.timeout);
          // command.result may be 'OK' or include output. On newer builds output is in command.console or command.result.
          const raw = (command.console || command.result || '').toString();
          p.resolve({ ok:true, raw });
        }
        return;
      }

      // (Optional future) If we ever switch to plugin→agent consoleaction, handle here.
      // if (command.action === 'plugin' && command.plugin === 'onedrivecheck' && command.pluginaction === 'status') { ... }
    } catch (e) { err(e); }
  };

  // Send RunCommands to agent (local or peer), await reply
  function runCommandsAndWait(nodeId, type, lines, runAsUser){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                     // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,   // false = run as agent
        reply: true,
        responseid
      };

      // timeout safety
      const timeout = setTimeout(() => {
        if (pend.has(responseid)) { pend.delete(responseid); }
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

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

  // Fast Windows probe using CMD + netstat (no admin requirement)
  async function probeWindowsFast(nodeId){
    // Produces:
    // p1=True
    // p2=True
    const line = '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & (netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)';
    const res = await runCommandsAndWait(nodeId, 'bat', line, false);
    const raw = (res && res.raw) ? String(res.raw) : '';
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;
    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : 'Offline');
    return { status, port20707: !!p1, port20773: !!p2, raw, meta: (res && res.meta) || undefined };
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
        // Process limited parallelism
        const queue = ids.slice();
        const MAX_PAR = 8;
        async function worker(){
          while(queue.length){
            const id = queue.shift();
            try {
              if (!isAgentOnline(id)) { out[id] = { status:'Offline', port20707:false, port20773:false, raw:'' }; continue; }
              out[id] = await probeWindowsFast(id);
            } catch (e) { err(e); out[id] = { status:'Error', port20707:false, port20773:false, raw:'' }; }
          }
        }
        await Promise.all(Array.from({length: Math.min(MAX_PAR, ids.length)}, worker));
        res.json(out);
        return;
      }

      // Minimal admin page for sanity check
      if (req.query.admin == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(`<!doctype html><meta charset="utf-8"><title>OneDriveCheck</title>
          <h2>OneDriveCheck</h2>
          <p>Use device list; a column will appear after page loads. Device page shows a pill.</p>
          <ul>
            <li><a href="?pin=onedrivecheck&debug=1">debug</a></li>
            <li><a href="?pin=onedrivecheck&listonline=1">listonline</a></li>
            <li>UI JS: <code>/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js</code></li>
          </ul>`);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // Inject our UI script (served by admin bridge, CSP-safe, same-origin)
  obj.onWebUIStartupEnd = function () {
    const v = (Date.now() % 1e6);
    return `<script src="/pluginadmin.ashx?pin=onedrivecheck&include=1&path=ui.js&v=${v}"></script>`;
  };

  // ====== Client JS (column + pill) ======
  function buildClientJS(){
    return `(()=>{"use strict";
  const log=(...a)=>{ try{console.log("%c[ODC]","color:#06c;font-weight:700",...a);}catch{} };

  // Resolve table elements across skins
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
      log("header added");
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
      const s=(id && map && map['node//'+id])?map['node//'+id]:null;
      if(!s){ td.textContent='—'; td.dataset.state=''; td.title=''; td.style.color=''; td.style.fontWeight=''; return; }
      td.textContent = s.status || '—';
      td.title = '20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed');
      const state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
      td.dataset.state = state;
      td.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
      td.style.fontWeight = '600';
    });
  }
  function apiStatusLong(longIds){
    const qs = longIds.map(id=>'&id='+encodeURIComponent(id)).join('');
    return fetch('/pluginadmin.ashx?pin=onedrivecheck&status=1'+qs, { credentials:'same-origin' })
      .then(r=>r.json()).catch(()=>({}));
  }
  function apiStatusShort(shortIds){
    // server accepts short or long; normalize on server
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
    const id=currentNodeId(); if(!id) return;
    const s=map['node//'+id]; const pill=ensureDevicePill(); if(!pill) return;
    if(!s){ pill.textContent='OneDriveCheck: —'; pill.style.color='#666'; return; }
    const state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));
    pill.textContent='OneDriveCheck: ' + (s.status||'—') + '  (20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed')+')';
    pill.style.color = (state==='online'?'#0a0':(state==='notsigned'?'#b80':'#c00'));
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
