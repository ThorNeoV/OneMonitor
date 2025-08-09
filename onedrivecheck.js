"use strict";

/** Minimal OneDriveCheck plugin (admin bridge + optional express) */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // logging
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p)=> baseNoSlash + p;
  const isSiteAdmin = (user)=> !!user && ((user.siteadmin|0) & 0xFFFFFFFF) !== 0;

  // ---------- REQUIRED: plugin-admin bridge (always works)
  // Hit these URLs while logged in:
  //  - /pluginadmin.ashx?pin=onedrivecheck&debug=1
  //  - /pluginadmin.ashx?pin=onedrivecheck&whoami=1
  //  - /pluginadmin.ashx?pin=onedrivecheck&admin=1   (admin page)
  obj.handleAdminReq = function(req, res, user) {
    try {
      if (req.query.debug == 1) {
        res.json({
          ok: true,
          via: "handleAdminReq",
          webRoot,
          hasUser: !!user,
          userSummary: user ? { name:user.name, userid:user.userid, domain:user.domain, siteadmin:user.siteadmin } : null
        });
        return;
      }

      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = user;
        res.json({ ok:true, user:{ name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
        return;
      }

      if (req.query.admin == 1) {
        if (!isSiteAdmin(user)) { res.sendStatus(401); return; }
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>OneDriveCheck – Admin</title></head>
<body style="font-family:sans-serif;padding:20px;max-width:860px">
  <h2>OneDriveCheck – Admin</h2>
  <p>You are site admin. Plugin is installed and can read your session.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug JSON</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
  </ul>
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
  <p>Logged-in user can access this page.</p>
  <ul>
    <li><a href="?pin=onedrivecheck&debug=1">Debug JSON</a></li>
    <li><a href="?pin=onedrivecheck&whoami=1">Who am I</a></li>
  </ul>
</body></html>`;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        res.end(html);
        return;
      }

      // nothing matched
      res.sendStatus(404);
    } catch (e) {
      err(e);
      res.sendStatus(500);
    }
  };

  // ---------- OPTIONAL: direct Express routes (nice-to-have)
  function attachExpress(app){
    app.get(R("/plugin/onedrivecheck/debug"), function(req,res){
      const u = req.user || null;
      res.json({
        ok: true,
        via: "express",
        webRoot,
        hasUser: !!u,
        userSummary: u ? { name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin } : null
      });
    });

    app.get(R("/plugin/onedrivecheck/whoami"), function(req,res){
      if (!req.user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
      const { name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } = req.user;
      res.json({ ok:true, user:{ name, userid, domain, siteadmin, domainadmin, admin, isadmin, superuser } });
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
