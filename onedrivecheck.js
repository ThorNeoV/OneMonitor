"use strict";

/**
 * OneDriveCheck – SAFE ADMIN BRIDGE (no UI injection)
 * Endpoints while logged in:
 *  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&debug=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&diag=1                 // shows sendCommand availability
 *  - /pluginadmin.ashx?pin=onedrivecheck&echoshell=1&id=<id>    // quick echo test
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<id>[&id=...]        // presence only
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&shell=1&id=<id>[&id=...] // FAST CMD port probe
 *
 * Notes:
 *  - Requires MeshCentral >= 1.1.40 (peering fix for RunCommand/agentCommand path)
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  obj.exports = ["handleAdminReq"]; // make sure Mesh calls our handler

  // --- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // --- helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool = (v) => /^true$/i.test(String(v).trim());

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
    const a = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
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

  // Preferred server API if available (fixed in Mesh ≥ 1.1.40 for peering)
  function haveSendCommand() {
    return obj.meshServer && typeof obj.meshServer.sendCommand === "function";
  }

  function sendShell(nodeId, cmd) {
    return new Promise((resolve) => {
      if (!haveSendCommand()) { resolve({ ok:false, raw:"", meta:"no_sendCommand" }); return; }
      const payload = { cmd, type: "cmd" }; // run in CMD
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok:false, raw:"", meta:"timeout" }); } }, 8000);
      try {
        obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp) {
          if (done) return;
          done = true; clearTimeout(timer);
          const raw = (resp && resp.data) ? String(resp.data) : "";
          resolve({ ok:true, raw });
        });
      } catch (e) {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ ok:false, raw:"", meta:"exception" });
      }
    });
  }

  // FAST CMD port probe (Windows)
  async function probePortsCmd(nodeId) {
    // findstr is faster and avoids the “Access denied - \” we saw with piped find
    const cmd = 'cmd /c "(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & (netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)"';
    const res = await sendShell(nodeId, cmd);
    if (!res.ok) return { status:"Offline", port20707:false, port20773:false, raw:res.raw || "", meta:res.meta || "send_failed" };

    const out = res.raw || "";
    const m = /p1\s*=\s*(true|false)[\s\S]*?p2\s*=\s*(true|false)/i.exec(out);
    const p1 = m ? parseBool(m[1]) : false;
    const p2 = m ? parseBool(m[2]) : false;
    const status = p1 ? "App Online" : (p2 ? "Not signed in" : "Offline");
    return { status, port20707: !!p1, port20773: !!p2, raw: out.trim() };
  }

  // --- admin bridge
  obj.handleAdminReq = async function (req, res, user) {
    try {
      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) });
        return;
      }

      if (req.query.diag == 1) {
        const have = {
          sendCommand: String(obj.meshServer && obj.meshServer.sendCommand),
          hasWsAgents: !!(obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents)
        };
        const a = (obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
        const sample = Object.keys(a).slice(0,5);
        res.json({ ok:true, have, sampleOnlineCount: Object.keys(a).length, onlineKeys: sample });
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
        let id = req.query.id; if (!id) { res.json({ ok:false, reason:"missing id" }); return; }
        id = normalizeId(Array.isArray(id) ? id[0] : id);
        const res1 = await sendShell(id, 'cmd /c echo odc_ok');
        const res2 = await sendShell(id, 'powershell -NoProfile -Command "Write-Output odc_ok_ps"');
        res.json({ ok:true, id, cmd:res1, ps:res2 });
        return;
      }

      if (req.query.status == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }

        let ids = req.query.id; if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];
        ids = ids.map(normalizeId);

        const useShell = String(req.query.shell || "") === "1";

        const out = {};
        for (const id of ids) {
          try {
            if (!isAgentOnline(id)) { out[id] = { status:"Offline", port20707:false, port20773:false, raw:"", meta:"agent_offline" }; continue; }
            if (!useShell) { out[id] = { status:"Online (agent)", port20707:null, port20773:null }; continue; }
            out[id] = await probePortsCmd(id);
          } catch (e) {
            err(e);
            out[id] = { status:"Error", port20707:false, port20773:false, raw:"", meta:"exception" };
          }
        }
        res.json(out);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck (fast CMD probe) loaded");
  return obj;
};
