"use strict";

/** OneDriveCheck – minimal, auth-aware debug plugin
 * shortName: onedrivecheck
 * Safe: no timers, no DB writes, no UI injection.
 */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // ---------- logging helpers
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // ---------- helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p)=> baseNoSlash + p;
  const isSiteAdmin = (user)=> !!user && ((user.siteadmin|0) & 0xFFFFFFFF) !== 0;

  function summarizeUser(u){
    if (!u) return null;
    const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = u;
    return { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser };
  }

  function summarizeHeaders(h){
    if (!h) return {};
    // only show a few to avoid noise
    const pick = ["host","cookie","cf-cache-status","cf-ray","cf-visitor","x-forwarded-for","x-forwarded-proto","x-forwarded-host","via","user-agent","accept","cache-control"];
    const out = {};
    for (const k of pick) { if (h[k]) out[k] = String(h[k]); }
    // add cookie length (don’t echo the cookie itself)
    out.cookieLength = h.cookie ? String(h.cookie.length) : 0;
    return out;
  }

  // ---------- REQUIRED: plugin-admin bridge (works reliably through Mesh)
  // Examples while logged in:
  //  - /pluginadmin.ashx?pin=onedrivecheck&debug=1
  //  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  //  - /pluginadmin.ashx?pin=onedrivecheck&admin=1
  obj.handleAdminReq = function(req, res, user) {
    try {
      if (req.query.debug == 1) {
        res.json({
          ok: true,
          via: "handleAdminReq",
          webRoot,
          hasUser: !!user,
          user: summarizeUser(user),
          headers: summarizeHeaders(req.headers),
          hasSession: !!req.session
        });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user: summarizeUser(user) });
        return;
      }

      if (req.query.admin == 1) {
        if (!isSiteAdmin(user)) { res.sendStatus(401); return; }
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck – Admin</title></head>
<body style="font-family:sans-serif;padding:20px;max-width:860px">
  <h2>OneDriveCheck – Admin</h2>
  <p>Authenticated as site admin.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug (JSON)</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
    <li><a target="_blank" href="${R('/plugin/onedrivecheck/debug')}">Express Debug (bypasses pluginadmin)</a></li>
    <li><a target="_blank" href="${R('/plugin/onedrivecheck/whoami')}">Express Who am I</a></li>
  </ul>
  <p>If Express debug shows <code>hasUser:false</code> but admin debug shows <code>true</code>, your proxy/CDN is interfering with cookies on <code>/plugin/*</code>. Add a cache bypass for <code>/plugin/*</code> and <code>/pluginadmin.ashx*</code>.</p>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }

      if (req.query.user == 1) {
        // simple user page
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck</title></head>
<body style="font-family:sans-serif;padding:20px;max-width:860px">
  <h2>OneDriveCheck</h2>
  <p>Authenticated user page.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug (JSON)</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
  </ul>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }

      res.sendStatus(404);
    } catch (e) {
      err(e);
      res.sendStatus(500);
    }
  };

  // ---------- OPTIONAL: direct Express routes (will show CDN/proxy issues)
  function attachExpress(app){
    app.get(R("/plugin/onedrivecheck/debug"), function(req,res){
      res.json({
        ok: true,
        via: "express",
        webRoot,
        hasUser: !!req.user,
        user: summarizeUser(req.user),
        headers: summarizeHeaders(req.headers),
        hasSession: !!req.session
      });
    });

    app.get(R("/plugin/onedrivecheck/whoami"), function(req,res){
      if (!req.user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
      res.json({ ok:true, user: summarizeUser(req.user) });
    });

    // tiny no-auth endpoint to help test cache bypass rules
    app.get(R("/plugin/onedrivecheck/ping"), function(req,res){
      res.json({ ok:true, t: Date.now() });
    });

    log("express routes mounted at /plugin/onedrivecheck/* (webRoot=" + webRoot + ")");
  }

  // Mesh will call this hook after it wires cookie-session/auth
  obj.hook_setupHttpHandlers = function(appOrWeb/*, express */){
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);
    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try { attachExpress(app); } catch(e){ err(e); }
  };

  return obj;
};
