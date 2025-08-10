"use strict";

/**
 * OneDriveCheck – UI-safe baseline (NO injection)
 * Endpoints (while logged in):
 *  - /pluginadmin.ashx?pin=onedrivecheck&health=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<shortOrLongId>[&id=...]
 *     -> fast CMD netstat; fallback sc query "OneDriveCheckService"
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer.webserver;

  // Only this hook -> cannot affect UI rendering
  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  const SERVICE_NAME = "OneDriveCheckService";
  const CACHE_TTL_MS = 15000;

  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v)=> /^true$/i.test(String(v||"").trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ("node//" + id)));
  const isAgentOnline = (nodeId)=> !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]);

  const listOnline = ()=>{
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const k of Object.keys(a)) {
      try {
        const n = a[k].dbNode || a[k].dbNodeKey || null;
        out[k] = { key:k, name:(n && (n.name||n.computername))||null, os:(n && (n.osdesc||n.agentcaps))||null };
      } catch { out[k] = { key:k }; }
    }
    return out;
  };

  // runcommands with reply:true (peering-safe)
  const pend = new Map();
  const makeResponseId = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

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
        type, // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser, // false = agent service
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) { pend.delete(responseid); }
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);
      pend.set(responseid, { resolve, timeout });

      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); } catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
        return;
      }
      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }
      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  const cache = new Map(); // nodeId -> { t, result }

  async function probeNode(nodeId){
    const now = Date.now();
    const c = cache.get(nodeId);
    if (c && (now - c.t) < CACHE_TTL_MS) return c.result;

    // 1) fast netstat (CMD)
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
      result = { status:'Unknown', port20707:false, port20773:false };
    } else if (p1) {
      result = { status:'Running', port20707:true,  port20773:p2 };
    } else if (p2) {
      result = { status:'Running (No Sign-In)', port20707:false, port20773:true };
    } else {
      // 2) service state via sc
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

    cache.set(nodeId, { t: now, result });
    return result;
  }

  obj.handleAdminReq = async function(req, res, user) {
    try {
      // simple health
      if (req.query.health == 1) {
        res.json({ ok:true, plugin:"onedrivecheck", exports: obj.exports });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:'no user' }); return; }
        res.json({ ok:true, user:summarizeUser(user) });
        return;
      }

      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.json({ ok:true, agents:listOnline() });
        return;
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

      if (req.query.debug == 1) {
        res.json({ ok:true, user:summarizeUser(user)||null, hasWsAgents: !!(wsserver && wsserver.wsagents) });
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck baseline loaded (no UI injection).");
  return obj;
};
