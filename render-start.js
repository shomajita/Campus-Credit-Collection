"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const serverPath = path.join(__dirname, "server.js");
let source = fs.readFileSync(serverPath, "utf8");

source = source
  .replace(/startDay: 1, endDay: 27/g, "startDay: 1, endDay: 31")
  .replace(/startDay: 15, endDay: 27/g, "startDay: 15, endDay: 31")
  .replace(
    "return day >= category.startDay && day <= category.endDay;",
    "const endDay = Math.min(category.endDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());\n  return day >= category.startDay && day <= endDay;"
  )
  .replace(
    "function getAdminUsername() {\n  return appSettings.admin?.username || config.adminUsername;\n}",
    "function getAdminUsername() {\n  if (config.adminPassword) return config.adminUsername;\n  return appSettings.admin?.username || config.adminUsername;\n}"
  )
  .replace(
    "async function verifyAdminCredentials(username, password) {\n  const admin = appSettings.admin;\n  if (admin?.passwordHash && admin?.passwordSalt) {\n    return username === admin.username && verifyPassword(password, admin);\n  }\n  return username === config.adminUsername && safeEqual(password, config.adminPassword);\n}",
    "async function verifyAdminCredentials(username, password) {\n  if (config.adminPassword && username === config.adminUsername && safeEqual(password, config.adminPassword)) {\n    return true;\n  }\n  const admin = appSettings.admin;\n  if (admin?.passwordHash && admin?.passwordSalt) {\n    return username === admin.username && verifyPassword(password, admin);\n  }\n  return username === config.adminUsername && safeEqual(password, config.adminPassword);\n}"
  )
  .replace(/password\.length < 10/g, "password.length < 8")
  .replace(/at least 10 characters/g, "at least 8 characters");

const appModule = new Module(serverPath, module.parent);
appModule.filename = serverPath;
appModule.paths = Module._nodeModulePaths(__dirname);
appModule._compile(source, serverPath);
