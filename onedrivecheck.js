"use strict";

/**
 * OneDriveCheck – SAFE BASELINE (admin bridge only)
 *
 * Endpoints (must be logged in to MeshCentral UI):
 *  1) Who am I:
 *     /pluginadmin.ashx?pin=onedrivecheck&whoami=1
 *
 *  2) Debug (confirms session seen by plugin):
 *     /pluginadmin.ashx?pin=onedrivecheck&debug=1
 *
 *  3) List online agent DB keys (copy an id from here):
 *     /pluginadmin.ashx?pin=onedrivecheck&listonline=1
 *
 *  4) Echo shell (sanity check a single node; accepts short id or node//id):
 *     /pluginadmin.ashx?pin=onedrivecheck&echoshell=1&id=<NODE_ID>
 *
 *  5) PROBE (returns raw callback object so we can see the exact field with stdout):
 *     /pluginadmin.ashx?pin=onedrivecheck&probe=1&id=<NODE_ID>
 *
 *  6) Status (agent presence only):
 *     /pluginadmin.ashx?pin=onedrivecheck&status=1&id=<NODE_ID>[&id=...]
 *
 *  7) Status with PowerShell local port checks (20707 / 20773):
 *     /pluginadmin.ashx?pin=onedrivecheck&status=1&shell=1&id=<NODE_ID>[&id=...]
 */

module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // Only the admin bridge
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

  // ---- sendShell: return the entire raw callback so we can learn the shape
  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") {
        resolve({ ok:false, reason:"no_sendCommand" });
        return;
      }
      const payload = { cmd, type: "cmd" }; // force CMD channel (works even if default is PS)
      let done = false;
      const timer = setTimeout(()=>{ if(!done){ done=true; resolve({ ok:false, reason:"timeout" }); } }, 8000);

      try {
        obj.meshServer.sendCommand(nodeId, "shell", payload, function (resp){
          if (done) return;
          done = true; clearTimeout(timer);
          // Return the entire object (Mesh builds differ)
          resolve({ ok:true, raw: resp });
        });
      } catch(e){
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ ok:false, reason:"throw", error: String(e && e.message || e) });
      }
    });
  }

  // Try common shapes to extract stdout as a string
  function extractStdout(respObj){
    try {
      if (!respObj || !respObj.ok) return "";
      const r = respObj.raw;

      // Common cases across Mesh versions:
      if (typeof r === "string") return r;
      if (r && typeof r.data === "string") return r.data;
      if (r && r.data && r.data.toString) return r.data.toString();
      if (r && typeof r.response === "string") return r.response;
      if (r && r.value != null) return String(r.value);

      // some builds nest it deeper; last resort: stringify
      return JSON.stringify(r);
    } catch {
      return "";
    }
  }

  async function probePortsWindows(nodeId){
    // Run PowerShell through CMD (more consistent across agent shells)
    const psCmd =
      'powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
      '"$p1=(Test-NetConnection -ComputerName localhost -Port 20707 -WarningAction SilentlyContinue).TcpTestSucceeded; ' +
      '$p2=(Test-NetConnection -ComputerName localhost -Port 20773 -WarningAction SilentlyContinue).TcpTestSucceeded; ' +
      'Write-Output (\'p1=\' + $p1 + \';p2=\' + $p2)"';

    const resp = await sendShell(nodeId, `cmd /c ${psCmd}`);
    const out = extractStdout(resp);
    const m = /p1\s*=\s*(true|false).*?p2\s*=\s*(true|false)/i.exec(out || "");
    const p1 = !!(m && parseBool(m[1]));
    const p2 = !!(m && parseBool(m[2]));
    const status = p1 ? "App Online" : (p2 ? "Not signed in" : "Offline");
    return { status, port20707: p1, port20773: p2, raw: out };
  }

  // --- admin bridge only
  obj.handleAdminReq = async function(req, res, user) {
    try {
      // Debug & whoami
      if (req.query.debug == 1) { res.json({ ok:true, via:"handleAdminReq", hasUser:!!user, user:summarizeUser(user), hasSession:!!(req && req.session) }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user:summarizeUser(user) }); return;
      }

      // List online nodes
      if (req.query.listonline == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        res.json({ ok:true, agents:listOnline() }); return;
      }

      // Echo shell (also shows raw & guess so we can validate the shape)
      if (req.query.echoshell == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const rawId = req.query.id; if (!rawId) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(rawId) ? rawId[0] : rawId);
        const echoResp = await sendShell(id, `cmd /c echo ODC_ECHO_OK || powershell -NoProfile -Command "Write-Host ODC_ECHO_OK"`);
        res.json({ ok:true, id, raw: echoResp, guess: extractStdout(echoResp) }); return;
      }

      // PROBE – run two tiny commands and return raw callback objects
      if (req.query.probe == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const rawId = req.query.id; if (!rawId) { res.json({ ok:false, reason:"missing id"}); return; }
        const id = normalizeId(Array.isArray(rawId) ? rawId[0] : rawId);

        const r1 = await sendShell(id, 'cmd /c echo ODC_CMD_OK');
        const r2 = await sendShell(id, 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Output ODC_PS_OK"');

        res.json({
          ok: true,
          id,
          cmd: { raw: r1, guess: extractStdout(r1) },
          ps:  { raw: r2, guess: extractStdout(r2) }
        });
        return;
      }

      // Status / Status + shell probe
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
            out[id] = useShell ? (await probePortsWindows(id))
                               : { status:"Online (agent)", port20707:null, port20773:null };
          } catch (e) {
            err(e);
            out[id] = { status:"Error", port20707:false, port20773:false, error:true };
          }
        }
        res.json(out); return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("onedrivecheck SAFE baseline loaded");
  return obj;
};
