"use strict";

/**
 * OneDriveCheck – SAFE BASELINE (admin bridge only)
 * Endpoints (use while logged in):
 *  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&debug=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&apiguess=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&echoshell=1&id=<id or node//id>
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<id>[&id=...]          (agent presence only)
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&shell=1&id=<id>[&id=...]   (PowerShell probes ports 20707/20773)
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // Some Mesh builds only call known hooks when listed:
  obj.exports = ["handleAdminReq"];

  // --- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // --- small helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v)=> /^true$/i.test(String(v).trim());

  function normalizeId(id) {
    if (!id) return id;
    if (/^node\/\/.+/i.test(id)) return id;     // already DB key
    return 'node//' + id;                       // convert short UI id
  }

  function isAgentOnline(nodeId){
    try {
      const a = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
      return !!(a && a[nodeId]);
    } catch { return false; }
  }

  function listOnline() {
    const a = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
    const out = {};
    for (const k of Object.keys(a)) {
      try {
        const n = a[k].dbNode || a[k].dbNodeKey || null;
        out[k] = {
          key: k,
          name: (n && (n.name || n.computername)) || null,
          os: (n && (n.osdesc || n.agentcaps)) || null
        };
      } catch { out[k] = { key: k }; }
    }
    return out;
  }

  // ---------- Agent socket access ----------
  function getWsAgent(nodeId){
    try { return obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents && obj.meshServer.webserver.wsagents[nodeId]; }
    catch { return null; }
  }

  // Minimal per-request reply hook on the agent websocket
  function installAgentReplyHook(nodeId, corrTag, onReply, timeoutMs){
    const ws = getWsAgent(nodeId);
    if (!ws || !ws.on) return ()=>{};
    let finished = false;

    function handler(msg){
      if (finished) return;
      let o;
      try { o = JSON.parse(String(msg)); } catch { return; }
      // We key on a private correlation tag we include in the request
      if (o && o._odcTag === corrTag) {
        finished = true;
        try { ws.removeListener('message', handler); } catch {}
        onReply(o);
      }
    }
    try { ws.on('message', handler); } catch {}
    const cancel = ()=>{
      if (finished) return;
      finished = true;
      try { ws.removeListener('message', handler); } catch {}
    };
    setTimeout(cancel, timeoutMs || 9000);
    return cancel;
  }

  // Direct socket send fallback (agent shell via "shell" action)
  function directShell(nodeId, cmd){
    return new Promise((resolve)=>{
      const ws = getWsAgent(nodeId);
      if (!ws || !ws.send) { resolve(""); return; }

      const corrTag = 'odc_' + Math.random().toString(36).slice(2);
      const cancel = installAgentReplyHook(nodeId, corrTag, (reply)=>{
        const s = (reply && (reply.data || reply.value || reply.output || "")) || "";
        resolve(String(s));
      }, 9000);

      const message = {
        action: 'shell',
        type: 'cmd',
        cmd: cmd,
        _odcTag: corrTag
      };

      try { ws.send(JSON.stringify(message)); } catch { cancel(); resolve(""); }
    });
  }

  // Main sendShell shim — tries several APIs, then falls back to direct socket
  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      const done = (s)=>resolve(s==null?"":String(s));

      // Try modern camelCase API
      if (obj.meshServer && typeof obj.meshServer.sendCommand === 'function') {
        try {
          obj.meshServer.sendCommand(nodeId, 'shell', { cmd, type: 'cmd' }, (resp)=>{
            return done(resp && (resp.data || resp.value || resp.output || ""));
          });
          return;
        } catch {}
      }
      // Try older PascalCase API
      if (obj.meshServer && typeof obj.meshServer.SendCommand === 'function') {
        try {
          obj.meshServer.SendCommand(nodeId, 'shell', { cmd, type: 'cmd' }, (resp)=>{
            return done(resp && (resp.data || resp.value || resp.output || ""));
          });
          return;
        } catch {}
      }

      // Last resort: direct socket to the agent with our reply hook
      directShell(nodeId, cmd).then(done);
    });
  }

  async function liveCheckWindows(nodeId) {
    // Launch PowerShell *through* cmd so the agent's shell type doesn't matter
    const psCmd =
      'powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
      '"$p1=(Test-NetConnection -ComputerName localhost -Port 20707 -WarningAction SilentlyContinue).TcpTestSucceeded; ' +
      '$p2=(Test-NetConnection -ComputerName localhost -Port 20773 -WarningAction SilentlyContinue).TcpTestSucceeded; ' +
      'Write-Output (\'p1=\' + $p1 + \';p2=\' + $p2)"';

    const out = await sendShell(nodeId, `cmd /c ${psCmd}`);
    log(`onedrivecheck shell out (${nodeId}): ${out}`);

    const m = /p1\s*=\s*(true|false).*?p2\s*=\s*(true|false)/i.exec(out || "");
    const p1 = m ? parseBool(m[1]) : false;
    const p2 = m ? parseBool(m[2]) : false;
    const status = p1 ? "App Online" : (p2 ? "Not signed in" : "Offline");
    return { status, port20707: !!p1, port20773: !!p2, raw: out ? out.trim() : "" };
  }

  // ---------- Admin bridge ----------
  obj.handleAdminReq = async function (req, res, user) {
    try {
      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) });
        return;
      }

      if (req.query.apiguess == 1) {
        const api = {
          has_meshServer: !!obj.meshServer,
          sendCommand: !!(obj.meshServer && obj.meshServer.sendCommand),
          SendCommand: !!(obj.meshServer && obj.meshServer.SendCommand),
          DispatchEvent: !!(obj.meshServer && obj.meshServer.DispatchEvent),
          wsagents: !!(obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents)
        };
        res.json({ ok:true, api });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user:summarizeUser(user) });
        return;
      }

      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents:listOnline() });
        return;
      }

      if (req.query.echoshell == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const raw = req.query.id;
        if (!raw) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        const out = await sendShell(id, `cmd /c echo odc_ok || powershell -NoProfile -Command "Write-Host odc_ok"`);
        res.json({ ok:true, id, output: String(out||"") });
        return;
      }

      if (req.query.status == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }

        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];

        ids = ids.map(normalizeId);
        const useShell = String(req.query.shell || "") === "1";

        const out = {};
        for (const id of ids) {
          try {
            if (!isAgentOnline(id)) {
              out[id] = { status:"Offline", port20707:false, port20773:false };
              continue;
            }
            if (useShell) {
              out[id] = await liveCheckWindows(id);
            } else {
              out[id] = { status:"Online (agent)", port20707:null, port20773:null };
            }
          } catch (e) {
            err(e);
            out[id] = { status:"Error", port20707:false, port20773:false, error:true };
          }
        }
        res.json(out);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck SAFE baseline loaded");
  return obj;
};
