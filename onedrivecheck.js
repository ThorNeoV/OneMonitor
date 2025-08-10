"use strict";

/**
 * OneDriveCheck – SAFE BASELINE (admin bridge only, fast CMD probe)
 *
 * Endpoints (use while logged in):
 *  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&debug=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *  - /pluginadmin.ashx?pin=onedrivecheck&echoshell=1&id=<id or node//id>
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<id>[&id=...]                (agent presence only)
 *  - /pluginadmin.ashx?pin=onedrivecheck&status=1&shell=1&id=<id>[&id=...]         (CMD netstat probes 20707/20773)
 *  - /pluginadmin.ashx?pin=onedrivecheck&cmdprobe=1&id=<id>                        (runs the raw netstat probe; debug helper)
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // Some Mesh builds only call known hooks when listed.
  obj.exports = ["handleAdminReq"];

  // --- logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // --- helpers
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

  function sendShell(nodeId, cmd) {
    return new Promise((resolve) => {
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") {
        resolve({ ok:false, reason:"no_sendCommand" });
        return;
      }
      const payload = { cmd, type: "cmd" }; // Force CMD channel
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve({ ok:false, reason:"timeout" }); }
      }, 8000);
      try {
        obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const data = (resp && typeof resp.data === "string") ? resp.data : "";
          resolve({ ok:true, data });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok:false, reason:String(e && e.message || e || "send_error") });
      }
    });
  }

  // Fast local port probe using CMD (no quotes in findstr to avoid escaping issues)
  const NETSTAT_PROBE =
    '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False) & ' +
    '(netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)';

  async function probePortsCMD(nodeId){
    const res = await sendShell(nodeId, `cmd /c ${NETSTAT_PROBE}`);
    const raw = (res && res.ok && res.data) ? res.data : "";
    // Accept output with possible spacing/newlines
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;
    const status = p1 ? "App Online" : (p2 ? "Not signed in" : "Offline");
    return { status, port20707: !!p1, port20773: !!p2, raw: raw.trim(), meta: res.ok ? "ok" : (res && res.reason || "no_output") };
  }

  // --- admin bridge only
  obj.handleAdminReq = async function (req, res, user) {
    try {
      // Debug / WhoAmI / Online
      if (req.query.debug == 1) {
        res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) });
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

      // Quick shell echo to verify path/channel
      if (req.query.echoshell == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const rawId = req.query.id;
        if (!rawId) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(rawId) ? rawId[0] : rawId);
        const out = await sendShell(id, `cmd /c echo odc_ok`);
        res.json({ ok:true, id, output: (out && out.ok ? out.data : ""), meta: out });
        return;
      }

      // Manual probe endpoint (shows raw output so you can compare with interactive tests)
      if (req.query.cmdprobe == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const rawId = req.query.id;
        if (!rawId) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(rawId) ? rawId[0] : rawId);
        if (!isAgentOnline(id)) { res.json({ ok:false, reason:"agent_offline", id }); return; }
        const r = await sendShell(id, `cmd /c ${NETSTAT_PROBE}`);
        res.json({ ok: !!(r && r.ok), id, raw: r && r.data || "", meta: r && (r.ok ? "ok" : r.reason) });
        return;
      }

      // Status (presence only) or Status+shell (CMD probe)
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
            if (!isAgentOnline(id)) { out[id] = { status:"Offline", port20707:false, port20773:false }; continue; }
            if (useShell) out[id] = await probePortsCMD(id);
            else out[id] = { status:"Online (agent)", port20707:null, port20773:null };
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

  log("onedrivecheck (CMD probe) loaded");
  return obj;
};
