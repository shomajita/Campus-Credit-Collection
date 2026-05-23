"use strict";

const state = {
  config: {
    interestRate: 0.3,
    minLoanAmount: 100,
    maxLoanAmount: 1000,
    maxFileMb: 8,
    repaymentDueDate: "",
    loanCategories: [
      { id: "standard", label: "Standard 30%", rate: 0.3, startDay: 1, endDay: 27, available: true },
      { id: "late-month", label: "Late Month 25%", rate: 0.25, startDay: 15, endDay: 27, available: false }
    ],
    applicationsOpen: true
  },
  csrfToken: "",
  applications: [],
  signature: {
    drawing: false,
    hasInk: false
  }
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "BWP",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

document.addEventListener("DOMContentLoaded", async () => {
  bindTabs();
  bindCalculator();
  bindForms();
  bindLocation();
  bindSignaturePad();
  await loadConfig();
  applyConfig();
  updateCalculator();
  await checkSession();

  if (location.hash === "#admin") {
    activateTab("admin");
  }
});

function bindTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === tabName);
  });
  history.replaceState(null, "", tabName === "admin" ? "#admin" : "#portal");
}

function bindCalculator() {
  const range = document.querySelector("#loan-range");
  const amount = document.querySelector("#loan-amount");
  const category = document.querySelector("#loan-category");
  range.addEventListener("input", () => {
    amount.value = range.value;
    updateCalculator();
  });
  amount.addEventListener("input", () => {
    const numeric = Number.parseFloat(amount.value || "0");
    if (Number.isFinite(numeric)) {
      range.value = Math.min(Math.max(numeric, Number(range.min)), Number(range.max));
    }
    updateCalculator();
  });
  category.addEventListener("change", updateCalculator);
}

function bindForms() {
  document.querySelector("#loan-form").addEventListener("submit", submitApplication);
  document.querySelector("#login-form").addEventListener("submit", login);
  document.querySelector("#credentials-form").addEventListener("submit", updateCredentials);
  document.querySelector("#logout-button").addEventListener("click", logout);
  document.querySelector("#refresh-queue").addEventListener("click", loadQueue);
  document.querySelector("#rebuild-spreadsheet").addEventListener("click", rebuildSpreadsheet);
}

function bindLocation() {
  document.querySelector("#use-location").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setMessage("#submission-message", "Location is not available in this browser.", "error");
      return;
    }
    setMessage("#submission-message", "Getting current location...", "");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        document.querySelector("#maps-location").value = `https://www.google.com/maps?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
        setMessage("#submission-message", "Google Maps location captured.", "success");
      },
      () => setMessage("#submission-message", "Location permission was not granted.", "error"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function bindSignaturePad() {
  const canvas = document.querySelector("#signature-pad");
  const context = canvas.getContext("2d");
  context.lineWidth = 3;
  context.lineCap = "round";
  context.strokeStyle = "#071526";

  const position = (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = event.touches ? event.touches[0] : event;
    return {
      x: (point.clientX - rect.left) * (canvas.width / rect.width),
      y: (point.clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const start = (event) => {
    event.preventDefault();
    state.signature.drawing = true;
    const { x, y } = position(event);
    context.beginPath();
    context.moveTo(x, y);
  };

  const draw = (event) => {
    if (!state.signature.drawing) return;
    event.preventDefault();
    const { x, y } = position(event);
    context.lineTo(x, y);
    context.stroke();
    state.signature.hasInk = true;
  };

  const stop = () => {
    state.signature.drawing = false;
  };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", draw);
  window.addEventListener("mouseup", stop);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", draw, { passive: false });
  canvas.addEventListener("touchend", stop);

  document.querySelector("#clear-signature").addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    document.querySelector("#signature-data").value = "";
    state.signature.hasInk = false;
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Config could not be loaded.");
    state.config = await response.json();
  } catch {
    setMessage("#submission-message", "Using default calculator settings.", "error");
  }
}

function applyConfig() {
  const range = document.querySelector("#loan-range");
  const amount = document.querySelector("#loan-amount");
  const category = document.querySelector("#loan-category");

  range.min = state.config.minLoanAmount;
  range.max = state.config.maxLoanAmount;
  amount.min = state.config.minLoanAmount;
  amount.max = state.config.maxLoanAmount;
  range.value = state.config.minLoanAmount;
  amount.value = state.config.minLoanAmount;

  category.innerHTML = state.config.loanCategories.map((item) => {
    const disabled = item.available ? "" : "disabled";
    const note = item.available ? "" : ` - opens day ${item.startDay}`;
    return `<option value="${item.id}" ${disabled}>${escapeHtml(item.label)} (${formatDay(item.startDay)} - ${formatDay(item.endDay)})${note}</option>`;
  }).join("");

  const firstAvailable = state.config.loanCategories.find((item) => item.available) || state.config.loanCategories[0];
  category.value = firstAvailable.id;
}

function updateCalculator() {
  const amountInput = document.querySelector("#loan-amount");
  const amount = clampMoney(Number.parseFloat(amountInput.value || "0"));
  const terms = getSelectedTerms();
  const interest = roundMoney(amount * terms.rate);
  const total = roundMoney(amount + interest);
  const dueDisplay = formatDisplayDate(state.config.repaymentDueDate);

  document.querySelector("#interest-amount").textContent = formatMoney(interest);
  document.querySelector("#total-repayment").textContent = formatMoney(total);
  document.querySelector("#due-date").textContent = dueDisplay;
  document.querySelector("#summary-principal").textContent = formatMoney(amount);
  document.querySelector("#summary-interest-rate").textContent = `${Math.round(terms.rate * 100)}%`;
  document.querySelector("#summary-category").textContent = terms.label.replace(/\s*\([^)]*\)/, "");
  document.querySelector("#summary-due-date").textContent = dueDisplay;
}

async function submitApplication(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");

  if (!state.signature.hasInk) {
    setMessage("#submission-message", "Client signature is required.", "error");
    return;
  }

  document.querySelector("#signature-data").value = document.querySelector("#signature-pad").toDataURL("image/png");
  const formData = new FormData(form);

  if (!formData.get("campusAddress") || !formData.get("homeAddress")) {
    setMessage("#submission-message", "Both campus/hostel and home address are required.", "error");
    return;
  }

  if (!formData.get("googleMapsLocation")) {
    setMessage("#submission-message", "Google Maps location is required.", "error");
    return;
  }

  if (!formData.get("declarationAccepted")) {
    setMessage("#submission-message", "Debt declaration must be accepted.", "error");
    return;
  }

  button.disabled = true;
  setMessage("#submission-message", "Submitting application securely...", "");

  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      body: formData
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Submission failed.");

    setMessage(
      "#submission-message",
      `Submitted. Total repayment is ${formatMoney(result.totalRepayment)} due ${result.repaymentDueDate}.`,
      "success"
    );
    form.reset();
    document.querySelector("#clear-signature").click();
    applyConfig();
    updateCalculator();
  } catch (error) {
    setMessage("#submission-message", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function checkSession() {
  const response = await fetch("/api/admin/session");
  const result = await response.json();
  document.querySelector("#login-form input[name='username']").value = result.adminUsername || "admin";
  if (result.authenticated) {
    state.csrfToken = result.csrfToken;
    showDashboard();
    await loadAdminSettings();
    await loadQueue();
  } else {
    showLogin();
  }
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const payload = Object.fromEntries(new FormData(form));
  button.disabled = true;
  setMessage("#login-message", "Checking credentials...", "");

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Login failed.");
    state.csrfToken = result.csrfToken;
    setMessage("#login-message", "", "");
    showDashboard();
    await loadAdminSettings();
    await loadQueue();
  } catch (error) {
    setMessage("#login-message", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function updateCredentials(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const payload = Object.fromEntries(new FormData(form));

  if (payload.password !== payload.confirmPassword) {
    setMessage("#credentials-message", "New passwords do not match.", "error");
    return;
  }

  button.disabled = true;
  setMessage("#credentials-message", "Saving credentials...", "");

  try {
    const response = await fetch("/api/admin/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrfToken
      },
      body: JSON.stringify({
        username: payload.username,
        currentPassword: payload.currentPassword,
        password: payload.password
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update credentials.");
    form.reset();
    document.querySelector("#admin-username").value = result.username;
    document.querySelector("#login-form input[name='username']").value = result.username;
    setMessage("#credentials-message", "Credentials updated.", "success");
  } catch (error) {
    setMessage("#credentials-message", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadAdminSettings() {
  try {
    const response = await fetch("/api/admin/settings");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load settings.");
    document.querySelector("#admin-username").value = result.adminUsername || "admin";
  } catch (error) {
    setMessage("#credentials-message", error.message, "error");
  }
}

async function logout() {
  await fetch("/api/admin/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": state.csrfToken }
  });
  state.csrfToken = "";
  state.applications = [];
  renderQueue();
  showLogin();
}

function showDashboard() {
  document.querySelector("#login-panel").classList.add("hidden");
  document.querySelector("#dashboard-panel").classList.remove("hidden");
}

function showLogin() {
  document.querySelector("#dashboard-panel").classList.add("hidden");
  document.querySelector("#login-panel").classList.remove("hidden");
}

async function loadQueue() {
  const body = document.querySelector("#queue-body");
  body.innerHTML = `<tr><td colspan="14" class="empty-state">Loading applications...</td></tr>`;

  try {
    const response = await fetch("/api/admin/applications");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load applications.");
    state.applications = result.applications;
    renderQueue();
  } catch (error) {
    body.innerHTML = `<tr><td colspan="14" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderQueue() {
  const body = document.querySelector("#queue-body");
  updateSummary();

  if (!state.applications.length) {
    body.innerHTML = `<tr><td colspan="14" class="empty-state">No applications yet.</td></tr>`;
    return;
  }

  body.innerHTML = state.applications.map((application) => `
    <tr>
      <td>
        <input class="approve-check" type="checkbox" aria-label="Approve ${escapeHtml(application.fullName)}" data-approve="${application.id}" ${application.status === "Approved" ? "checked disabled" : ""}>
      </td>
      <td>${formatDateTime(application.submittedAt)}</td>
      <td><strong>${escapeHtml(application.fullName)}</strong></td>
      <td>${escapeHtml(application.studentId)}</td>
      <td>${escapeHtml(application.phone)}</td>
      <td>${escapeHtml(application.loanCategoryLabel || "")}</td>
      <td>${formatMoney(application.loanAmount)}</td>
      <td>${formatMoney(application.totalRepayment)}</td>
      <td>${escapeHtml(application.repaymentDueDate)}</td>
      <td><div class="doc-links">${documentLinks(application)}</div></td>
      <td>
        <div class="doc-links">
          <a href="${application.links.homeMap}" target="_blank" rel="noopener">Home Address</a>
          ${application.links.googleMapsLocation ? `<a href="${escapeHtml(application.links.googleMapsLocation)}" target="_blank" rel="noopener">Google Maps</a>` : ""}
        </div>
      </td>
      <td>${application.declarationAccepted ? '<span class="status-pill good">accepted</span>' : '<span class="status-pill bad">missing</span>'}</td>
      <td>${statusPill(application.status)}</td>
      <td>${sheetStatus(application)}</td>
    </tr>
  `).join("");

  body.querySelectorAll("[data-approve]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => approve(checkbox.dataset.approve, checkbox));
  });

  body.querySelectorAll("[data-sync]").forEach((button) => {
    button.addEventListener("click", () => retrySync(button.dataset.sync, button));
  });
}

function documentLinks(application) {
  const links = [
    ["photo", "Client Photo"],
    ["identity", "Omang/Passport"],
    ["student", "Student ID"],
    ["signature", "Signature"]
  ];
  return links
    .filter(([key]) => application.links[key])
    .map(([key, label]) => `<a href="${application.links[key]}" target="_blank" rel="noopener">${label}</a>`)
    .join("");
}

function updateSummary() {
  const pending = state.applications.filter((item) => item.status !== "Approved").length;
  const approved = state.applications.filter((item) => item.status === "Approved").length;
  const amountOut = state.applications
    .filter((item) => item.status === "Approved")
    .reduce((sum, item) => sum + Number(item.loanAmount || 0), 0);
  const amountIn = state.applications
    .filter((item) => item.status === "Approved")
    .reduce((sum, item) => sum + Number(item.totalRepayment || 0), 0);

  document.querySelector("#pending-count").textContent = pending;
  document.querySelector("#approved-count").textContent = approved;
  document.querySelector("#amount-out-total").textContent = formatMoney(amountOut);
  document.querySelector("#amount-in-total").textContent = formatMoney(amountIn);
}

async function approve(id, checkbox) {
  checkbox.disabled = true;
  try {
    const response = await fetch(`/api/admin/applications/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Approval failed.");
    replaceApplication(result.application);
    renderQueue();
  } catch (error) {
    checkbox.checked = false;
    checkbox.disabled = false;
    alert(error.message);
  }
}

async function retrySync(id, button) {
  button.disabled = true;
  button.textContent = "Syncing";
  try {
    const response = await fetch(`/api/admin/applications/${encodeURIComponent(id)}/sync-sheet`, {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sync failed.");
    replaceApplication(result.application);
    renderQueue();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = "Retry Sync";
  }
}

async function rebuildSpreadsheet() {
  const button = document.querySelector("#rebuild-spreadsheet");
  button.disabled = true;
  button.textContent = "Rebuilding";
  try {
    const response = await fetch("/api/admin/spreadsheet/rebuild", {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not rebuild spreadsheet.");
    await loadQueue();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Rebuild Spreadsheet";
  }
}

function replaceApplication(application) {
  const index = state.applications.findIndex((item) => item.id === application.id);
  if (index >= 0) {
    state.applications[index] = application;
  } else {
    state.applications.unshift(application);
  }
}

function getSelectedTerms() {
  const categoryId = document.querySelector("#loan-category").value;
  return state.config.loanCategories.find((item) => item.id === categoryId) || state.config.loanCategories[0];
}

function statusPill(status) {
  const tone = status === "Approved" ? "good" : "warn";
  return `<span class="status-pill ${tone}">${escapeHtml(status)}</span>`;
}

function sheetStatus(application) {
  const status = application.sheetSync?.status || "pending";
  const className = status === "saved" || status === "synced" ? "good" : status === "failed" ? "bad" : "warn";
  const label = status.replace(/_/g, " ");
  const retry = status !== "saved" && status !== "synced"
    ? `<button class="retry-button" type="button" data-sync="${application.id}">Save Sheet</button>`
    : "";
  return `
    <div class="status-stack">
      <span class="status-pill ${className}">${escapeHtml(label)}</span>
      ${retry}
    </div>
  `;
}

function setMessage(selector, text, tone) {
  const element = document.querySelector(selector);
  element.textContent = text;
  element.classList.toggle("success", tone === "success");
  element.classList.toggle("error", tone === "error");
}

function clampMoney(value) {
  if (!Number.isFinite(value)) return state.config.minLoanAmount;
  return Math.min(Math.max(value, state.config.minLoanAmount), state.config.maxLoanAmount);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0)).replace("BWP", "P");
}

function formatDisplayDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDay(day) {
  const suffix = day === 1 || day === 21 || day === 31 ? "st" : day === 2 || day === 22 ? "nd" : day === 3 || day === 23 ? "rd" : "th";
  return `${day}${suffix}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
