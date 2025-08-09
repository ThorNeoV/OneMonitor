"use strict";

/** OneDriveCheck – SAFE BASELINE (no UI injection)
 * - Only uses pluginadmin.ashx (Mesh passes req,res,user with session)
 * - No express hooks, no onWebUIStartupEnd => cannot blank the site
 * - status API:
 *      /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>[&id=...]         // presence only
 *      /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<nodeId>&shell=1           // PowerShell port probe (Windows agents)
 * - debug:
 *      /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *      /pluginadmin.ashx?pin=onedrivecheck&debug=1
 * - menu:
 *      /pluginadmin.ashx?pin=onedrivecheck&menu=1
 */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // --- logging helpers
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // --- tiny helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;

  function isAgentOnline(nodeId){
    try {
      const a = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
      return !!(a && a[nodeId]);
    } catch { return false; }
  }

  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      const payload = { cmd, type: "powershell" };
      let done = false;
      const timer = setTimeout(()=>{ if(!done){ done=true; resolve(""); } }, 7000);
      try {
        obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp){
          if (done) return; done = true; clearTimeout(timer);
          resolve(resp && resp.data ? String(resp.data) : "");
        });
      } catch(e){
        if (done) return; done = true; clearTimeout(timer);
        resolve("");
      }
    });
  }

  function parseBool(s){ return /true/i.test(String(s||"")); }

  async function liveCheckWindows(nodeId){
    // Probe local ports 20707 & 20773 via agent PowerShell (Windows)
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

  // ===== REQUIRED: admin bridge only (no express, no UI injection)
  // helper: normalize any UI/short id into DB key
  function normalizeId(id) {
    if (!id) return id;
    // already a DB key?
    if (/^node\/\/.+/i.test(id)) return id;
    // Many UIs pass the short id; Mesh DB key is "node//" + short
    return 'node//' + id;
  }
  
  function listOnline() {
    const a = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
    const out = {};
    for (const k of Object.keys(a)) {
      try {
        const n = a[k].dbNode || a[k].dbNodeKey || null;
        // include a small summary when available
        out[k] = {
          key: k,
          name: (n && (n.name || n.computername)) || null,
          os: (n && (n.osdesc || n.agentcaps)) || null
        };
      } catch { out[k] = { key: k }; }
    }
    return out;
  }

  obj.handleAdminReq = async function(req, res, user) {
    try {
      // serve UI loader (unchanged)
      if (req.query.include == 1) {
        const file = String(req.query.path||"").replace(/\\/g,"/").trim();
        if (file !== "ui.js") { res.sendStatus(404); return; }
        res.setHeader("Content-Type","application/javascript; charset=utf-8");
        res.end(buildClientJS());
        return;
      }
  
      // quick introspection
      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) });
        return;
      }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user:summarizeUser(user) });
        return;
      }
  
      // NEW: list all online agent keys (copy an id from here)
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents:listOnline() });
        return;
      }
  
      // NEW: simple shell echo to verify shell works on a single node
      if (req.query.echoshell == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const raw = req.query.id;
        if (!raw) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        const out = await sendShell(id, `cmd /c echo odc_ok || powershell -NoProfile -Command "Write-Host odc_ok"`);
        res.json({ ok:true, id, output: String(out||"") });
        return;
      }
  
      // STATUS: supports multiple ids; now normalizes each id before use
      if (req.query.status == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];
  
        ids = ids.map(normalizeId);
  
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

      // Debug + whoami
      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) });
        return;
      }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user:summarizeUser(user) });
        return;
      }

      // Status API
      if (req.query.status == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }

        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];

        const useShell = String(req.query.shell||"") === "1";
        const out = {};
        for (const id of ids) {
          try {
            if (!isAgentOnline(id)) { out[id] = { status:"Offline", port20707:false, port20773:false }; continue; }
            out[id] = useShell ? (await liveCheckWindows(id)) : { status:"Online (agent)", port20707:null, port20773:null };
          } catch (e) {
            err(e);
            out[id] = { status:"Error", port20707:false, port20773:false, error:true };
          }
        }
        res.json(out);
        return;
      }

      // Fallback
      res.sendStatus(404);
    } catch (e) {
      err(e);
      res.sendStatus(500);
    }
  };

  log("onedrivecheck SAFE baseline loaded");
  return obj;
};

