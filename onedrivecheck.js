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
  obj.handleAdminReq = async function(req, res, user) {
    try {
      // Simple menu page
      if (req.query.menu == 1) {
        if (!user) { res.status(401).end("Unauthorized"); return; }
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck – Menu</title></head>
<body style="font-family:sans-serif;padding:18px;max-width:900px">
  <h2>OneDriveCheck – Menu</h2>
  <ul>
    <li><a href="?pin=onedrivecheck&whoami=1" target="_blank">Who am I (auth check)</a></li>
    <li><a href="?pin=onedrivecheck&debug=1" target="_blank">Debug (session + env)</a></li>
  </ul>
  <h3>Quick status test</h3>
  <ol>
    <li>Open a device, copy its <code>nodeid</code> from the URL hash (e.g. <code>#...nodeid=XXXXXXXX@domain</code>).</li>
    <li>Paste it below and click a test:</li>
  </ol>
  <form onsubmit="doTest(event)">
    <input id="nid" type="text" placeholder="NODEID here" style="width:480px" required />
    <button type="submit">Presence only</button>
    <button type="button" onclick="doShell()">PowerShell probe (Windows)</button>
  </form>
  <pre id="out" style="margin-top:12px;padding:10px;border:1px solid #ccc;border-radius:6px;background:#f8f8f8;white-space:pre-wrap;min-height:80px"></pre>
<script>
function api(url){
  return fetch(url, { credentials:'same-origin' }).then(r=>r.json()).catch(e=>({error:String(e)}));
}
function show(o){ document.getElementById('out').textContent = JSON.stringify(o,null,2); }
function nid(){ return encodeURIComponent(document.getElementById('nid').value.trim()); }
function doTest(e){ e.preventDefault(); api('?pin=onedrivecheck&status=1&id='+nid()).then(show); }
function doShell(){ api('?pin=onedrivecheck&status=1&shell=1&id='+nid()).then(show); }
</script>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }

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
