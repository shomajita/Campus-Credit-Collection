"use strict";

const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const http = require("node:http");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = process.env.STORAGE_DIR || ROOT;
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_DIR, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(STORAGE_DIR, "uploads");
const STORE_PATH = path.join(DATA_DIR, "applications.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const LOCAL_SPREADSHEET_PATH = process.env.LOCAL_SPREADSHEET_PATH || path.join(DATA_DIR, "loan_applications.csv");

loadEnv(path.join(ROOT, ".env"));

const config = {
  port: toInt(process.env.PORT, 4173),
  publicAppUrl: trimSlash(process.env.PUBLIC_APP_URL || defaultPublicAppUrl()),
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  sessionHours: toInt(process.env.SESSION_HOURS, 8),
  maxFileBytes: toInt(process.env.MAX_FILE_MB, 8) * 1024 * 1024,
  minLoanAmount: toNumber(process.env.MIN_LOAN_AMOUNT, 100),
  maxLoanAmount: toNumber(process.env.MAX_LOAN_AMOUNT, 1000),
  standardInterestRate: toNumber(process.env.DEFAULT_INTEREST_RATE, 0.3),
  lateInterestRate: toNumber(process.env.LATE_MONTH_INTEREST_RATE, 0.25),
  repaymentDueDay: toInt(process.env.REPAYMENT_DUE_DAY, 27),
  ownerWhatsappTo: process.env.OWNER_WHATSAPP_TO || "",
  ownerEmail: process.env.OWNER_EMAIL || "",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioWhatsappFrom: process.env.TWILIO_WHATSAPP_FROM || "",
  whatsappWebhookUrl: process.env.WHATSAPP_WEBHOOK_URL || "",
  sendgridApiKey: process.env.SENDGRID_API_KEY || "",
  alertFromEmail: process.env.ALERT_FROM_EMAIL || "",
  emailWebhookUrl: process.env.EMAIL_WEBHOOK_URL || "",
  googleSheetId: process.env.GOOGLE_SHEET_ID || "",
  googleSheetTab: process.env.GOOGLE_SHEET_TAB || "Loans",
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  googlePrivateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || "")
};

let generatedAdminPassword = false;
if (!config.adminPassword) {
  config.adminPassword = crypto.randomBytes(18).toString("base64url");
  generatedAdminPassword = true;
}

const sessions = new Map();
const rateBuckets = new Map();
let storeQueue = Promise.resolve();
let settingsQueue = Promise.resolve();
let appSettings = {};

const loanCategories = [
  { id: "standard", label: "Standard 30%", rateKey: "standardInterestRate", startDay: 1, endDay: 31 },
  { id: "late-month", label: "Late Month 25%", rateKey: "lateInterestRate", startDay: 15, endDay: 31 }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  res.on("error", (error) => {
    console.error("Response error:", error);
  });
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    const message = status >= 500 ? "Something went wrong. Please try again." : error.message;
    sendJson(res, status, { error: message });
  });
});

bootstrap().then(() => {
  server.listen(config.port, () => {
    console.log(`Loan Management app running at http://localhost:${config.port}`);
  });
});

async function bootstrap() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await recoverLegacyStorage();
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, "[]\n", "utf8");
  }
  appSettings = await readSettings();
  await refreshLocalSpreadsheet();
  if (generatedAdminPassword && !appSettings.admin?.passwordHash) {
    console.warn("");
    console.warn("ADMIN_PASSWORD is not set. A temporary development password was generated:");
    console.warn(`  username: ${config.adminUsername}`);
    console.warn(`  password: ${config.adminPassword}`);
    console.warn("Log in and set your own credentials from Admin Security.");
    console.warn("");
  }
}

async function recoverLegacyStorage() {
  const legacyDataDirs = uniquePaths([
    path.join(ROOT, "data"),
    path.join(ROOT, "runtime-data", "data")
  ]).filter((dir) => path.resolve(dir) !== path.resolve(DATA_DIR));
  const legacyUploadDirs = uniquePaths([
    path.join(ROOT, "uploads"),
    path.join(ROOT, "runtime-data", "uploads")
  ]).filter((dir) => path.resolve(dir) !== path.resolve(UPLOAD_DIR));

  const currentApplications = await readJsonFile(STORE_PATH, []);
  const byId = new Map(currentApplications.map((application) => [application?.id, application]).filter(([id]) => id));
  let recoveredCount = 0;

  for (const dir of legacyDataDirs) {
    const legacyApplications = await readJsonFile(path.join(dir, "applications.json"), []);
    if (!Array.isArray(legacyApplications) || !legacyApplications.length) continue;
    for (const application of legacyApplications) {
      if (!application?.id || byId.has(application.id)) continue;
      byId.set(application.id, application);
      recoveredCount += 1;
    }
  }

  if (recoveredCount > 0) {
    const merged = Array.from(byId.values()).sort((left, right) => {
      return String(right.submittedAt || "").localeCompare(String(left.submittedAt || ""));
    });
    await writeApplications(merged);
    console.warn(`Recovered ${recoveredCount} loan application(s) from legacy storage folders.`);
  } else {
    try {
      await fs.access(STORE_PATH);
    } catch {
      await fs.writeFile(STORE_PATH, "[]\n", "utf8");
    }
  }

  for (const dir of legacyUploadDirs) {
    await copyMissingUploads(dir, UPLOAD_DIR);
  }

  await recoverSettings(legacyDataDirs);
}

async function recoverSettings(legacyDataDirs) {
  try {
    await fs.access(SETTINGS_PATH);
    return;
  } catch {}

  for (const dir of legacyDataDirs) {
    const legacyPath = path.join(dir, "settings.json");
    const settings = await readJsonFile(legacyPath, null);
    if (!settings || typeof settings !== "object") continue;
    await writeSettings(settings);
    console.warn("Recovered admin/client settings from legacy storage.");
    return;
  }
}

async function copyMissingUploads(sourceDir, destinationDir) {
  let entries = [];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }

  await fs.mkdir(destinationDir, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    try {
      await fs.copyFile(sourcePath, destinationPath, fsSync.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (copied > 0) {
    console.warn(`Recovered ${copied} upload file(s) from ${sourceDir}.`);
  }
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const today = new Date();
    sendJson(res, 200, {
      interestRate: config.standardInterestRate,
      minLoanAmount: config.minLoanAmount,
      maxLoanAmount: config.maxLoanAmount,
      maxFileMb: Math.round(config.maxFileBytes / 1024 / 1024),
      repaymentDueDay: config.repaymentDueDay,
      repaymentDueDate: formatDate(calculateRepaymentDueDate(today)),
      loanCategories: getLoanCategoriesForClient(today),
      applicationsOpen: loanCategories.some((category) => isCategoryOpen(category, today))
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/client/session") {
    await getClientSessionInfo(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client/login") {
    assertRateLimit(req, "client-login", 12, 15 * 60 * 1000);
    await loginClient(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    logoutSession(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/applications") {
    requireClient(req);
    assertRateLimit(req, "submit", 8, 15 * 60 * 1000);
    await createApplication(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/applications/status") {
    requireClient(req);
    assertRateLimit(req, "status", 20, 15 * 60 * 1000);
    await lookupApplicationStatus(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    const session = getAdminSession(req);
    sendJson(res, 200, session ? { authenticated: true, username: session.username, csrfToken: session.csrfToken, adminUsername: getAdminUsername() } : { authenticated: false, adminUsername: getAdminUsername() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    assertRateLimit(req, "login", 10, 15 * 60 * 1000);
    await loginAdmin(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    requireCsrf(req);
    const sid = readCookie(req, "sid");
    if (sid) sessions.delete(sid);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/settings") {
    requireAdmin(req);
    sendJson(res, 200, {
      adminUsername: getAdminUsername(),
      credentialSource: appSettings.admin?.passwordHash ? "dashboard" : "environment"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/credentials") {
    requireCsrf(req);
    await updateAdminCredentials(req, res);
    return;
  }

  if (url.pathname === "/api/admin/applications" && req.method === "GET") {
    requireAdmin(req);
    const applications = await readApplications();
    sendJson(res, 200, { applications: applications.map(toAdminApplication) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/spreadsheet") {
    requireAdmin(req);
    await sendLocalSpreadsheet(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/spreadsheet/rebuild") {
    requireCsrf(req);
    await rebuildLocalSpreadsheet(res);
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/files\/(identity|student|photo|signature)$/);
  if (fileMatch && req.method === "GET") {
    requireAdmin(req);
    await sendProtectedFile(res, fileMatch[1], fileMatch[2]);
    return;
  }

  const approveMatch = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/);
  if (approveMatch && req.method === "POST") {
    requireCsrf(req);
    await approveApplication(res, approveMatch[1]);
    return;
  }

  const rejectMatch = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === "POST") {
    requireCsrf(req);
    await rejectApplication(res, rejectMatch[1]);
    return;
  }

  const syncMatch = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/sync-sheet$/);
  if (syncMatch && req.method === "POST") {
    requireCsrf(req);
    await syncApplicationToSheet(res, syncMatch[1], true);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, url.pathname);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function createApplication(req, res) {
  const clientSession = requireClient(req);
  const contentLength = Number(req.headers["content-length"] || 0);
  const maxBodyBytes = config.maxFileBytes * 3 + 2 * 1024 * 1024;
  if (contentLength > maxBodyBytes) {
    throw httpError(413, `Total upload size cannot exceed ${Math.round(maxBodyBytes / 1024 / 1024)}MB.`);
  }

  const form = await readFormData(req);
  const submittedDate = new Date();
  const input = {
    applicantType: normalizeApplicantType(form.get("applicantType")),
    clientEmail: clientSession.email,
    fullName: cleanText(form.get("fullName"), 120),
    studentId: cleanText(form.get("studentId"), 50),
    phone: cleanText(form.get("phone"), 30),
    motherKinName: cleanText(form.get("motherKinName"), 120),
    motherKinPhone: cleanText(form.get("motherKinPhone"), 30),
    fatherKinName: cleanText(form.get("fatherKinName"), 120),
    fatherKinPhone: cleanText(form.get("fatherKinPhone"), 30),
    campusAddress: cleanText(form.get("campusAddress"), 300),
    homeAddress: cleanText(form.get("homeAddress"), 300),
    googleMapsLocation: cleanText(form.get("googleMapsLocation"), 500),
    loanCategory: cleanText(form.get("loanCategory"), 40),
    loanAmount: toNumber(form.get("loanAmount"), 0),
    declarationAccepted: form.get("declarationAccepted") === "on" || form.get("declarationAccepted") === "true",
    signatureData: typeof form.get("signatureData") === "string" ? form.get("signatureData") : ""
  };

  const terms = getLoanTerms(input.loanCategory, submittedDate);
  const errors = validateApplicationInput(input, terms, submittedDate);
  const identityFile = form.get("identityDocument");
  const studentFile = form.get("studentDocument");
  const photoFile = form.get("clientPhoto");

  if (!isUploadFile(identityFile)) errors.push("Identity document photo is required.");
  if (!isUploadFile(studentFile)) errors.push("Student ID photo is required.");
  if (!isUploadFile(photoFile)) errors.push("Client photo is required.");
  if (!input.signatureData) errors.push("Client signature is required.");

  if (errors.length) {
    sendJson(res, 400, { error: errors.join(" ") });
    return;
  }

  const applicationId = crypto.randomUUID();
  const identityDocument = await storeUpload(applicationId, "identity", identityFile);
  const studentDocument = await storeUpload(applicationId, "student", studentFile);
  const clientPhoto = await storeUpload(applicationId, "photo", photoFile, { imageOnly: true });
  const signatureDocument = await storeSignature(applicationId, input.signatureData);
  const interestAmount = roundMoney(input.loanAmount * terms.rate);
  const totalRepayment = roundMoney(input.loanAmount + interestAmount);
  const dueDate = calculateRepaymentDueDate(submittedDate);
  const submittedAt = submittedDate.toISOString();

  const application = {
    id: applicationId,
    submittedAt,
    applicantType: input.applicantType,
    applicantTypeLabel: applicantTypeLabel(input.applicantType),
    clientEmail: input.clientEmail,
    fullName: input.fullName,
    studentId: input.studentId,
    phone: input.phone,
    motherKinName: input.motherKinName,
    motherKinPhone: input.motherKinPhone,
    fatherKinName: input.fatherKinName,
    fatherKinPhone: input.fatherKinPhone,
    nextOfKin: {
      mother: {
        name: input.motherKinName,
        phone: input.motherKinPhone
      },
      father: {
        name: input.fatherKinName,
        phone: input.fatherKinPhone
      }
    },
    campusAddress: input.campusAddress,
    homeAddress: input.homeAddress,
    googleMapsLocation: input.googleMapsLocation,
    loanCategory: terms.id,
    loanCategoryLabel: terms.label,
    loanAmount: roundMoney(input.loanAmount),
    interestRate: terms.rate,
    interestAmount,
    totalRepayment,
    repaymentDueDate: formatDate(dueDate),
    declarationAccepted: true,
    declarationAcceptedAt: submittedAt,
    status: "Pending",
    paid: false,
    documents: {
      identity: identityDocument,
      student: studentDocument,
      photo: clientPhoto,
      signature: signatureDocument
    },
    notifications: {
      whatsapp: { status: "pending" },
      email: { status: "pending" }
    },
    sheetSync: {
      status: "pending"
    }
  };

  await withApplications(async (applications) => {
    applications.unshift(application);
    return application;
  });
  await refreshLocalSpreadsheet();

  const [whatsappResult, emailResult] = await Promise.all([
    sendWhatsappNotification(application),
    sendEmailAlert(application)
  ]);

  await withApplications(async (applications) => {
    const saved = applications.find((item) => item.id === application.id);
    if (saved) {
      saved.notifications.whatsapp = whatsappResult;
      saved.notifications.email = emailResult;
    }
    return saved;
  });
  await refreshLocalSpreadsheet();

  sendJson(res, 201, {
    ok: true,
    applicationId,
    status: toClientStatus(application),
    interestAmount,
    totalRepayment,
    repaymentDueDate: application.repaymentDueDate,
    loanCategory: application.loanCategory,
    interestRate: application.interestRate,
    notificationStatus: {
      whatsapp: whatsappResult.status,
      email: emailResult.status
    }
  });
}

async function lookupApplicationStatus(req, res) {
  const clientSession = requireClient(req);
  const body = await readJson(req);
  const applicationId = cleanText(body.applicationId, 80);
  const studentId = cleanText(body.studentId, 50);
  const phone = cleanText(body.phone, 30);
  const errors = [];

  if (!phone || normalizePhone(phone).length < 7) errors.push("Phone number is required.");
  if (!applicationId && !studentId) errors.push("Enter your application reference or student ID number.");
  if (errors.length) {
    sendJson(res, 400, { error: errors.join(" ") });
    return;
  }

  const applications = await readApplications();
  const normalizedPhone = normalizePhone(phone);
  const matches = applications
    .filter((application) => {
      if (application.clientEmail && normalizeEmail(application.clientEmail) !== clientSession.email) return false;
      if (normalizePhone(application.phone) !== normalizedPhone) return false;
      if (applicationId && application.id === applicationId) return true;
      return studentId && cleanText(application.studentId, 50).toLowerCase() === studentId.toLowerCase();
    })
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));

  if (!matches.length) {
    sendJson(res, 404, { error: "No matching application was found. Check the reference, student ID, and phone number." });
    return;
  }

  sendJson(res, 200, { ok: true, application: toClientStatus(matches[0]) });
}

async function getClientSessionInfo(req, res) {
  const session = getClientSession(req);
  if (!session) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  sendJson(res, 200, {
    authenticated: true,
    email: session.email,
    csrfToken: session.csrfToken,
    latestApplication: await latestClientApplication(session.email)
  });
}

async function loginClient(req, res) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const errors = validateClientCredentialInput(email, password);

  if (errors.length) {
    sendJson(res, 400, { error: errors.join(" ") });
    return;
  }

  const now = new Date().toISOString();
  let outcome = null;
  await withSettings(async (settings) => {
    settings.clients ||= {};
    const existing = settings.clients[email];
    if (existing) {
      if (!verifyPassword(password, existing)) {
        outcome = { ok: false, error: "Invalid client credentials." };
        return existing;
      }
      existing.lastLoginAt = now;
      outcome = { ok: true, created: false };
      appSettings = settings;
      return existing;
    }

    const passwordRecord = hashPassword(password);
    settings.clients[email] = {
      email,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      passwordIterations: passwordRecord.iterations,
      passwordAlgorithm: passwordRecord.algorithm,
      createdAt: now,
      lastLoginAt: now
    };
    outcome = { ok: true, created: true };
    appSettings = settings;
    return settings.clients[email];
  });

  if (!outcome?.ok) {
    sendJson(res, 401, { error: outcome?.error || "Invalid client credentials." });
    return;
  }

  const sid = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + config.sessionHours * 60 * 60 * 1000;
  sessions.set(sid, { type: "client", email, csrfToken, expiresAt });
  setSessionCookie(res, sid);
  sendJson(res, 200, {
    ok: true,
    email,
    csrfToken,
    created: Boolean(outcome.created),
    latestApplication: await latestClientApplication(email)
  });
}

async function loginAdmin(req, res) {
  const body = await readJson(req);
  const username = cleanText(body.username, 80);
  const password = typeof body.password === "string" ? body.password : "";

  if (!(await verifyAdminCredentials(username, password))) {
    sendJson(res, 401, { error: "Invalid admin credentials." });
    return;
  }

  const sid = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + config.sessionHours * 60 * 60 * 1000;
  sessions.set(sid, { type: "admin", username, csrfToken, expiresAt });
  setSessionCookie(res, sid);
  sendJson(res, 200, { ok: true, username, csrfToken });
}

async function updateAdminCredentials(req, res) {
  const session = getSession(req);
  const body = await readJson(req);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newUsername = cleanText(body.username, 80);
  const newPassword = typeof body.password === "string" ? body.password : "";

  if (!(await verifyAdminCredentials(session.username, currentPassword))) {
    sendJson(res, 401, { error: "Current password is incorrect." });
    return;
  }

  const errors = validateAdminCredentialInput(newUsername, newPassword);
  if (errors.length) {
    sendJson(res, 400, { error: errors.join(" ") });
    return;
  }

  const passwordRecord = hashPassword(newPassword);
  const updatedAt = new Date().toISOString();
  await withSettings(async (settings) => {
    settings.admin = {
      username: newUsername,
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      passwordIterations: passwordRecord.iterations,
      passwordAlgorithm: passwordRecord.algorithm,
      updatedAt
    };
    appSettings = settings;
    return settings.admin;
  });

  session.username = newUsername;
  sendJson(res, 200, { ok: true, username: newUsername, updatedAt });
}

async function approveApplication(res, applicationId) {
  const app = await withApplications(async (applications) => {
    const application = applications.find((item) => item.id === applicationId);
    if (!application) return null;
    if (application.status !== "Approved") {
      application.status = "Approved";
      application.approvedAt = new Date().toISOString();
      application.sheetSync = { status: "pending", provider: "local_spreadsheet" };
    }
    return application;
  });

  if (!app) {
    sendJson(res, 404, { error: "Application not found." });
    return;
  }

  const spreadsheetResult = await refreshLocalSpreadsheet();
  const updated = await withApplications(async (applications) => {
    const saved = applications.find((item) => item.id === applicationId);
    if (saved) saved.sheetSync = spreadsheetResult;
    return saved;
  });
  sendJson(res, 200, { ok: true, application: toAdminApplication(updated) });
}

async function rejectApplication(res, applicationId) {
  const app = await withApplications(async (applications) => {
    const application = applications.find((item) => item.id === applicationId);
    if (!application) return null;
    if (application.status === "Approved") return { locked: true, application };
    if (application.status !== "Rejected") {
      application.status = "Rejected";
      application.rejectedAt = new Date().toISOString();
      application.sheetSync = { status: "pending", provider: "local_spreadsheet" };
    }
    return application;
  });

  if (!app) {
    sendJson(res, 404, { error: "Application not found." });
    return;
  }

  if (app.locked) {
    sendJson(res, 400, { error: "Approved applications cannot be rejected." });
    return;
  }

  const spreadsheetResult = await refreshLocalSpreadsheet();
  const updated = await withApplications(async (applications) => {
    const saved = applications.find((item) => item.id === applicationId);
    if (saved) saved.sheetSync = spreadsheetResult;
    return saved;
  });
  sendJson(res, 200, { ok: true, application: toAdminApplication(updated) });
}

async function syncApplicationToSheet(res, applicationId, forceRetry) {
  requireSheetRetryAllowed(forceRetry);
  const application = await syncApplication(applicationId, forceRetry);
  if (!application) {
    sendJson(res, 404, { error: "Application not found." });
    return;
  }
  sendJson(res, 200, { ok: true, application: toAdminApplication(application) });
}

function requireSheetRetryAllowed(forceRetry) {
  if (!forceRetry) return;
}

async function syncApplication(applicationId, forceRetry) {
  const application = (await readApplications()).find((item) => item.id === applicationId);
  if (!application) return null;

  if (application.sheetSync?.status === "saved" && !forceRetry) {
    return application;
  }

  const result = await refreshLocalSpreadsheet();
  return withApplications(async (applications) => {
    const saved = applications.find((item) => item.id === applicationId);
    if (!saved) return null;
    saved.sheetSync = result;
    return saved;
  });
}

async function sendProtectedFile(res, applicationId, slot) {
  const applications = await readApplications();
  const application = applications.find((item) => item.id === applicationId);
  const document = application?.documents?.[slot];
  if (!document) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  const absolutePath = path.join(UPLOAD_DIR, document.storedName);
  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    sendJson(res, 400, { error: "Invalid file path." });
    return;
  }

  const fileBuffer = await fs.readFile(resolved);
  res.writeHead(200, {
    "Content-Type": document.mimeType,
    "Content-Length": fileBuffer.length,
    "Content-Disposition": `inline; filename="${sanitizeHeaderFilename(document.originalName)}"`,
    "Cache-Control": "private, no-store"
  });
  res.end(fileBuffer);
}

async function sendLocalSpreadsheet(res) {
  await refreshLocalSpreadsheet();
  const fileBuffer = await fs.readFile(LOCAL_SPREADSHEET_PATH);
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Length": fileBuffer.length,
    "Content-Disposition": 'attachment; filename="loan_applications.csv"',
    "Cache-Control": "private, no-store"
  });
  res.end(fileBuffer);
}

async function rebuildLocalSpreadsheet(res) {
  const result = await refreshLocalSpreadsheet();
  sendJson(res, 200, { ok: true, spreadsheet: result });
}

async function refreshLocalSpreadsheet() {
  const applications = await readApplications();
  await writeLocalSpreadsheet(applications);
  return {
    status: "saved",
    provider: "local_spreadsheet",
    savedAt: new Date().toISOString(),
    path: LOCAL_SPREADSHEET_PATH,
    rows: applications.length
  };
}

async function writeLocalSpreadsheet(applications) {
  const rows = [localSpreadsheetHeaders(), ...applications.slice().reverse().map(toLocalSpreadsheetRow)];
  const csv = `${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}\r\n`;
  const tempPath = `${LOCAL_SPREADSHEET_PATH}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(LOCAL_SPREADSHEET_PATH), { recursive: true });
  await fs.writeFile(tempPath, csv, "utf8");
  await fs.rename(tempPath, LOCAL_SPREADSHEET_PATH);
}

function localSpreadsheetHeaders() {
  return [
    "Application ID",
    "Submitted At",
    "Approved At",
    "Applicant Type",
    "Name",
    "Applicant ID",
    "Phone",
    "Next of Kin Mother",
    "Mother Phone",
    "Next of Kin Father",
    "Father Phone",
    "Current Campus/Workplace Address",
    "Home Address",
    "Google Maps Location",
    "Loan Category",
    "Amount Out",
    "Percentage",
    "Interest",
    "Amount In",
    "Repayment Due Date",
    "Declaration Accepted",
    "Declaration Accepted At",
    "Status",
    "Paid",
    "Client Photo Link",
    "Omang/Passport Link",
    "Student ID Link",
    "Signature Link",
    "WhatsApp Notification",
    "Email Notification"
  ];
}

function toLocalSpreadsheetRow(application) {
  const links = protectedDocumentLinks(application);
  return [
    application.id,
    application.submittedAt,
    application.approvedAt || "",
    application.applicantTypeLabel || applicantTypeLabel(application.applicantType),
    application.fullName,
    application.studentId,
    application.phone,
    application.motherKinName || application.nextOfKin?.mother?.name || "",
    application.motherKinPhone || application.nextOfKin?.mother?.phone || "",
    application.fatherKinName || application.nextOfKin?.father?.name || "",
    application.fatherKinPhone || application.nextOfKin?.father?.phone || "",
    application.campusAddress,
    application.homeAddress,
    application.googleMapsLocation || "",
    application.loanCategoryLabel || formatPercent(application.interestRate || config.standardInterestRate),
    application.loanAmount,
    `${Math.round((application.interestRate || 0) * 100)}%`,
    application.interestAmount,
    application.totalRepayment,
    application.repaymentDueDate,
    application.declarationAccepted ? "TRUE" : "FALSE",
    application.declarationAcceptedAt || "",
    application.status,
    application.paid ? "TRUE" : "FALSE",
    links.photo,
    links.identity,
    links.student,
    links.signature,
    application.notifications?.whatsapp?.status || "",
    application.notifications?.email?.status || ""
  ];
}

function protectedDocumentLinks(application) {
  const documents = application.documents || {};
  const base = `${config.publicAppUrl}/api/admin/applications/${application.id}/files`;
  return {
    photo: documents.photo ? `${base}/photo` : "",
    identity: documents.identity ? `${base}/identity` : "",
    student: documents.student ? `${base}/student` : "",
    signature: documents.signature ? `${base}/signature` : ""
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function sendWhatsappNotification(application) {
  const message = `New Loan Request from ${application.fullName} for ${formatMoney(application.loanAmount)} Pula. Check dashboard for approval.`;

  if (config.twilioAccountSid && config.twilioAuthToken && config.twilioWhatsappFrom && config.ownerWhatsappTo) {
    try {
      const params = new URLSearchParams({
        From: config.twilioWhatsappFrom,
        To: config.ownerWhatsappTo,
        Body: message
      });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });
      if (!response.ok) throw new Error(await response.text());
      const body = await response.json();
      return { status: "sent", provider: "twilio", sid: body.sid, sentAt: new Date().toISOString() };
    } catch (error) {
      return { status: "failed", provider: "twilio", error: cleanError(error) };
    }
  }

  if (config.whatsappWebhookUrl) {
    try {
      const response = await fetch(config.whatsappWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "whatsapp",
          to: config.ownerWhatsappTo,
          message,
          application: notificationApplicationSummary(application)
        })
      });
      if (!response.ok) throw new Error(await response.text());
      return { status: "sent", provider: "webhook", sentAt: new Date().toISOString() };
    } catch (error) {
      return { status: "failed", provider: "webhook", error: cleanError(error) };
    }
  }

  return { status: "not_configured", message, provider: "none" };
}

async function sendEmailAlert(application) {
  const subject = `New loan request: ${application.fullName} - ${formatMoney(application.loanAmount)} Pula`;
  const text = [
    `New Loan Request from ${application.fullName}`,
    "",
    `Applicant Type: ${application.applicantTypeLabel || applicantTypeLabel(application.applicantType)}`,
    `Applicant ID: ${application.studentId}`,
    `Phone: ${application.phone}`,
    `Next of Kin (Mother): ${application.motherKinName || application.nextOfKin?.mother?.name || ""}`,
    `Mother Phone: ${application.motherKinPhone || application.nextOfKin?.mother?.phone || ""}`,
    `Next of Kin (Father): ${application.fatherKinName || application.nextOfKin?.father?.name || ""}`,
    `Father Phone: ${application.fatherKinPhone || application.nextOfKin?.father?.phone || ""}`,
    `Current Campus/Workplace Address: ${application.campusAddress}`,
    `Home Address: ${application.homeAddress}`,
    `Google Maps Location: ${application.googleMapsLocation}`,
    `Loan Category: ${application.loanCategoryLabel || formatPercent(application.interestRate)}`,
    `Loan Amount: ${formatMoney(application.loanAmount)} Pula`,
    `Interest: ${formatMoney(application.interestAmount)} Pula (${formatPercent(application.interestRate)})`,
    `Total Repayment: ${formatMoney(application.totalRepayment)} Pula`,
    `Repayment Due Date: ${application.repaymentDueDate}`,
    `Declaration Accepted: ${application.declarationAccepted ? "Yes" : "No"}`,
    "",
    `Review dashboard: ${config.publicAppUrl}/#admin`
  ].join("\n");

  if (config.sendgridApiKey && config.ownerEmail && config.alertFromEmail) {
    try {
      const attachments = await Promise.all(Object.values(application.documents).filter(Boolean).map(toSendGridAttachment));
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.sendgridApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: config.ownerEmail }] }],
          from: { email: config.alertFromEmail },
          subject,
          content: [{ type: "text/plain", value: text }],
          attachments
        })
      });
      if (!response.ok) throw new Error(await response.text());
      return { status: "sent", provider: "sendgrid", sentAt: new Date().toISOString() };
    } catch (error) {
      return { status: "failed", provider: "sendgrid", error: cleanError(error) };
    }
  }

  if (config.emailWebhookUrl) {
    try {
      const response = await fetch(config.emailWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "email",
          to: config.ownerEmail,
          subject,
          text,
          application: notificationApplicationSummary(application),
          documentLinks: {
            identity: `${config.publicAppUrl}/api/admin/applications/${application.id}/files/identity`,
            student: `${config.publicAppUrl}/api/admin/applications/${application.id}/files/student`,
            photo: `${config.publicAppUrl}/api/admin/applications/${application.id}/files/photo`,
            signature: `${config.publicAppUrl}/api/admin/applications/${application.id}/files/signature`
          }
        })
      });
      if (!response.ok) throw new Error(await response.text());
      return { status: "sent", provider: "webhook", sentAt: new Date().toISOString() };
    } catch (error) {
      return { status: "failed", provider: "webhook", error: cleanError(error) };
    }
  }

  return { status: "not_configured", subject, preview: text, provider: "none" };
}

async function appendToGoogleSheet(application) {
  if (!config.googleSheetId || !config.googleServiceAccountEmail || !config.googlePrivateKey) {
    return {
      status: "not_configured",
      message: "Google Sheets credentials are not configured. Add service account values to .env and retry sync."
    };
  }

  try {
    const token = await getGoogleAccessToken();
    const nextRow = await getNextSheetRow(token);
    const range = `${config.googleSheetTab}!A:I`;
    const values = [[
      formatDate(new Date(application.approvedAt || application.submittedAt)),
      application.fullName,
      application.studentId,
      application.loanAmount,
      `${Math.round(application.interestRate * 100)}%`,
      `=D${nextRow}*E${nextRow}`,
      `=D${nextRow}+F${nextRow}`,
      "Approved",
      "FALSE"
    ]];

    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values })
    });

    if (!response.ok) throw new Error(await response.text());
    const body = await response.json();
    return {
      status: "synced",
      provider: "google_sheets",
      syncedAt: new Date().toISOString(),
      updatedRange: body.updates?.updatedRange || "",
      nextRow
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "google_sheets",
      error: cleanError(error),
      failedAt: new Date().toISOString()
    };
  }
}

async function getNextSheetRow(token) {
  const range = `${config.googleSheetTab}!A:A`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) throw new Error(await response.text());
  const body = await response.json();
  return (body.values?.length || 0) + 1;
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: config.googleServiceAccountEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), config.googlePrivateKey).toString("base64url");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) throw new Error(await response.text());
  const body = await response.json();
  return body.access_token;
}

async function toSendGridAttachment(document) {
  const fileBuffer = await fs.readFile(path.join(UPLOAD_DIR, document.storedName));
  return {
    content: fileBuffer.toString("base64"),
    filename: document.originalName,
    type: document.mimeType,
    disposition: "attachment"
  };
}

function notificationApplicationSummary(application) {
  return {
    id: application.id,
    submittedAt: application.submittedAt,
    applicantType: application.applicantType || "student",
    applicantTypeLabel: application.applicantTypeLabel || applicantTypeLabel(application.applicantType),
    fullName: application.fullName,
    studentId: application.studentId,
    phone: application.phone,
    motherKinName: application.motherKinName || application.nextOfKin?.mother?.name || "",
    motherKinPhone: application.motherKinPhone || application.nextOfKin?.mother?.phone || "",
    fatherKinName: application.fatherKinName || application.nextOfKin?.father?.name || "",
    fatherKinPhone: application.fatherKinPhone || application.nextOfKin?.father?.phone || "",
    campusAddress: application.campusAddress,
    homeAddress: application.homeAddress,
    googleMapsLocation: application.googleMapsLocation,
    loanCategory: application.loanCategory,
    loanCategoryLabel: application.loanCategoryLabel,
    loanAmount: application.loanAmount,
    interestAmount: application.interestAmount,
    totalRepayment: application.totalRepayment,
    repaymentDueDate: application.repaymentDueDate,
    declarationAccepted: Boolean(application.declarationAccepted)
  };
}

function toClientStatus(application) {
  const statusLabel = application.status === "Pending" ? "In Progress" : application.status;
  const messages = {
    Pending: "Your application has been received and is waiting for review.",
    Approved: "Your application has been approved. Please follow the repayment terms shown here.",
    Rejected: "Your application was not approved. Contact STUCHA Loans if you need more information."
  };
  return {
    applicationId: application.id,
    submittedAt: application.submittedAt,
    applicantType: application.applicantType || "student",
    applicantTypeLabel: application.applicantTypeLabel || applicantTypeLabel(application.applicantType),
    fullName: application.fullName,
    loanAmount: application.loanAmount,
    interestAmount: application.interestAmount,
    totalRepayment: application.totalRepayment,
    repaymentDueDate: application.repaymentDueDate,
    loanCategoryLabel: application.loanCategoryLabel || formatPercent(application.interestRate || config.standardInterestRate),
    status: application.status,
    statusLabel,
    message: messages[application.status] || messages.Pending
  };
}

async function latestClientApplication(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const applications = await readApplications();
  const match = applications
    .filter((application) => normalizeEmail(application.clientEmail) === normalizedEmail)
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))[0];
  return match ? toClientStatus(match) : null;
}

function validateApplicationInput(input, terms, submittedDate) {
  const errors = [];
  if (!input.fullName || input.fullName.length < 2) errors.push("Full name is required.");
  if (!input.studentId || input.studentId.length < 2) errors.push("Student ID number is required.");
  if (!input.phone || input.phone.length < 7) errors.push("Phone number is required.");
  if (!input.motherKinName || input.motherKinName.length < 2) errors.push("Next of kin mother name is required.");
  if (!input.motherKinPhone || normalizePhone(input.motherKinPhone).length < 7) errors.push("Mother phone number is required.");
  if (!input.fatherKinName || input.fatherKinName.length < 2) errors.push("Next of kin father name is required.");
  if (!input.fatherKinPhone || normalizePhone(input.fatherKinPhone).length < 7) errors.push("Father phone number is required.");
  if (!input.campusAddress || input.campusAddress.length < 5) errors.push("Current campus/hostel address is required.");
  if (!input.homeAddress || input.homeAddress.length < 5) errors.push("Home address is required.");
  if (!isGoogleMapsUrl(input.googleMapsLocation)) errors.push("A valid Google Maps location link is required.");
  if (!terms) errors.push("A valid loan category is required.");
  if (terms && !isCategoryOpen(terms, submittedDate)) {
    errors.push(`${terms.label} applications are only accepted from day ${terms.startDay} to day ${terms.endDay} of the month.`);
  }
  if (!input.declarationAccepted) errors.push("The debt declaration must be accepted.");
  if (!Number.isFinite(input.loanAmount) || input.loanAmount <= 0) errors.push("Loan amount must be greater than zero.");
  if (input.loanAmount < config.minLoanAmount) errors.push(`Loan amount must be at least ${formatMoney(config.minLoanAmount)} Pula.`);
  if (input.loanAmount > config.maxLoanAmount) errors.push(`Loan amount cannot exceed ${formatMoney(config.maxLoanAmount)} Pula.`);
  return errors;
}

async function storeUpload(applicationId, slot, file, options = {}) {
  if (file.size > config.maxFileBytes) {
    throw httpError(400, `${slot} upload exceeds ${Math.round(config.maxFileBytes / 1024 / 1024)}MB.`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectFileType(buffer);
  if (!detected) {
    throw httpError(400, `${slot} upload must be a JPG, PNG, WEBP, or PDF file.`);
  }
  if (options.imageOnly && !detected.mimeType.startsWith("image/")) {
    throw httpError(400, `${slot} upload must be a JPG, PNG, or WEBP image.`);
  }

  const storedName = `${applicationId}-${slot}-${crypto.randomBytes(12).toString("hex")}${detected.extension}`;
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), buffer, { flag: "wx" });
  return {
    originalName: safeFilename(file.name || `${slot}${detected.extension}`),
    storedName,
    mimeType: detected.mimeType,
    size: buffer.length,
    uploadedAt: new Date().toISOString()
  };
}

async function storeSignature(applicationId, dataUrl) {
  const match = String(dataUrl).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw httpError(400, "Signature must be captured before submission.");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length < 100 || buffer.length > 1024 * 1024) {
    throw httpError(400, "Signature image is invalid.");
  }
  const detected = detectFileType(buffer);
  if (!detected || detected.mimeType !== "image/png") {
    throw httpError(400, "Signature must be a PNG image.");
  }

  const storedName = `${applicationId}-signature-${crypto.randomBytes(12).toString("hex")}.png`;
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), buffer, { flag: "wx" });
  return {
    originalName: "signature.png",
    storedName,
    mimeType: "image/png",
    size: buffer.length,
    uploadedAt: new Date().toISOString()
  };
}

function detectFileType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  if (buffer.length >= 4 && buffer.slice(0, 4).toString("ascii") === "%PDF") {
    return { extension: ".pdf", mimeType: "application/pdf" };
  }
  return null;
}

function getLoanTerms(categoryId, date = new Date()) {
  const category = loanCategories.find((item) => item.id === categoryId);
  if (!category) return null;
  return {
    ...category,
    rate: config[category.rateKey],
    available: isCategoryOpen(category, date)
  };
}

function getLoanCategoriesForClient(date = new Date()) {
  return loanCategories.map((category) => ({
    id: category.id,
    label: category.label,
    rate: config[category.rateKey],
    startDay: category.startDay,
    endDay: category.endDay,
    available: isCategoryOpen(category, date)
  }));
}

function isCategoryOpen(category, date = new Date()) {
  const day = date.getDate();
  const endDay = Math.min(category.endDay, daysInMonth(date));
  return day >= category.startDay && day <= endDay;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function calculateRepaymentDueDate(date = new Date()) {
  const due = new Date(date.getFullYear(), date.getMonth(), config.repaymentDueDay);
  if (date.getDate() > config.repaymentDueDay) {
    due.setMonth(due.getMonth() + 1);
  }

  const day = due.getDay();
  if (day === 6) due.setDate(due.getDate() - 1);
  if (day === 0) due.setDate(due.getDate() - 2);
  return due;
}

function isGoogleMapsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "maps.app.goo.gl" ||
      host === "goo.gl" ||
      host.endsWith(".google.com") ||
      host === "google.com"
    ) && (
      url.pathname.toLowerCase().includes("/maps") ||
      host === "maps.app.goo.gl" ||
      host === "goo.gl" ||
      url.searchParams.has("q")
    );
  } catch {
    return false;
  }
}

async function serveStatic(req, res, rawPath) {
  const requestPath = rawPath === "/" ? "/index.html" : rawPath;
  const decodedPath = decodeURIComponent(requestPath.split("?")[0]);
  const filePath = path.resolve(path.join(PUBLIC_DIR, decodedPath));
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const extension = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const fileBuffer = await fs.readFile(filePath);
    res.end(fileBuffer);
  } catch {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    const fileBuffer = await fs.readFile(indexPath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": fileBuffer.length,
      "Cache-Control": "no-store"
    });
    res.end(fileBuffer);
  }
}

async function readFormData(req) {
  const host = req.headers.host || `localhost:${config.port}`;
  const request = new Request(`http://${host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
  return request.formData();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON.");
  }
}

async function readApplications() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  const tempPath = `${SETTINGS_PATH}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, SETTINGS_PATH);
}

async function writeApplications(applications) {
  const tempPath = `${STORE_PATH}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(applications, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, STORE_PATH);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push(item);
  }
  return unique;
}

async function withApplications(mutator) {
  const next = storeQueue.then(async () => {
    const applications = await readApplications();
    const result = await mutator(applications);
    await writeApplications(applications);
    return result;
  });
  storeQueue = next.catch(() => {});
  return next;
}

async function withSettings(mutator) {
  const next = settingsQueue.then(async () => {
    const settings = await readSettings();
    const result = await mutator(settings);
    await writeSettings(settings);
    return result;
  });
  settingsQueue = next.catch(() => {});
  return next;
}

function toAdminApplication(application) {
  const documents = application.documents || {};
  return {
    id: application.id,
    submittedAt: application.submittedAt,
    approvedAt: application.approvedAt || "",
    applicantType: application.applicantType || "student",
    applicantTypeLabel: application.applicantTypeLabel || applicantTypeLabel(application.applicantType),
    fullName: application.fullName,
    studentId: application.studentId,
    phone: application.phone,
    motherKinName: application.motherKinName || application.nextOfKin?.mother?.name || "",
    motherKinPhone: application.motherKinPhone || application.nextOfKin?.mother?.phone || "",
    fatherKinName: application.fatherKinName || application.nextOfKin?.father?.name || "",
    fatherKinPhone: application.fatherKinPhone || application.nextOfKin?.father?.phone || "",
    nextOfKin: {
      mother: {
        name: application.motherKinName || application.nextOfKin?.mother?.name || "",
        phone: application.motherKinPhone || application.nextOfKin?.mother?.phone || ""
      },
      father: {
        name: application.fatherKinName || application.nextOfKin?.father?.name || "",
        phone: application.fatherKinPhone || application.nextOfKin?.father?.phone || ""
      }
    },
    campusAddress: application.campusAddress,
    homeAddress: application.homeAddress,
    googleMapsLocation: application.googleMapsLocation || "",
    loanCategory: application.loanCategory || "standard",
    loanCategoryLabel: application.loanCategoryLabel || formatPercent(application.interestRate || config.standardInterestRate),
    loanAmount: application.loanAmount,
    interestRate: application.interestRate,
    interestAmount: application.interestAmount,
    totalRepayment: application.totalRepayment,
    repaymentDueDate: application.repaymentDueDate,
    declarationAccepted: Boolean(application.declarationAccepted),
    declarationAcceptedAt: application.declarationAcceptedAt || "",
    status: application.status,
    paid: application.paid,
    notifications: application.notifications,
    sheetSync: normalizeSpreadsheetStatus(application.sheetSync),
    links: {
      identity: `/api/admin/applications/${application.id}/files/identity`,
      student: `/api/admin/applications/${application.id}/files/student`,
      photo: documents.photo ? `/api/admin/applications/${application.id}/files/photo` : "",
      signature: documents.signature ? `/api/admin/applications/${application.id}/files/signature` : "",
      homeMap: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(application.homeAddress)}`,
      googleMapsLocation: application.googleMapsLocation || ""
    },
    documents: {
      identity: documentSummary(documents.identity),
      student: documentSummary(documents.student),
      photo: documentSummary(documents.photo),
      signature: documentSummary(documents.signature)
    }
  };
}

function documentSummary(document) {
  if (!document) return null;
  return {
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size
  };
}

function normalizeSpreadsheetStatus(status) {
  if (status?.provider === "local_spreadsheet" && status.status === "failed") return status;
  return {
    status: "saved",
    provider: "local_spreadsheet",
    path: LOCAL_SPREADSHEET_PATH
  };
}

function requireAdmin(req) {
  const session = getAdminSession(req);
  if (!session) throw httpError(401, "Admin login required.");
  return session;
}

function requireClient(req) {
  const session = getClientSession(req);
  if (!session) throw httpError(401, "Client login required.");
  return session;
}

function requireCsrf(req) {
  const session = requireAdmin(req);
  const token = req.headers["x-csrf-token"];
  if (!token || !safeEqual(String(token), session.csrfToken)) {
    throw httpError(403, "Invalid security token.");
  }
  return session;
}

function getClientSession(req) {
  const session = getSession(req);
  if (!session || session.type !== "client" || !session.email) return null;
  return session;
}

function getAdminSession(req) {
  const session = getSession(req);
  if (!session || session.type !== "admin") return null;
  return session;
}

function logoutSession(req, res) {
  const sid = readCookie(req, "sid");
  const session = sid ? sessions.get(sid) : null;
  const token = req.headers["x-csrf-token"];
  if (session && (!token || !safeEqual(String(token), session.csrfToken))) {
    throw httpError(403, "Invalid security token.");
  }
  if (sid) sessions.delete(sid);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function getAdminUsername() {
  if (config.adminPassword) return config.adminUsername;
  return appSettings.admin?.username || config.adminUsername;
}

async function verifyAdminCredentials(username, password) {
  if (config.adminPassword && username === config.adminUsername && safeEqual(password, config.adminPassword)) {
    return true;
  }
  const admin = appSettings.admin;
  if (admin?.passwordHash && admin?.passwordSalt) {
    return username === admin.username && verifyPassword(password, admin);
  }
  return username === config.adminUsername && safeEqual(password, config.adminPassword);
}

function validateAdminCredentialInput(username, password) {
  const errors = [];
  if (!/^[A-Za-z0-9._@-]{3,80}$/.test(username)) {
    errors.push("Username must be 3-80 characters and use only letters, numbers, dots, underscores, hyphens, or @.");
  }
  if (password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push("Password must include at least one letter and one number.");
  }
  return errors;
}

function validateClientCredentialInput(email, password) {
  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("A valid email address is required.");
  }
  if (password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push("Password must include at least one letter and one number.");
  }
  return errors;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(18).toString("base64url");
  const iterations = 210000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
  return { algorithm: "pbkdf2-sha256", iterations, salt, hash };
}

function verifyPassword(password, admin) {
  const iterations = Number(admin.passwordIterations || 210000);
  const expected = String(admin.passwordHash || "");
  const actual = crypto.pbkdf2Sync(password, String(admin.passwordSalt || ""), iterations, 32, "sha256").toString("base64url");
  return safeEqual(actual, expected);
}

function getSession(req) {
  const sid = readCookie(req, "sid");
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  session.expiresAt = Date.now() + config.sessionHours * 60 * 60 * 1000;
  return session;
}

function setSessionCookie(res, sid) {
  const maxAge = config.sessionHours * 60 * 60;
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function assertRateLimit(req, key, limit, windowMs) {
  const ip = req.socket.remoteAddress || "unknown";
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt < now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  if (bucket.count > limit) throw httpError(429, "Too many attempts. Please wait and try again.");
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

function loadEnv(filePath) {
  try {
    const raw = require("node:fs").readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = unquoteEnv(rawValue.trim());
    }
  } catch {
    // .env is optional.
  }
}

function unquoteEnv(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizePrivateKey(value) {
  return value.replace(/\\n/g, "\n").trim();
}

function defaultPublicAppUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }
  return "http://localhost:4173";
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isUploadFile(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function" && value.size > 0;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeEmail(value) {
  return cleanText(value, 160).toLowerCase();
}

function normalizeApplicantType(value) {
  return String(value || "").toLowerCase() === "worker" ? "worker" : "student";
}

function applicantTypeLabel(value) {
  return normalizeApplicantType(value) === "worker" ? "Worker" : "Student";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return roundMoney(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document";
}

function sanitizeHeaderFilename(value) {
  return safeFilename(value).replace(/"/g, "");
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function cleanError(error) {
  return String(error?.message || error).slice(0, 500);
}
