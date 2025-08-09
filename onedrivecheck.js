"use strict";

/** Minimal OneDrive Check plugin (no timers, no persistence)
 * shortName: onedrivecheck
 */
module.exports.onedrivecheck = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const ws = parent.webserver;

  // logging helpers
  const log = (m)=>{ try{ obj.meshServer.info("onedrivecheck: " + m); }catch{ console.log("onedrivecheck:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("onedrivecheck error: " + (e && e.stack || e)); }catch{ console.error("onedrivecheck error:", e); } };

  // webRoot helpers
  const webRoot = (ws && ws.webRoot) || "/";
  const baseNoSlash = webRoot.endsWith("/") ? webRoot.slice(0,-1) : webRoot;
  const R = (p) => baseNoSlash + p;

  function isAuthed(req){ return !!(req && req.user); }

  function sendShell(nodeId, cmd){
    return new Promise((resolve)=>{
      if (!obj.meshServer || typeof obj.meshServer.sendCommand !== "function") { resolve(""); return; }
      obj.meshServer.sendCommand(nodeId, "shell", { cmd, type: "powershell" }, (resp)=>{
        resolve(resp && resp.data ? String(resp.data) : "");
      });
    });
  }

  async function checkOneDriveOnNode(nodeId){
    // Example check: see if OneDrive process is running
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object -First 1"`;
    const out = await sendShell(nodeId, cmd);
    return /\S/.test(out); // any output means process exists
  }

  function attachRoutes(app){
    const express = require("express");
    const router = express.Router();

    router.get("/debug", (req,res)=>{
      res.json({
        webRoot,
        url: req.originalUrl || req.url,
        hasUser: !!(req && req.user),
        hasSession: !!(req && req.session)
      });
    });

    router.get("/status", async (req,res)=>{
      if (!isAuthed(req)) { res.status(403).end("Forbidden"); return; }

      let ids = req.query.id;
      if (!ids) { res.json({}); return; }
      if (!Array.isArray(ids)) ids = [ids];

      const out = {};
      for (const nodeId of ids) {
        try {
          out[nodeId] = { running: await checkOneDriveOnNode(nodeId) };
        } catch(e) {
          err(e);
          out[nodeId] = { running: false, error: "check_failed" };
        }
      }
      res.json(out);
    });

    app.use(R('/plugin/onedrivecheck'), router);
    app.use('/plugin/onedrivecheck', router);

    log("routes mounted at " + R('/plugin/onedrivecheck') + " and /plugin/onedrivecheck");
  }

  obj.hook_setupHttpHandlers = function (appOrWeb) {
    const app = (appOrWeb && typeof appOrWeb.get === "function")
      ? appOrWeb
      : (appOrWeb && appOrWeb.app && typeof appOrWeb.app.get === "function" ? appOrWeb.app : null);
    if (!app) { err("hook_setupHttpHandlers: no valid app"); return; }
    try { attachRoutes(app); } catch(e){ err(e); }
  };

  obj.onWebUIStartupEnd = function () {
    const base = webRoot.endsWith("/") ? webRoot : (webRoot + "/");
    return `<script src="${base}plugin/onedrivecheck/ui.js"></script>`;
  };

  return obj;
};
