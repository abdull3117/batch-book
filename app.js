/* Batch Book — daily factory production log
   Data model (db capability, shared doc store):
     settings/materials  { items: [{id,name,unit,rate}] }
     settings/products   { items: [{id,name,unit}] }
     settings/labour     { operatorRate, loadmanRate, processingCost }
     entries/<id>         { date, productId, outputQty, materials:{id:qty}, operators, loadmen,
                             remarks, rmCost, processingCost, labourCost, totalCost, costPerKg, createdAt,
                             jobworkCompanyId?, jobworkCompanyName?, jobworkRatePerMT?,
                             jobworkRevenue?, jobworkProfit? }
                           — the jobwork* fields are set only when a batch is tagged "Job work
                           for" a contract company on the Log Batch form; a regular batch omits
                           them entirely. There is no separate job-work entries collection —
                           a job-work batch IS a normal entries/<id> doc, just tagged with which
                           company it was made for, so its cost comes from the exact same
                           computeCosts() pipeline as every other batch (see jobRateFor() below).
     stock/<date_productId> { date, productId, opening, dispatched, updatedAt }
     settings/jobwork     { companies: [{id,name,products:[{id,name,ratePerMT,note,productId}]}] }
                           — productId links a job-work rate to the regular Log Batch product
                           (settings/products) it applies to; a product must exist there first
                           (Settings, or "+ Add product") before a rate can be linked to it.
                           A rate with no productId yet is "not linked" — it won't be found by
                           jobRateFor() until an admin links it from this Job Work tab.
*/

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Default master data (used until live settings load, and as seed)
  // ---------------------------------------------------------------
  const DEFAULT_MATERIALS = [
    { id: "rm_dolomite", name: "Dolomite", unit: "Kg", rate: 6 },
    { id: "rm_bentonite", name: "Bentonite", unit: "Kg", rate: 9 },
    { id: "rm_filler", name: "Filler", unit: "Kg", rate: 3 },
    { id: "rm_clay", name: "Clay", unit: "Kg", rate: 2 },
    { id: "rm_flyash", name: "Flyash", unit: "Kg", rate: 1.5 },
    { id: "rm_urea", name: "Urea", unit: "Kg", rate: 6.5 },
    { id: "rm_dap", name: "DAP", unit: "Kg", rate: 28 },
    { id: "rm_potash", name: "Potash", unit: "Kg", rate: 18 },
    { id: "rm_npk121212", name: "NPK 12:12:12 (Purchased Mix)", unit: "Kg", rate: 12 },
    { id: "rm_rockphosphate", name: "Rock Phosphate", unit: "Kg", rate: 8 },
    { id: "rm_gypsum", name: "Gypsum", unit: "Kg", rate: 5 },
    { id: "rm_cashewhusk", name: "Cashew Husk", unit: "Kg", rate: 4 },
    { id: "rm_coal", name: "Coal", unit: "Kg", rate: 12 },
    { id: "rm_mellarsawdust", name: "Mellar Saw Dust", unit: "Kg", rate: 2 },
    { id: "rm_redoxide", name: "Red Oxide", unit: "Kg", rate: 25 },
    { id: "rm_blackoxide", name: "Black Oxide", unit: "Kg", rate: 25 },
    { id: "rm_seaweedgel", name: "Seaweed Gel", unit: "Kg", rate: 40 },
    { id: "rm_micronutrient", name: "Micronutrient Powder", unit: "Kg", rate: 90 },
    { id: "rm_neem", name: "Neem (Powder/Cake)", unit: "Kg", rate: 15 },
    { id: "rm_bucket", name: "Bucket", unit: "Piece", rate: 25 },
    { id: "rm_bag", name: "Bag", unit: "Piece", rate: 12 },
  ];

  const DEFAULT_PRODUCTS = [
    { id: "p_171717", name: "17:17:17", unit: "Kg" },
    { id: "p_121212", name: "12:12:12", unit: "Kg" },
    { id: "p_20200", name: "20:20:0", unit: "Kg" },
    { id: "p_prom", name: "PROM", unit: "Kg" },
    { id: "p_pdm", name: "PDM", unit: "Kg" },
    { id: "p_rockgranules", name: "Rock Granules", unit: "Kg" },
    { id: "p_pasiya", name: "Pasiya", unit: "Kg" },
    { id: "p_sigaram", name: "Sigaram", unit: "Kg" },
    { id: "p_solaivanam", name: "Solaivanam", unit: "Kg" },
    { id: "p_cms", name: "CMS", unit: "Kg" },
    { id: "p_no18", name: "No.18", unit: "Kg" },
    { id: "p_no12", name: "No.12", unit: "Kg" },
    { id: "p_no10", name: "No.10", unit: "Kg" },
    { id: "p_no16", name: "No.16", unit: "Kg" },
  ];

  const DEFAULT_LABOUR = {
    operatorRate: 600, loadmanRate: 500,
    processingCost: 2000, // flat ₹/batch fallback, used until the breakdown below is set up
    // Processing cost breakdown — all ₹ per month. Their sum, divided by
    // budgetedMonthlyOutputMT, gives a ₹/MT rate applied to each batch
    // based on that batch's own output (see processingCostPerMT below).
    ebCost: 0, fuelCost: 0, maintenanceCost: 0, electricalMaintenanceCost: 0,
    stitchingExpense: 0, sackExpenses: 0, departmentExpenses: 0, staffSalaries: 0,
    budgetedMonthlyOutputMT: 0,
  };
  const PROCESSING_BREAKDOWN_FIELDS = [
    "ebCost", "fuelCost", "maintenanceCost", "electricalMaintenanceCost",
    "stitchingExpense", "sackExpenses", "departmentExpenses", "staffSalaries",
  ];

  // ---------------------------------------------------------------
  // Job work — contract production for outside companies. Each company
  // pays a fixed ₹/MT job-work rate per product; the app still costs the
  // batch the normal way (raw materials + processing + labour, using the
  // same rates/wages as regular production) and shows profit or loss as
  // revenue (rate × MT produced) minus that actual cost.
  // ---------------------------------------------------------------
  const DEFAULT_JOBWORK_COMPANIES = [
    {
      id: "co_sfl", name: "Silverline Fertilizers Ltd (SFL)",
      products: [
        { id: "sfl_jobwork_mix", name: "Job Work Mix", ratePerMT: 3950, note: "Rock Phosphate ~70%, remaining 30% combination of other materials (reference only — enter actual quantities used)", productId: "" },
        { id: "sfl_cms", name: "CMS", ratePerMT: 3950, note: "", productId: "p_cms" },
      ],
    },
    {
      id: "co_rajshree", name: "Rajshree Bio Solutions",
      products: [
        { id: "rajshree_pdm", name: "PDM Granules", ratePerMT: 4250, note: "", productId: "p_pdm" },
      ],
    },
    {
      id: "co_skywin", name: "SKY WIN Biotech",
      products: [
        { id: "skywin_jobwork", name: "Job Work", ratePerMT: 6300, note: "", productId: "" },
      ],
    },
  ];

  function monthlyProcessingCostTotal(labour) {
    return PROCESSING_BREAKDOWN_FIELDS.reduce((sum, k) => sum + (Number(labour[k]) || 0), 0);
  }

  // Returns a ₹/MT rate once a budgeted monthly output is set, else null
  // (caller falls back to the flat per-batch default).
  function processingCostPerMT(labour) {
    const budgetMT = Number(labour.budgetedMonthlyOutputMT) || 0;
    if (budgetMT <= 0) return null;
    return monthlyProcessingCostTotal(labour) / budgetMT;
  }

  // Units offered everywhere a material or product's unit is picked.
  const UNIT_OPTIONS = ["Kg", "Litre", "Metric Tonne"];

  // Per-batch output (and everything it feeds into — cost/Kg, material
  // rates) stays stored and costed in Kg, unchanged. The Stock ledger and
  // the Reports "Total output" tile instead work in Metric Tonnes, so we
  // convert at the boundary: 1 MT = 1000 Kg.
  const KG_PER_MT = 1000;

  // The "Output produced" field on the entry form lets a supervisor pick
  // whichever unit they're measuring in (Kg, Litre or Metric Tonne) and
  // converts it to the Kg-equivalent that's actually stored/costed.
  // Kg<->MT is an exact conversion; Litre has no universal density, so
  // it's treated 1:1 with Kg (best-effort, same as other unit fields in
  // this app which don't do cross-unit density conversion either).
  function outputToKg(value, unit) {
    const v = Number(value) || 0;
    return unit === "Metric Tonne" ? v * KG_PER_MT : v;
  }

  // Google Sheets sync — Apps Script Web App URL. Every saved batch is
  // also pushed here as a row, so there's always a live spreadsheet
  // copy of all entries. Firestore (above) remains the source of truth
  // the app itself reads from; this push is fire-and-forget and never
  // blocks or fails a save if the sheet is unreachable.
  const SHEETS_SYNC_URL = "https://script.google.com/macros/s/AKfycbx8FyHZmfEBSD9-j6WqMTuwXx6K2v3e_VgiWuqtShvYsbWLef2dGcFYOb67bbpXyGV3/exec";

  // ---------------------------------------------------------------
  // Access control — simple shared-password gate with two roles.
  // Password hashes (SHA-256 hex, never the plaintext) live in Firestore
  // at settings/access so an admin can change them anytime from Settings
  // without a redeploy. Defaults below seed that doc the first time the
  // app ever runs; change them from Settings right away.
  //   Default admin password: emr@admin2026
  //   Default team password:  emr@team2026
  // This is a UI-level gate for everyday privacy between roles (team
  // members shouldn't see costs/rates), not a hardened security boundary
  // — the app has no server-side auth, so anyone with the raw Firebase
  // config could still reach the database directly.
  const DEFAULT_ACCESS = {
    adminHash: "b97c6bd1d212e55a03b591b68470794bb96fdf7700b01ce7ce95d59a5390b22d",
    teamHash: "e672b7f6c2f08d00452e72d9cff3fd5ef19130c7270ec854f10c8d6a3b96b45d",
  };
  const ROLE_STORAGE_KEY = "bb_role";
  // Tabs a "team" role cannot see — they show costs, rates and wages.
  const ADMIN_ONLY_TABS = ["settings"];

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const state = {
    db: null,
    dbStatus: "connecting", // connecting | live | preview | error
    materials: DEFAULT_MATERIALS.slice(),
    products: DEFAULT_PRODUCTS.slice(),
    labour: Object.assign({}, DEFAULT_LABOUR),
    access: Object.assign({}, DEFAULT_ACCESS),
    role: null, // "admin" | "team" | null (locked)
    entries: [],
    stock: [],
    activeTab: "entry",
    materialFilter: "",
    reportFilter: { start: "", end: "", productId: "" },
    editingEntryId: null, // set while the form is editing an existing batch instead of logging a new one
    jobworkCompanies: DEFAULT_JOBWORK_COMPANIES.slice(),
  };

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function fmtINR(n) {
    n = Number(n) || 0;
    return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(n, d) {
    n = Number(n) || 0;
    d = d == null ? 2 : d;
    return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function monthStartStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }
  function productName(id) {
    const p = state.products.find((x) => x.id === id);
    return p ? p.name : id;
  }
  function materialById(id) {
    return state.materials.find((x) => x.id === id);
  }
  function jobCompanyById(id) {
    return state.jobworkCompanies.find((c) => c.id === id);
  }
  // Looks up whether a job-work company has a fixed rate set up for a
  // regular Log Batch product — this is what lets a batch tagged "Job
  // work for <company>" on the Log Batch form know its ₹/MT rate. Returns
  // the rate entry ({id,name,ratePerMT,note,productId}) or null when
  // that company has no rate linked to this product yet.
  function jobRateFor(companyId, productId) {
    const c = jobCompanyById(companyId);
    if (!c || !productId) return null;
    return (c.products || []).find((p) => p.productId === productId) || null;
  }
  function toast(msg, kind) {
    const host = $("#toast-host");
    const t = el("div", { class: "toast " + (kind || "") }, [msg]);
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  function computeCosts(materialsQty, outputQty, operators, loadmen) {
    let rmCost = 0;
    state.materials.forEach((m) => {
      const q = Number(materialsQty[m.id]) || 0;
      rmCost += q * (Number(m.rate) || 0);
    });
    const perMT = processingCostPerMT(state.labour);
    const processingCost = perMT != null
      ? perMT * (outputQty / KG_PER_MT)
      : (Number(state.labour.processingCost) || 0);
    const labourCost = (Number(operators) || 0) * (Number(state.labour.operatorRate) || 0) +
      (Number(loadmen) || 0) * (Number(state.labour.loadmanRate) || 0);
    const totalCost = rmCost + processingCost + labourCost;
    const costPerKg = outputQty > 0 ? totalCost / outputQty : 0;
    return { rmCost, processingCost, labourCost, totalCost, costPerKg };
  }

  // ---------------------------------------------------------------
  // Add a new raw material / product on the fly — so supervisors
  // aren't limited to the predefined master list.
  // ---------------------------------------------------------------
  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  // Builds a unit <select> pre-set to `current`. If `current` isn't one of
  // the standard options (older/custom data) it's added as an extra option
  // so the real stored value is never silently swapped out from under it.
  function buildUnitSelect(current, className, onChange) {
    const opts = UNIT_OPTIONS.slice();
    if (current && opts.indexOf(current) === -1) opts.unshift(current);
    const sel = el(
      "select",
      { class: className, onchange: (e) => onChange(e.target.value) },
      opts.map((u) => el("option", { value: u }, [u]))
    );
    sel.value = current || "Kg";
    return sel;
  }

  async function updateMaterialUnit(idx, unit) {
    const item = state.materials[idx];
    if (!item) return;
    state.materials = state.materials.map((m, i) => (i === idx ? Object.assign({}, m, { unit }) : m));
    try {
      if (state.db) await state.db.doc("settings/materials").set({ items: state.materials });
      toast("Unit for \"" + item.name + "\" set to " + unit + ".", "success");
    } catch (e) {
      toast("Could not save unit: " + e.message, "error");
    }
    rebuildMaterialGrid();
  }

  async function updateProductUnit(idx, unit) {
    const item = state.products[idx];
    if (!item) return;
    state.products = state.products.map((p, i) => (i === idx ? Object.assign({}, p, { unit }) : p));
    try {
      if (state.db) await state.db.doc("settings/products").set({ items: state.products });
      toast("Unit for \"" + item.name + "\" set to " + unit + ".", "success");
    } catch (e) {
      toast("Could not save unit: " + e.message, "error");
    }
  }

  async function addMaterial(name, unit, rate) {
    name = (name || "").trim();
    if (!name) { toast("Enter a material name.", "error"); return null; }
    if (state.materials.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      toast("\"" + name + "\" is already in the list.", "warn");
      return null;
    }
    const item = {
      id: "rm_custom_" + slugify(name) + "_" + Date.now().toString(36),
      name, unit: (unit || "Kg").trim() || "Kg", rate: Number(rate) || 0,
    };
    const updated = state.materials.concat([item]);
    state.materials = updated;
    try {
      if (state.db) await state.db.doc("settings/materials").set({ items: updated });
      toast("Added \"" + name + "\" to raw materials.", "success");
    } catch (e) {
      toast("Added, but couldn't sync yet: " + e.message, "warn");
    }
    renderSettingsMaterials();
    rebuildMaterialGrid();
    return item;
  }

  async function addProduct(name, unit) {
    name = (name || "").trim();
    if (!name) { toast("Enter a product name.", "error"); return null; }
    if (state.products.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      toast("\"" + name + "\" is already in the list.", "warn");
      return null;
    }
    const item = {
      id: "p_custom_" + slugify(name) + "_" + Date.now().toString(36),
      name, unit: (unit || "Kg").trim() || "Kg",
    };
    const updated = state.products.concat([item]);
    state.products = updated;
    try {
      if (state.db) await state.db.doc("settings/products").set({ items: updated });
      toast("Added \"" + name + "\" to products.", "success");
    } catch (e) {
      toast("Added, but couldn't sync yet: " + e.message, "warn");
    }
    renderSettingsProducts();
    populateProductSelects();
    return item;
  }

  // ---------------------------------------------------------------
  // Job work — company / product management (rates editable anytime,
  // e.g. if a client's job-work price changes).
  // ---------------------------------------------------------------
  async function saveJobworkCompanies(updated) {
    state.jobworkCompanies = updated;
    try {
      if (state.db) await state.db.doc("settings/jobwork").set({ companies: updated });
    } catch (e) {
      toast("Saved, but couldn't sync yet: " + e.message, "warn");
    }
  }

  async function addJobCompany(name) {
    name = (name || "").trim();
    if (!name) { toast("Enter a company name.", "error"); return null; }
    if (state.jobworkCompanies.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast("\"" + name + "\" is already in the list.", "warn");
      return null;
    }
    const item = { id: "co_" + slugify(name) + "_" + Date.now().toString(36), name, products: [] };
    const updated = state.jobworkCompanies.concat([item]);
    await saveJobworkCompanies(updated);
    toast("Added \"" + name + "\" to job work companies.", "success");
    renderJobCompanies();
    populateJobCompanySelect();
    return item;
  }

  // A job-work rate always applies to a real Log Batch product — that's
  // what lets a batch tagged "Job work for <company>" on the Log Batch
  // form find its rate (see jobRateFor()). If the product doesn't exist
  // yet in the regular product list, add it there first (Settings, or
  // the entry form's "+ Add new product…"), then link a rate to it here.
  async function addJobProduct(companyId, productId, rate, note) {
    const company = jobCompanyById(companyId);
    if (!company) { toast("Pick a company first.", "error"); return null; }
    productId = (productId || "").trim();
    if (!productId) { toast("Pick which Log Batch product this rate applies to.", "error"); return null; }
    const name = productName(productId);
    if ((company.products || []).some((p) => p.productId === productId)) {
      toast("\"" + name + "\" already has a rate under " + company.name + ".", "warn");
      return null;
    }
    const item = {
      id: "jwp_" + slugify(name) + "_" + Date.now().toString(36),
      name, ratePerMT: Number(rate) || 0, note: (note || "").trim(), productId,
    };
    const updated = state.jobworkCompanies.map((c) =>
      c.id === companyId ? Object.assign({}, c, { products: (c.products || []).concat([item]) }) : c
    );
    await saveJobworkCompanies(updated);
    toast("Added \"" + name + "\" under " + company.name + ".", "success");
    renderJobCompanies();
    populateJobCompanySelect();
    return item;
  }

  // Reads every rate input and linked-product select currently on screen
  // and saves them all in one go — used when a client's job-work price
  // changes, or to link/relink a rate to the Log Batch product a batch
  // must be tagged with (on the Log Batch form) for it to apply.
  async function saveJobRates() {
    const rateInputs = $all(".jw-rate-input");
    const linkSelects = $all(".jw-link-select");
    const updated = state.jobworkCompanies.map((c) => Object.assign({}, c, {
      products: (c.products || []).map((p) => {
        const rateInp = rateInputs.find((i) => i.dataset.companyId === c.id && i.dataset.productId === p.id);
        const linkSel = linkSelects.find((i) => i.dataset.companyId === c.id && i.dataset.productId === p.id);
        const next = Object.assign({}, p);
        if (rateInp) next.ratePerMT = Number(rateInp.value) || 0;
        if (linkSel) { next.productId = linkSel.value || ""; if (next.productId) next.name = productName(next.productId); }
        return next;
      }),
    }));
    await saveJobworkCompanies(updated);
    toast("Job work rates & linked products saved.", "success");
    renderJobCompanies();
    populateJobworkCompanyPickers();
    updateLiveSummary();
    renderJobPnL();
  }

  // Dropdown offered per job-work rate (admin only) to link/relink it to
  // a regular Log Batch product — see jobRateFor() above.
  function buildJobLinkSelect(companyId, p) {
    const sel = el("select", {
      class: "jw-link-select", "data-company-id": companyId, "data-product-id": p.id,
      style: "min-width:170px;",
    });
    sel.appendChild(el("option", { value: "" }, ["— Not linked yet —"]));
    state.products.forEach((prod) => sel.appendChild(el("option", { value: prod.id }, [prod.name])));
    sel.value = p.productId || "";
    return sel;
  }

  function renderJobCompanies() {
    const body = $("#jw-companies-body");
    if (!body) return;
    body.innerHTML = "";
    const isTeam = state.role === "team";
    if (!state.jobworkCompanies.length) {
      body.appendChild(el("tr", {}, [el("td", { colspan: "5", class: "empty-hint" }, ["No job work companies added yet."])]));
      return;
    }
    state.jobworkCompanies.forEach((c) => {
      const products = c.products || [];
      if (!products.length) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [c.name]),
          el("td", { class: "empty-hint" }, ["No rates added yet"]),
          el("td", {}, [""]),
          el("td", {}, [""]),
          el("td", { class: "num" }, [""]),
        ]));
        return;
      }
      products.forEach((p, idx) => {
        const linked = !!p.productId;
        body.appendChild(el("tr", {}, [
          el("td", {}, [idx === 0 ? c.name : ""]),
          el("td", {}, [linked ? productName(p.productId) : (p.name + " ⚠")]),
          el("td", { style: "max-width:220px; white-space:normal; color:var(--text-faint); font-size:.78rem;" }, [p.note || ""]),
          el("td", {}, [
            isTeam
              ? (linked ? productName(p.productId) : "— not linked —")
              : buildJobLinkSelect(c.id, p),
          ]),
          el("td", { class: "num" }, [
            isTeam
              ? fmtINR(p.ratePerMT)
              : el("input", {
                  type: "number", min: "0", step: "any", class: "rate-input jw-rate-input",
                  "data-company-id": c.id, "data-product-id": p.id, value: p.ratePerMT,
                }),
          ]),
        ]));
      });
    });
  }

  // ---------------------------------------------------------------
  // Sync status
  // ---------------------------------------------------------------
  function setSyncStatus(status) {
    state.dbStatus = status;
    const dot = $("#sync-dot");
    const label = $("#sync-label");
    if (!dot || !label) return;
    dot.className = "sync-dot " + status;
    const labels = {
      connecting: "Connecting…",
      live: "Live — synced",
      preview: "Preview — not saving",
      error: "Connection issue",
    };
    label.textContent = labels[status] || status;
  }

  // ---------------------------------------------------------------
  // DB wiring — Firebase Firestore (compat SDK), loaded from CDN in
  // index.html via window.firebase. Works for any visitor of the
  // published GitHub Pages link, no Claude account needed.
  // ---------------------------------------------------------------
  async function initDb() {
    let db = null;
    try {
      if (window.firebase && window.BATCH_BOOK_FIREBASE_CONFIG) {
        if (!firebase.apps.length) firebase.initializeApp(window.BATCH_BOOK_FIREBASE_CONFIG);
        db = firebase.firestore();
      }
    } catch (e) { db = null; }
    if (!db) {
      setSyncStatus("preview");
      renderAll();
      return;
    }
    state.db = db;
    setSyncStatus("connecting");
    // Firestore resolves its first snapshot asynchronously; flip to
    // "live" once we hear back (or to "error" if it never connects).
    db.collection("entries").limit(1).get()
      .then(() => setSyncStatus("live"))
      .catch(() => setSyncStatus("error"));

    db.doc("settings/materials").onSnapshot(
      (snap) => {
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.items) && data.items.length) state.materials = data.items;
        }
        renderSettingsMaterials();
        rebuildMaterialGrid();
      },
      () => {}
    );
    db.doc("settings/products").onSnapshot(
      (snap) => {
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.items) && data.items.length) state.products = data.items;
        }
        renderSettingsProducts();
        populateProductSelects();
        renderJobCompanies();
        renderJobPnL();
      },
      () => {}
    );
    db.doc("settings/jobwork").onSnapshot(
      (snap) => {
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.companies) && data.companies.length) state.jobworkCompanies = data.companies;
        } else {
          // First time the app has ever run — seed the doc with the
          // starting companies so they can be edited from the Job Work tab.
          db.doc("settings/jobwork").set({ companies: DEFAULT_JOBWORK_COMPANIES }).catch(() => {});
        }
        renderJobCompanies();
        populateJobCompanySelect();
        renderJobPnL();
      },
      () => {}
    );
    db.doc("settings/labour").onSnapshot(
      (snap) => {
        if (snap.exists) {
          const data = snap.data();
          const merged = Object.assign({}, DEFAULT_LABOUR);
          Object.keys(DEFAULT_LABOUR).forEach((k) => {
            if (data[k] != null) merged[k] = data[k];
          });
          // Self-heal a stale "Fallback processing cost per batch" that
          // doesn't match the breakdown's own computed ₹/MT rate (e.g. data
          // saved before this sync existed) — keep the two in step.
          const perMT = processingCostPerMT(merged);
          if (perMT != null) {
            const rounded = Math.round(perMT * 100) / 100;
            if (merged.processingCost !== rounded) {
              merged.processingCost = rounded;
              if (state.role === "admin") db.doc("settings/labour").set(merged).catch(() => {});
            }
          }
          state.labour = merged;
        }
        renderSettingsLabour();
        updateLiveSummary();
      },
      () => {}
    );
    db.doc("settings/access").onSnapshot(
      (snap) => {
        if (snap.exists) {
          const data = snap.data();
          state.access = {
            adminHash: data.adminHash || DEFAULT_ACCESS.adminHash,
            teamHash: data.teamHash || DEFAULT_ACCESS.teamHash,
          };
        } else {
          // First time the app has ever run — seed the doc with the
          // default passwords so they can be changed from Settings.
          db.doc("settings/access").set(DEFAULT_ACCESS).catch(() => {});
        }
      },
      () => {}
    );
    db.collection("entries").orderBy("createdAt", "desc").limit(500).onSnapshot(
      (snap) => {
        state.entries = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        renderTodayList();
        renderReports();
        renderStock();
        renderJobPnL();
      },
      (e) => { toast("Sync error loading entries: " + e.message, "error"); }
    );
    db.collection("stock").orderBy("date", "desc").limit(500).onSnapshot(
      (snap) => {
        state.stock = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        renderStock();
      },
      (e) => { toast("Sync error loading stock: " + e.message, "error"); }
    );

    renderAll();
  }

  // ---------------------------------------------------------------
  // Access gate
  // ---------------------------------------------------------------
  function lockScreenError(msg) {
    const errEl = $("#lock-error");
    if (!errEl) return;
    if (!msg) { errEl.hidden = true; errEl.textContent = ""; return; }
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  async function attemptUnlock() {
    const input = $("#lock-password");
    const pw = (input.value || "").trim();
    if (!pw) return lockScreenError("Enter a password.");
    const btn = $("#btn-unlock");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const hash = await sha256Hex(pw);
      let role = null;
      if (hash === state.access.adminHash) role = "admin";
      else if (hash === state.access.teamHash) role = "team";
      if (!role) {
        lockScreenError("Incorrect password. Try again.");
        input.value = "";
        input.focus();
        return;
      }
      lockScreenError(null);
      input.value = "";
      try { sessionStorage.setItem(ROLE_STORAGE_KEY, role); } catch (e) { /* ignore */ }
      applyRole(role);
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  }

  function lockApp() {
    try { sessionStorage.removeItem(ROLE_STORAGE_KEY); } catch (e) { /* ignore */ }
    state.role = null;
    $("#app").hidden = true;
    $("#lock-screen").hidden = false;
    $("#lock-password").value = "";
    $("#lock-password").focus();
  }

  // Applies role-based visibility: team members can log batches, see
  // stock quantities, and view full Reports (including costs); only
  // Settings (rates, wages, access control) stays admin-only.
  function applyRole(role) {
    state.role = role;
    $("#lock-screen").hidden = true;
    $("#app").hidden = false;

    const badge = $("#role-badge");
    const logoutBtn = $("#btn-logout");
    if (badge) {
      badge.hidden = false;
      badge.textContent = role === "admin" ? "Admin view" : "Team view";
      badge.className = "role-badge" + (role === "admin" ? " admin" : "");
    }
    if (logoutBtn) logoutBtn.hidden = false;

    const isTeam = role === "team";
    const settingsTab = $("#tab-btn-settings");
    if (settingsTab) settingsTab.hidden = isTeam;
    const costBlock = $("#cost-details-block");
    if (costBlock) costBlock.hidden = isTeam;
    // Job work rates can be viewed by anyone, but only admin can add
    // companies/products or change a rate.
    const jwAdminTools = $("#jw-admin-tools");
    if (jwAdminTools) jwAdminTools.hidden = isTeam;

    // If a team member was mid-way on an admin-only tab (or is being
    // switched down from admin), bounce them back to Log Batch.
    if (isTeam && ADMIN_ONLY_TABS.indexOf(state.activeTab) !== -1) switchTab("entry");
    renderTodayList();
    renderJobCompanies();
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  function switchTab(tab) {
    if (state.role === "team" && ADMIN_ONLY_TABS.indexOf(tab) !== -1) return;
    state.activeTab = tab;
    $all(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $all(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab));
  }

  // ---------------------------------------------------------------
  // Push a saved entry into the Google Sheet copy. Best-effort only —
  // Firestore is already saved by the time this runs, so a failure or
  // slow network here never loses data or blocks the supervisor.
  // ---------------------------------------------------------------
  function syncEntryToSheet(entryId, payload) {
    if (!SHEETS_SYNC_URL) return;
    try {
      const body = JSON.stringify(Object.assign({ id: entryId, productName: productName(payload.productId) }, payload));
      fetch(SHEETS_SYNC_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body }).catch(() => {});
    } catch (e) { /* ignore — sheet sync is best-effort */ }
  }

  // ---------------------------------------------------------------
  // ENTRY TAB
  // ---------------------------------------------------------------
  function rebuildMaterialGrid() {
    const grid = $("#material-grid");
    if (!grid) return;
    const filter = state.materialFilter.trim().toLowerCase();
    grid.innerHTML = "";
    state.materials.forEach((m) => {
      if (filter && m.name.toLowerCase().indexOf(filter) === -1) return;
      const input = el("input", {
        type: "number", min: "0", step: "any", inputmode: "decimal",
        class: "mat-input", "data-mat": m.id, placeholder: "0",
      });
      const row = el("div", { class: "mat-row" }, [
        el("label", { class: "mat-label" }, [
          el("span", { class: "mat-name", title: m.name }, [m.name]),
          el("span", { class: "mat-unit" }, [m.unit]),
        ]),
        input,
      ]);
      grid.appendChild(row);
    });
  }

  function populateProductSelects() {
    $all(".product-select").forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "" }, ["Select product…"]));
      state.products.forEach((p) => {
        sel.appendChild(el("option", { value: p.id }, [p.name]));
      });
      sel.appendChild(el("option", { value: "__other__" }, ["+ Add new product…"]));
      if (current) sel.value = current;
    });
    populateStockProductSelect();
    populateReportProductFilter();
    populateJobProductLinkSelect();
  }

  function getFormMaterialsQty() {
    const out = {};
    $all(".mat-input").forEach((inp) => {
      const v = parseFloat(inp.value);
      if (v > 0) out[inp.dataset.mat] = v;
    });
    return out;
  }

  function updateLiveSummary() {
    // The form collects output in whichever unit is picked; convert to
    // Kg-equivalent here since costing (rmCost, costPerKg) stays Kg-based.
    const outputVal = parseFloat($("#f-output").value) || 0;
    const outputUnit = $("#f-output-unit").value;
    const outputQty = outputToKg(outputVal, outputUnit);
    const operators = parseFloat($("#f-operators").value) || 0;
    const loadmen = parseFloat($("#f-loadmen").value) || 0;
    const mats = getFormMaterialsQty();
    const c = computeCosts(mats, outputQty, operators, loadmen);
    $("#sum-rm").textContent = fmtINR(c.rmCost);
    $("#sum-processing").textContent = fmtINR(c.processingCost);
    $("#sum-labour").textContent = fmtINR(c.labourCost);
    $("#sum-total").textContent = fmtINR(c.totalCost);
    $("#sum-cpk").textContent = outputQty > 0 ? fmtINR(c.costPerKg) : "—";
    const usedCount = Object.keys(mats).length;
    $("#sum-mat-count").textContent = usedCount + (usedCount === 1 ? " material used" : " materials used");
    updateJobworkLiveSummary(outputQty, c);
  }

  // Job work readout on the Log Batch form — if this batch is tagged
  // "Job work for <company>", shows that company's fixed ₹/MT rate for
  // this product and computes revenue/profit-loss straight off this
  // batch's own cost (c, from computeCosts() above). No separate costing
  // logic — a job-work batch's cost is exactly the same as any other.
  function updateJobworkLiveSummary(outputQty, c) {
    const companySel = $("#f-jobwork-company");
    const rateDisplay = $("#f-jobwork-rate-display");
    const revenueRow = $("#f-jw-revenue-row");
    const profitBox = $("#f-jw-profit-box");
    const noRateHint = $("#f-jw-no-rate-hint");
    const companyId = companySel ? companySel.value : "";
    if (!companyId) {
      if (rateDisplay) rateDisplay.hidden = true;
      if (revenueRow) revenueRow.hidden = true;
      if (profitBox) profitBox.hidden = true;
      if (noRateHint) noRateHint.hidden = true;
      return;
    }
    const productId = $("#f-product").value;
    const jr = jobRateFor(companyId, productId);
    if (!jr) {
      if (rateDisplay) { rateDisplay.hidden = false; rateDisplay.textContent = "Rate: — (not linked for this product yet)"; }
      if (revenueRow) revenueRow.hidden = true;
      if (profitBox) profitBox.hidden = true;
      if (noRateHint) {
        noRateHint.hidden = false;
        noRateHint.textContent = "No job work rate linked for this product yet — set one up on the Job Work tab.";
      }
      return;
    }
    if (noRateHint) noRateHint.hidden = true;
    if (rateDisplay) { rateDisplay.hidden = false; rateDisplay.textContent = "Rate: " + fmtINR(jr.ratePerMT) + "/MT"; }
    const revenue = (outputQty / KG_PER_MT) * jr.ratePerMT;
    const profit = revenue - c.totalCost;
    if (revenueRow) { revenueRow.hidden = false; $("#sum-jw-revenue").textContent = fmtINR(revenue); }
    if (profitBox) {
      profitBox.hidden = false;
      $("#sum-jw-profit").textContent = (profit < 0 ? "-" : "") + fmtINR(Math.abs(profit));
      profitBox.classList.remove("pl-positive", "pl-negative");
      profitBox.classList.add(profit < 0 ? "pl-negative" : "pl-positive");
    }
  }

  async function submitEntry() {
    const date = $("#f-date").value;
    const productId = $("#f-product").value;
    // Entered in whichever unit is picked on the form; stored (and
    // costed) as a Kg-equivalent, as before.
    const outputVal = parseFloat($("#f-output").value) || 0;
    const outputUnit = $("#f-output-unit").value;
    const outputQty = outputToKg(outputVal, outputUnit);
    const operators = parseFloat($("#f-operators").value) || 0;
    const loadmen = parseFloat($("#f-loadmen").value) || 0;
    const remarks = $("#f-remarks").value.trim();
    const mats = getFormMaterialsQty();

    if (!date) return toast("Pick a date first.", "error");
    if (!productId) return toast("Pick a product first.", "error");
    if (productId === "__other__") return toast("Finish adding the new product first.", "error");
    if (outputVal <= 0) return toast("Enter the output quantity produced.", "error");
    if (Object.keys(mats).length === 0) return toast("Enter at least one raw material quantity.", "error");

    const c = computeCosts(mats, outputQty, operators, loadmen);
    const editingId = state.editingEntryId;
    const existing = editingId ? state.entries.find((e) => e.id === editingId) : null;
    const payload = {
      date, productId, outputQty, materials: mats, operators, loadmen, remarks,
      rmCost: c.rmCost, processingCost: c.processingCost, labourCost: c.labourCost,
      totalCost: c.totalCost, costPerKg: c.costPerKg,
      // Keep the original createdAt on an edit so the entry doesn't jump
      // position in the "most recent" ordering used elsewhere; stamp a
      // separate updatedAt instead.
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    };
    if (editingId) payload.updatedAt = new Date().toISOString();

    // Job work tag — this batch IS the job-work record when a company is
    // picked; revenue/profit are computed once, right here, off this
    // batch's own cost (c), and saved alongside it.
    const jobworkCompanyId = $("#f-jobwork-company") ? $("#f-jobwork-company").value : "";
    if (jobworkCompanyId) {
      const company = jobCompanyById(jobworkCompanyId);
      const jr = jobRateFor(jobworkCompanyId, productId);
      payload.jobworkCompanyId = jobworkCompanyId;
      payload.jobworkCompanyName = company ? company.name : jobworkCompanyId;
      if (jr) {
        payload.jobworkRatePerMT = jr.ratePerMT;
        payload.jobworkRevenue = (outputQty / KG_PER_MT) * jr.ratePerMT;
        payload.jobworkProfit = payload.jobworkRevenue - c.totalCost;
      } else {
        payload.jobworkRatePerMT = null;
        payload.jobworkRevenue = 0;
        payload.jobworkProfit = -c.totalCost;
      }
    }

    const btn = $("#btn-submit");
    btn.disabled = true;
    btn.textContent = editingId ? "Updating…" : "Saving…";
    try {
      const unitLabel = outputUnit === "Metric Tonne" ? "MT" : outputUnit;
      if (state.db) {
        if (editingId) {
          await state.db.collection("entries").doc(editingId).set(payload);
          syncEntryToSheet(editingId, payload);
          toast("Batch updated — " + productName(productId) + ", " + fmtNum(outputVal, 2) + " " + unitLabel + ".", "success");
        } else {
          const ref = await state.db.collection("entries").add(payload);
          syncEntryToSheet(ref.id, payload);
          toast("Batch saved — " + productName(productId) + ", " + fmtNum(outputVal, 2) + " " + unitLabel + ". Ready for the next batch.", "success");
        }
      } else {
        if (editingId) {
          const idx = state.entries.findIndex((e) => e.id === editingId);
          if (idx !== -1) state.entries[idx] = Object.assign({ id: editingId }, payload);
          toast("Batch updated locally (preview only — open the published link to sync).", "warn");
        } else {
          payload.id = "local_" + Date.now();
          state.entries.unshift(payload);
          toast("Saved locally (preview only — open the published link to sync).", "warn");
        }
        renderTodayList();
        renderReports();
      }
      state.editingEntryId = null;
      if ($("#edit-banner")) $("#edit-banner").hidden = true;
      resetEntryForm(date);
      // Jump straight back to the top of the form, ready for the next
      // batch — logging several batches (same or different products) in
      // one sitting should feel like a quick loop, not a fresh start.
      $("#entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
      $("#f-product").focus();
    } catch (e) {
      toast("Could not save: " + (e && e.message ? e.message : "unknown error"), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = state.editingEntryId ? "Update batch" : "Save batch";
    }
  }

  function resetEntryForm(keepDate) {
    $("#f-product").value = "";
    $("#f-output").value = "";
    $("#f-operators").value = "";
    $("#f-loadmen").value = "";
    $("#f-remarks").value = "";
    if ($("#f-jobwork-company")) $("#f-jobwork-company").value = "";
    $all(".mat-input").forEach((i) => (i.value = ""));
    if (keepDate) $("#f-date").value = keepDate;
    updateLiveSummary();
  }

  // Dropdown of every date that has batches logged, newest first, so you
  // can jump straight to a day's production instead of hunting through the
  // calendar picker one day at a time. Kept in sync with #f-date whenever
  // renderTodayList() runs (new data, date changed some other way, etc).
  function populateDateJump(dateVal) {
    const sel = $("#date-jump");
    if (!sel) return;
    dateVal = dateVal || ($("#f-date") ? $("#f-date").value || todayStr() : todayStr());
    const counts = {};
    state.entries.forEach((e) => { if (e.date) counts[e.date] = (counts[e.date] || 0) + 1; });
    if (!(dateVal in counts)) counts[dateVal] = 0; // list the currently selected date even with 0 batches
    const dates = Object.keys(counts).sort().reverse();
    sel.innerHTML = "";
    dates.forEach((d) => {
      const n = counts[d];
      sel.appendChild(el("option", { value: d }, [d + " (" + n + (n === 1 ? " batch)" : " batches)")]));
    });
    sel.value = dateVal;
  }

  function renderTodayList() {
    const host = $("#today-list");
    const dateVal = $("#f-date") ? $("#f-date").value || todayStr() : todayStr();
    populateDateJump(dateVal);
    const rows = state.entries.filter((e) => e.date === dateVal);
    $("#today-list-label").textContent = "Batches logged for " + dateVal +
      (rows.length ? " (" + rows.length + (rows.length === 1 ? " batch" : " batches") + ")" : "");
    host.innerHTML = "";
    if (!rows.length) {
      host.appendChild(el("div", { class: "empty-hint" }, ["No batches logged for this date yet. Log as many batches — same product or different — as you need."]));
      return;
    }
    rows.forEach((r) => {
      const outputMTVal = (r.outputQty || 0) / KG_PER_MT;
      const metaText = state.role === "team"
        ? fmtNum(outputMTVal, 2) + " MT"
        : fmtNum(outputMTVal, 2) + " MT · " + fmtINR(r.totalCost) + " · " + fmtINR(r.costPerKg) + "/Kg";
      const row = el("div", { class: "today-row" }, [
        el("div", { class: "today-main" }, [
          el("span", { class: "today-product" }, [productName(r.productId)]),
          el("span", { class: "today-meta" }, [metaText]),
        ]),
        el("div", { class: "today-actions" }, [
          el("button", {
            class: "icon-btn", title: "View this batch's full details",
            onclick: () => viewEntry(r),
          }, ["\u{1F441}"]),
          el("button", {
            class: "icon-btn", title: "Edit this batch",
            onclick: () => editEntry(r),
          }, ["✎"]),
          el("button", {
            class: "icon-btn", title: "Load this batch onto the form to log a similar one",
            onclick: () => duplicateEntry(r),
          }, ["⧉"]),
          el("button", {
            class: "icon-btn danger", title: "Delete this batch",
            onclick: () => deleteEntry(r.id),
          }, ["✕"]),
        ]),
      ]);
      if (state.editingEntryId === r.id) row.classList.add("today-row-editing");
      host.appendChild(row);
    });
  }

  // ---------------------------------------------------------------
  // Quick re-entry — repeat/duplicate a batch so logging several
  // batches (same product again, or a different one) in one sitting
  // is a couple of clicks instead of retyping everything.
  // ---------------------------------------------------------------
  function mostRecentEntryForDate(date) {
    const rows = state.entries.filter((e) => e.date === date);
    if (!rows.length) return null;
    return rows.slice().sort((a, b) => (a.createdAt || "") < (b.createdAt || "") ? 1 : -1)[0];
  }

  function fillFormFromEntry(entry, opts) {
    if (!entry) return;
    opts = opts || {};
    $("#f-product").value = entry.productId || "";
    // entry.outputQty is stored in Kg; refill the form in MT (and reset
    // the unit picker to MT so the displayed number matches the label).
    $("#f-output").value = entry.outputQty ? entry.outputQty / KG_PER_MT : "";
    if ($("#f-output-unit")) $("#f-output-unit").value = "Metric Tonne";
    $("#f-operators").value = entry.operators || "";
    $("#f-loadmen").value = entry.loadmen || "";
    $("#f-remarks").value = opts.keepRemarks ? (entry.remarks || "") : "";
    if ($("#f-jobwork-company")) $("#f-jobwork-company").value = entry.jobworkCompanyId || "";
    const mats = entry.materials || {};
    $all(".mat-input").forEach((inp) => {
      const v = mats[inp.dataset.mat];
      inp.value = v != null ? v : "";
    });
    updateLiveSummary();
  }

  function exitEditMode() {
    state.editingEntryId = null;
    if ($("#edit-banner")) $("#edit-banner").hidden = true;
    if ($("#btn-submit")) $("#btn-submit").textContent = "Save batch";
  }

  function repeatLastBatch() {
    exitEditMode();
    const date = $("#f-date").value || todayStr();
    const last = mostRecentEntryForDate(date);
    if (!last) return toast("No batches logged for this date yet to repeat.", "warn");
    fillFormFromEntry(last);
    toast("Loaded your last batch (" + productName(last.productId) + ") — adjust quantities and save.", "success");
    $("#entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#f-output").focus();
  }

  function duplicateEntry(entry) {
    exitEditMode();
    fillFormFromEntry(entry);
    toast("Loaded " + productName(entry.productId) + " onto the form — adjust and save as a new batch.", "success");
    $("#entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#f-output").focus();
  }

  // ---------------------------------------------------------------
  // Edit a previously logged batch in place (rather than duplicating
  // it as a new entry). Saving while in this mode updates the same
  // Firestore doc instead of creating a new one — see submitEntry().
  // ---------------------------------------------------------------
  function editEntry(entry) {
    if (!entry) return;
    state.editingEntryId = entry.id;
    fillFormFromEntry(entry, { keepRemarks: true });
    $("#f-date").value = entry.date || todayStr();
    if ($("#edit-banner")) $("#edit-banner").hidden = false;
    if ($("#edit-banner-text")) {
      $("#edit-banner-text").textContent = "Editing " + productName(entry.productId) + " — " + entry.date + ". Change what you need and save to update it.";
    }
    if ($("#btn-submit")) $("#btn-submit").textContent = "Update batch";
    renderTodayList();
    toast("Editing this batch — change the fields and save, or cancel to leave it as-is.", "success");
    $("#entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#f-output").focus();
  }

  function cancelEdit() {
    if (!state.editingEntryId) return;
    exitEditMode();
    resetEntryForm($("#f-date").value || todayStr());
    renderTodayList();
    toast("Edit cancelled — nothing was changed.", "warn");
  }

  // ---------------------------------------------------------------
  // Read-only "view" modal for a previously logged batch — full
  // breakdown (materials, labour, cost) without loading it onto the
  // form. Costs/rates are omitted for the team role, same as elsewhere.
  // ---------------------------------------------------------------
  let viewedEntry = null;

  function viewEntry(entry) {
    if (!entry) return;
    viewedEntry = entry;
    $("#view-modal-title").textContent = productName(entry.productId) + " — " + entry.date;
    const body = $("#view-modal-body");
    body.innerHTML = "";
    const rows = [
      ["Date", entry.date || "—"],
      ["Product", productName(entry.productId)],
      ["Output", fmtNum((entry.outputQty || 0) / KG_PER_MT, 2) + " MT"],
      ["Operators", fmtNum(entry.operators || 0, 0)],
      ["Loadmen", fmtNum(entry.loadmen || 0, 0)],
    ];
    rows.forEach(([k, v]) => {
      body.appendChild(el("div", { class: "view-row" }, [
        el("span", { class: "k" }, [k]), el("span", { class: "v" }, [String(v)]),
      ]));
    });

    const mats = entry.materials || {};
    const matIds = Object.keys(mats);
    if (matIds.length) {
      body.appendChild(el("div", { class: "view-section-title" }, ["Raw materials used"]));
      matIds.forEach((id) => {
        const m = materialById(id);
        body.appendChild(el("div", { class: "view-row" }, [
          el("span", { class: "k" }, [m ? m.name : id]),
          el("span", { class: "v" }, [fmtNum(mats[id], 2) + " " + (m ? m.unit : "")]),
        ]));
      });
    }

    if (entry.remarks) {
      body.appendChild(el("div", { class: "view-section-title" }, ["Remarks"]));
      body.appendChild(el("div", { class: "view-row" }, [el("span", { class: "k" }, [entry.remarks])]));
    }

    {
      body.appendChild(el("div", { class: "view-section-title" }, ["Cost"]));
      [
        ["Raw material cost", fmtINR(entry.rmCost)],
        ["Processing cost", fmtINR(entry.processingCost)],
        ["Labour cost", fmtINR(entry.labourCost)],
        ["Total cost", fmtINR(entry.totalCost)],
        ["Cost per Kg", fmtINR(entry.costPerKg)],
      ].forEach(([k, v]) => {
        body.appendChild(el("div", { class: "view-row" }, [
          el("span", { class: "k" }, [k]), el("span", { class: "v" }, [v]),
        ]));
      });
    }

    if (entry.jobworkCompanyId) {
      const profit = entry.jobworkProfit || 0;
      body.appendChild(el("div", { class: "view-section-title" }, ["Job work"]));
      [
        ["Company", entry.jobworkCompanyName || entry.jobworkCompanyId],
        ["Rate", entry.jobworkRatePerMT != null ? fmtINR(entry.jobworkRatePerMT) + "/MT" : "— (not linked)"],
        ["Revenue", fmtINR(entry.jobworkRevenue)],
        ["Profit / loss", (profit < 0 ? "-" : "") + fmtINR(Math.abs(profit))],
      ].forEach(([k, v]) => {
        body.appendChild(el("div", { class: "view-row" }, [
          el("span", { class: "k" }, [k]),
          el("span", { class: "v" + (k === "Profit / loss" ? (profit < 0 ? " pl-negative" : " pl-positive") : "") }, [String(v)]),
        ]));
      });
    }

    $("#view-modal").hidden = false;
  }

  function closeViewModal() {
    viewedEntry = null;
    $("#view-modal").hidden = true;
  }

  async function deleteEntry(id) {
    if (!id) return;
    if (!confirm("Delete this batch entry? This can't be undone.")) return;
    try {
      if (state.db && !String(id).startsWith("local_")) {
        await state.db.collection("entries").doc(id).delete();
      } else {
        state.entries = state.entries.filter((e) => e.id !== id);
        renderTodayList();
        renderReports();
      }
      if (state.editingEntryId === id) {
        exitEditMode();
        resetEntryForm($("#f-date").value || todayStr());
      }
      toast("Batch deleted.", "warn");
    } catch (e) {
      toast("Could not delete: " + e.message, "error");
    }
  }

  // ---------------------------------------------------------------
  // JOB WORK TAB — manage contract companies & their fixed ₹/MT rates.
  // A batch is tagged "Job work for <company>" right on the Log Batch
  // form (see the ENTRY TAB section below) — there's no separate
  // job-work batch-entry form, so nothing is ever typed twice. This tab
  // is just company/rate setup plus a profit & loss report, both driven
  // by the exact same entries every batch is already saved to.
  // ---------------------------------------------------------------
  function populateJobCompanySelect() {
    const addSel = $("#jw-new-product-company");
    if (addSel) {
      const cur = addSel.value;
      addSel.innerHTML = "";
      state.jobworkCompanies.forEach((c) => addSel.appendChild(el("option", { value: c.id }, [c.name])));
      if (cur) addSel.value = cur;
    }
    const repSel = $("#jw-rep-company");
    if (repSel) {
      const cur = repSel.value;
      repSel.innerHTML = "";
      repSel.appendChild(el("option", { value: "" }, ["All companies"]));
      state.jobworkCompanies.forEach((c) => repSel.appendChild(el("option", { value: c.id }, [c.name])));
      if (cur) repSel.value = cur;
    }
    populateJobworkCompanyPickers();
  }

  // Options for the "+ Add product" inline form's "which product" picker
  // — kept in sync whenever the regular product list changes (see
  // populateProductSelects()).
  function populateJobProductLinkSelect() {
    const sel = $("#jw-new-product-link");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, ["Select a Log Batch product…"]));
    state.products.forEach((p) => sel.appendChild(el("option", { value: p.id }, [p.name])));
    if (current) sel.value = current;
  }

  // The "Job work for" picker on the Log Batch form, and the "Company"
  // filter on the Reports tab — both list every job-work company so a
  // batch can be tagged, or reports filtered, by company.
  function populateJobworkCompanyPickers() {
    const entrySel = $("#f-jobwork-company");
    if (entrySel) {
      const cur = entrySel.value;
      entrySel.innerHTML = "";
      entrySel.appendChild(el("option", { value: "" }, ["— Regular production —"]));
      state.jobworkCompanies.forEach((c) => entrySel.appendChild(el("option", { value: c.id }, [c.name])));
      if (cur) entrySel.value = cur;
    }
    const repSel = $("#rep-company");
    if (repSel) {
      const cur = repSel.value;
      repSel.innerHTML = "";
      repSel.appendChild(el("option", { value: "" }, ["All companies"]));
      state.jobworkCompanies.forEach((c) => repSel.appendChild(el("option", { value: c.id }, [c.name])));
      if (cur) repSel.value = cur;
    }
  }

  // Profit & loss — date range + company filter over regular entries
  // that were tagged "Job work for" a company, with per-company and
  // day-by-day breakdowns.
  function filteredJobEntries() {
    const start = $("#jw-rep-start") ? $("#jw-rep-start").value : "";
    const end = $("#jw-rep-end") ? $("#jw-rep-end").value : "";
    const companyId = $("#jw-rep-company") ? $("#jw-rep-company").value : "";
    return state.entries.filter((e) => {
      if (!e.jobworkCompanyId) return false;
      if (start && e.date < start) return false;
      if (end && e.date > end) return false;
      if (companyId && e.jobworkCompanyId !== companyId) return false;
      return true;
    });
  }

  function renderJobPnL() {
    if (!$("#view-jobwork")) return;
    const rows = filteredJobEntries();

    const totalBatches = rows.length;
    const totalOutput = rows.reduce((s, r) => s + (r.outputQty || 0), 0);
    const totalRevenue = rows.reduce((s, r) => s + (r.jobworkRevenue || 0), 0);
    const totalCost = rows.reduce((s, r) => s + (r.totalCost || 0), 0);
    const totalProfit = totalRevenue - totalCost;

    if ($("#jw-tile-batches")) $("#jw-tile-batches").textContent = fmtNum(totalBatches, 0);
    if ($("#jw-tile-output")) $("#jw-tile-output").textContent = fmtNum(totalOutput / KG_PER_MT, 2) + " MT";
    if ($("#jw-tile-revenue")) $("#jw-tile-revenue").textContent = fmtINR(totalRevenue);
    const profitTile = $("#jw-tile-profit");
    if (profitTile) {
      profitTile.textContent = (totalProfit < 0 ? "-" : "") + fmtINR(Math.abs(totalProfit));
      profitTile.classList.remove("pl-positive", "pl-negative");
      profitTile.classList.add(totalProfit < 0 ? "pl-negative" : "pl-positive");
    }

    // per-company aggregation
    const byCompany = {};
    rows.forEach((r) => {
      const k = r.jobworkCompanyId;
      if (!byCompany[k]) byCompany[k] = { companyId: k, companyName: r.jobworkCompanyName, batches: 0, output: 0, revenue: 0, cost: 0 };
      byCompany[k].batches += 1;
      byCompany[k].output += r.outputQty || 0;
      byCompany[k].revenue += r.jobworkRevenue || 0;
      byCompany[k].cost += r.totalCost || 0;
    });
    const companyAgg = Object.values(byCompany).sort((a, b) => b.revenue - a.revenue);
    const companyBody = $("#jw-company-report-body");
    if (companyBody) {
      companyBody.innerHTML = "";
      if (!companyAgg.length) {
        companyBody.appendChild(el("tr", {}, [el("td", { colspan: "6", class: "empty-hint" }, ["No job work batches in this range yet."])]));
      } else {
        companyAgg.forEach((a) => {
          const p = a.revenue - a.cost;
          companyBody.appendChild(el("tr", {}, [
            el("td", {}, [a.companyName || a.companyId]),
            el("td", { class: "num" }, [fmtNum(a.batches, 0)]),
            el("td", { class: "num" }, [fmtNum(a.output / KG_PER_MT, 2)]),
            el("td", { class: "num" }, [fmtINR(a.revenue)]),
            el("td", { class: "num" }, [fmtINR(a.cost)]),
            el("td", { class: "num strong " + (p < 0 ? "pl-negative" : "pl-positive") }, [(p < 0 ? "-" : "") + fmtINR(Math.abs(p))]),
          ]));
        });
      }
    }

    // day-by-day aggregation
    const byDay = {};
    rows.forEach((r) => {
      const k = r.date;
      if (!byDay[k]) byDay[k] = { date: k, batches: 0, output: 0, revenue: 0, cost: 0 };
      byDay[k].batches += 1;
      byDay[k].output += r.outputQty || 0;
      byDay[k].revenue += r.jobworkRevenue || 0;
      byDay[k].cost += r.totalCost || 0;
    });
    const dayAgg = Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1));
    const dayBody = $("#jw-daily-report-body");
    if (dayBody) {
      dayBody.innerHTML = "";
      if (!dayAgg.length) {
        dayBody.appendChild(el("tr", {}, [el("td", { colspan: "6", class: "empty-hint" }, ["No job work batches in this range yet."])]));
      } else {
        dayAgg.forEach((a) => {
          const p = a.revenue - a.cost;
          dayBody.appendChild(el("tr", {}, [
            el("td", {}, [a.date]),
            el("td", { class: "num" }, [fmtNum(a.batches, 0)]),
            el("td", { class: "num" }, [fmtNum(a.output / KG_PER_MT, 2)]),
            el("td", { class: "num" }, [fmtINR(a.revenue)]),
            el("td", { class: "num" }, [fmtINR(a.cost)]),
            el("td", { class: "num strong " + (p < 0 ? "pl-negative" : "pl-positive") }, [(p < 0 ? "-" : "") + fmtINR(Math.abs(p))]),
          ]));
        });
      }
    }

    // full batch log — View/Edit take you to the same Log Batch entry
    // these figures came from, since there's no separate job-work record.
    const logBody = $("#jw-batch-log-body");
    if (logBody) {
      logBody.innerHTML = "";
      if (!rows.length) {
        logBody.appendChild(el("tr", {}, [el("td", { colspan: "8", class: "empty-hint" }, ["No job work batches logged in this range."])]));
      } else {
        rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).forEach((r) => {
          const p = r.jobworkProfit || 0;
          logBody.appendChild(el("tr", {}, [
            el("td", {}, [r.date]),
            el("td", {}, [r.jobworkCompanyName || r.jobworkCompanyId]),
            el("td", {}, [productName(r.productId)]),
            el("td", { class: "num" }, [fmtNum((r.outputQty || 0) / KG_PER_MT, 2)]),
            el("td", { class: "num" }, [fmtINR(r.jobworkRevenue)]),
            el("td", { class: "num" }, [fmtINR(r.totalCost)]),
            el("td", { class: "num strong " + (p < 0 ? "pl-negative" : "pl-positive") }, [(p < 0 ? "-" : "") + fmtINR(Math.abs(p))]),
            el("td", { class: "num" }, [
              el("div", { class: "today-actions", style: "justify-content:flex-end;" }, [
                el("button", { class: "icon-btn", title: "View this batch's full details", onclick: () => viewEntry(r) }, ["\u{1F441}"]),
                el("button", { class: "icon-btn", title: "Edit this batch", onclick: () => editEntryFromReports(r) }, ["✎"]),
              ]),
            ]),
          ]));
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // REPORTS TAB
  // ---------------------------------------------------------------
  function populateReportProductFilter() {
    const sel = $("#rep-product");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, ["All products"]));
    state.products.forEach((p) => sel.appendChild(el("option", { value: p.id }, [p.name])));
    if (current) sel.value = current;
  }

  function filteredEntries() {
    const start = $("#rep-start") ? $("#rep-start").value : "";
    const end = $("#rep-end") ? $("#rep-end").value : "";
    const productId = $("#rep-product") ? $("#rep-product").value : "";
    const companyId = $("#rep-company") ? $("#rep-company").value : "";
    return state.entries.filter((e) => {
      if (start && e.date < start) return false;
      if (end && e.date > end) return false;
      if (productId && e.productId !== productId) return false;
      if (companyId && e.jobworkCompanyId !== companyId) return false;
      return true;
    });
  }

  function renderReports() {
    if (!$("#view-reports")) return;
    const rows = filteredEntries();

    const totalBatches = rows.length;
    const totalOutput = rows.reduce((s, r) => s + (r.outputQty || 0), 0);
    const totalCost = rows.reduce((s, r) => s + (r.totalCost || 0), 0);
    const avgCpk = totalOutput > 0 ? totalCost / totalOutput : 0;

    $("#tile-batches").textContent = fmtNum(totalBatches, 0);
    $("#tile-output").textContent = fmtNum(totalOutput / KG_PER_MT, 2) + " MT";
    $("#tile-cost").textContent = fmtINR(totalCost);
    $("#tile-cpk").textContent = totalOutput > 0 ? fmtINR(avgCpk) : "—";

    // per-product aggregation
    const byProduct = {};
    rows.forEach((r) => {
      const k = r.productId;
      if (!byProduct[k]) byProduct[k] = { productId: k, batches: 0, output: 0, cost: 0 };
      byProduct[k].batches += 1;
      byProduct[k].output += r.outputQty || 0;
      byProduct[k].cost += r.totalCost || 0;
    });
    const agg = Object.values(byProduct).sort((a, b) => b.cost - a.cost);

    renderBarChart($("#chart-output"), agg.map((a) => ({ label: productName(a.productId), value: a.output / KG_PER_MT })), { suffix: " MT", decimals: 2 });
    renderBarChart($("#chart-cost"), agg.map((a) => ({ label: productName(a.productId), value: a.cost })), { prefix: "₹", decimals: 0 });

    const prodTable = $("#product-report-body");
    prodTable.innerHTML = "";
    if (!agg.length) {
      prodTable.appendChild(el("tr", {}, [el("td", { colspan: "5", class: "empty-hint" }, ["No batches in this range yet."])]));
    } else {
      agg.forEach((a) => {
        prodTable.appendChild(el("tr", {}, [
          el("td", {}, [productName(a.productId)]),
          el("td", { class: "num" }, [fmtNum(a.batches, 0)]),
          el("td", { class: "num" }, [fmtNum(a.output / KG_PER_MT, 2)]),
          el("td", { class: "num" }, [fmtINR(a.cost)]),
          el("td", { class: "num" }, [fmtINR(a.output > 0 ? a.cost / a.output : 0)]),
        ]));
      });
    }

    const logBody = $("#batch-log-body");
    logBody.innerHTML = "";
    if (!rows.length) {
      logBody.appendChild(el("tr", {}, [el("td", { colspan: "12", class: "empty-hint" }, ["No batches logged in this range."])]));
    } else {
      rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).forEach((r) => {
        const hasJobwork = !!r.jobworkCompanyId;
        const profit = r.jobworkProfit || 0;
        logBody.appendChild(el("tr", {}, [
          el("td", {}, [r.date]),
          el("td", {}, [productName(r.productId)]),
          el("td", {}, [hasJobwork ? (r.jobworkCompanyName || r.jobworkCompanyId) : "—"]),
          el("td", { class: "num" }, [fmtNum((r.outputQty || 0) / KG_PER_MT, 2)]),
          el("td", { class: "num" }, [fmtINR(r.rmCost)]),
          el("td", { class: "num" }, [fmtINR(r.processingCost)]),
          el("td", { class: "num" }, [fmtINR(r.labourCost)]),
          el("td", { class: "num strong" }, [fmtINR(r.totalCost)]),
          el("td", { class: "num" }, [hasJobwork ? fmtINR(r.jobworkRevenue) : "—"]),
          el("td", { class: "num strong" + (hasJobwork ? (profit < 0 ? " pl-negative" : " pl-positive") : "") }, [
            hasJobwork ? (profit < 0 ? "-" : "") + fmtINR(Math.abs(profit)) : "—",
          ]),
          el("td", { class: "num" }, [fmtINR(r.costPerKg)]),
          el("td", { class: "num" }, [
            el("div", { class: "today-actions", style: "justify-content:flex-end;" }, [
              el("button", {
                class: "icon-btn", title: "View this batch's full details",
                onclick: () => viewEntry(r),
              }, ["\u{1F441}"]),
              el("button", {
                class: "icon-btn", title: "Edit this batch",
                onclick: () => editEntryFromReports(r),
              }, ["✎"]),
            ]),
          ]),
        ]));
      });
    }
  }

  // Editing lives on the Log Batch form, so jumping into it from the
  // Reports batch log switches tabs first, then loads the entry exactly
  // like editing from Log Batch's own list would.
  function editEntryFromReports(entry) {
    switchTab("entry");
    editEntry(entry);
  }

  function renderBarChart(container, data, opts) {
    if (!container) return;
    opts = opts || {};
    container.innerHTML = "";
    data = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value).slice(0, 14);
    if (!data.length) {
      container.appendChild(el("div", { class: "empty-hint" }, ["No data yet."]));
      return;
    }
    const max = Math.max.apply(null, data.map((d) => d.value));
    const wrap = el("div", { class: "bars" });
    data.forEach((d) => {
      const pct = max > 0 ? (d.value / max) * 100 : 0;
      const valText = (opts.prefix || "") + fmtNum(d.value, opts.decimals == null ? 2 : opts.decimals) + (opts.suffix || "");
      const bar = el("div", { class: "bar-row" }, [
        el("div", { class: "bar-label", title: d.label }, [d.label]),
        el("div", { class: "bar-track" }, [
          el("div", { class: "bar-fill", style: "width:" + pct.toFixed(1) + "%" }),
        ]),
        el("div", { class: "bar-value" }, [valText]),
      ]);
      wrap.appendChild(bar);
    });
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------
  // REPORTS — downloads (CSV / Excel / PDF)
  // ---------------------------------------------------------------
  function reportExportRows() {
    const rows = filteredEntries().slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return rows.map((r) => ({
      "Date": r.date,
      "Product": productName(r.productId),
      "Job Work Company": r.jobworkCompanyId ? (r.jobworkCompanyName || r.jobworkCompanyId) : "",
      "Output (MT)": Number(((r.outputQty || 0) / KG_PER_MT).toFixed(2)),
      "RM Cost": r.rmCost || 0,
      "Processing Cost": r.processingCost || 0,
      "Labour Cost": r.labourCost || 0,
      "Total Cost": r.totalCost || 0,
      "Revenue": r.jobworkCompanyId ? (r.jobworkRevenue || 0) : "",
      "Profit / Loss": r.jobworkCompanyId ? (r.jobworkProfit || 0) : "",
      "Cost per Kg": r.costPerKg || 0,
    }));
  }

  function reportFileBaseName() {
    const start = ($("#rep-start") && $("#rep-start").value) || "all";
    const end = ($("#rep-end") && $("#rep-end").value) || "all";
    return "batch-book-report_" + start + "_to_" + end;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCSV() {
    const rows = reportExportRows();
    if (!rows.length) return toast("No batches in this range to export.", "warn");
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
      if (typeof v === "string" && /[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    const lines = [headers.join(",")];
    rows.forEach((r) => lines.push(headers.map((h) => esc(r[h])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, reportFileBaseName() + ".csv");
    toast("CSV downloaded.", "success");
  }

  function downloadExcel() {
    if (typeof XLSX === "undefined") return toast("Excel export library didn't load — check your connection and try again.", "error");
    const rows = reportExportRows();
    if (!rows.length) return toast("No batches in this range to export.", "warn");
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Batch Log");
    XLSX.writeFile(wb, reportFileBaseName() + ".xlsx");
    toast("Excel file downloaded.", "success");
  }

  function downloadPDF() {
    if (typeof window.jspdf === "undefined") return toast("PDF export library didn't load — check your connection and try again.", "error");
    const rows = reportExportRows();
    if (!rows.length) return toast("No batches in this range to export.", "warn");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text("Batch Book — Production Report (EMR Groups)", 14, 15);
    doc.setFontSize(9);
    const range = (($("#rep-start") && $("#rep-start").value) || "All time") + "   to   " + (($("#rep-end") && $("#rep-end").value) || "present");
    doc.text(range, 14, 21);
    const headers = [Object.keys(rows[0])];
    const body = rows.map((r) => Object.values(r).map((v) => (typeof v === "number" ? fmtNum(v, 2) : v)));
    doc.autoTable({ head: headers, body, startY: 26, styles: { fontSize: 8 }, headStyles: { fillColor: [201, 124, 14] } });
    doc.save(reportFileBaseName() + ".pdf");
    toast("PDF downloaded.", "success");
  }

  // ---------------------------------------------------------------
  // STOCK TAB
  // ---------------------------------------------------------------
  function populateStockProductSelect() {
    const sel = $("#st-product");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, ["Select product…"]));
    state.products.forEach((p) => sel.appendChild(el("option", { value: p.id }, [p.name])));
    if (current) sel.value = current;
  }

  function suggestOpening(productId, date) {
    const prior = state.stock
      .filter((s) => s.productId === productId && s.date < date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!prior) return 0;
    const producedMT = producedFor(prior.date, productId) / KG_PER_MT;
    return (Number(prior.opening) || 0) + producedMT - (Number(prior.dispatched) || 0);
  }

  // Returns Kg — the batch entries this is summed from are stored in Kg.
  // Callers on the Stock ledger (MT throughout) divide by KG_PER_MT.
  function producedFor(date, productId) {
    return state.entries
      .filter((e) => e.date === date && e.productId === productId)
      .reduce((s, e) => s + (e.outputQty || 0), 0);
  }

  function stockAutofillOpening() {
    const productId = $("#st-product").value;
    const date = $("#st-date").value;
    if (!productId || !date) return;
    const existing = state.stock.find((s) => s.date === date && s.productId === productId);
    $("#st-opening").value = existing ? existing.opening : suggestOpening(productId, date);
    $("#st-dispatched").value = existing ? existing.dispatched : "";
  }

  async function submitStock() {
    const productId = $("#st-product").value;
    const date = $("#st-date").value;
    const opening = parseFloat($("#st-opening").value) || 0;
    const dispatched = parseFloat($("#st-dispatched").value) || 0;
    if (!productId || !date) return toast("Pick a product and date.", "error");
    const docId = date + "_" + productId;
    const payload = { date, productId, opening, dispatched, updatedAt: new Date().toISOString() };
    try {
      if (state.db) {
        await state.db.collection("stock").doc(docId).set(payload);
      } else {
        payload.id = docId;
        state.stock = state.stock.filter((s) => s.id !== docId);
        state.stock.unshift(payload);
      }
      toast("Stock entry saved for " + productName(productId) + " on " + date, "success");
      renderStock();
    } catch (e) {
      toast("Could not save stock entry: " + e.message, "error");
    }
  }

  function renderStock() {
    if (!$("#view-stock")) return;
    const body = $("#stock-body");
    body.innerHTML = "";
    const rows = state.stock.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 200);
    if (!rows.length) {
      body.appendChild(el("tr", {}, [el("td", { colspan: "6", class: "empty-hint" }, ["No stock entries yet."])]));
      return;
    }
    rows.forEach((s) => {
      const producedMT = producedFor(s.date, s.productId) / KG_PER_MT;
      const closing = (Number(s.opening) || 0) + producedMT - (Number(s.dispatched) || 0);
      body.appendChild(el("tr", {}, [
        el("td", {}, [s.date]),
        el("td", {}, [productName(s.productId)]),
        el("td", { class: "num" }, [fmtNum(s.opening, 2)]),
        el("td", { class: "num" }, [fmtNum(producedMT, 2)]),
        el("td", { class: "num" }, [fmtNum(s.dispatched, 2)]),
        el("td", { class: "num strong" }, [fmtNum(closing, 2)]),
      ]));
    });
  }

  // ---------------------------------------------------------------
  // SETTINGS TAB
  // ---------------------------------------------------------------
  function renderSettingsMaterials() {
    const body = $("#settings-materials-body");
    if (!body) return;
    body.innerHTML = "";
    state.materials.forEach((m, idx) => {
      body.appendChild(el("tr", {}, [
        el("td", {}, [m.name]),
        el("td", {}, [buildUnitSelect(m.unit, "row-unit-select", (unit) => updateMaterialUnit(idx, unit))]),
        el("td", {}, [
          el("input", {
            type: "number", min: "0", step: "any", class: "rate-input", "data-idx": idx,
            value: m.rate,
          }),
        ]),
      ]));
    });
  }

  function renderSettingsProducts() {
    const body = $("#settings-products-body");
    if (!body) return;
    body.innerHTML = "";
    state.products.forEach((p, idx) => {
      body.appendChild(el("tr", {}, [
        el("td", {}, [p.name]),
        el("td", {}, [buildUnitSelect(p.unit, "row-unit-select", (unit) => updateProductUnit(idx, unit))]),
      ]));
    });
  }

  function renderSettingsLabour() {
    if ($("#s-operator-rate")) $("#s-operator-rate").value = state.labour.operatorRate;
    if ($("#s-loadman-rate")) $("#s-loadman-rate").value = state.labour.loadmanRate;
    if ($("#s-processing-cost")) $("#s-processing-cost").value = state.labour.processingCost;
    const fieldIds = {
      ebCost: "s-eb-cost", fuelCost: "s-fuel-cost", maintenanceCost: "s-maintenance-cost",
      electricalMaintenanceCost: "s-electrical-maintenance-cost", stitchingExpense: "s-stitching-expense",
      sackExpenses: "s-sack-expenses", departmentExpenses: "s-department-expenses", staffSalaries: "s-staff-salaries",
    };
    Object.keys(fieldIds).forEach((k) => {
      const inp = $("#" + fieldIds[k]);
      if (inp) inp.value = state.labour[k] || "";
    });
    if ($("#s-budgeted-output-mt")) $("#s-budgeted-output-mt").value = state.labour.budgetedMonthlyOutputMT || "";
    updateProcessingBreakdownReadout();
  }

  // Reads the breakdown fields live (before saving) and updates the
  // "Monthly total" / "Rate applied per batch" readout under them.
  function updateProcessingBreakdownReadout() {
    const totalEl = $("#proc-monthly-total");
    const rateEl = $("#proc-per-mt-rate");
    if (!totalEl || !rateEl) return;
    const draft = {
      ebCost: $("#s-eb-cost").value, fuelCost: $("#s-fuel-cost").value,
      maintenanceCost: $("#s-maintenance-cost").value, electricalMaintenanceCost: $("#s-electrical-maintenance-cost").value,
      stitchingExpense: $("#s-stitching-expense").value, sackExpenses: $("#s-sack-expenses").value,
      departmentExpenses: $("#s-department-expenses").value, staffSalaries: $("#s-staff-salaries").value,
      budgetedMonthlyOutputMT: $("#s-budgeted-output-mt").value,
    };
    const total = monthlyProcessingCostTotal(draft);
    totalEl.textContent = fmtINR(total);
    const perMT = processingCostPerMT(draft);
    rateEl.textContent = perMT != null
      ? fmtINR(perMT) + " / MT"
      : "Not set up — using fallback";
  }

  async function saveMaterialRates() {
    const inputs = $all(".rate-input");
    const updated = state.materials.map((m) => Object.assign({}, m));
    inputs.forEach((inp) => {
      const idx = Number(inp.dataset.idx);
      const v = parseFloat(inp.value);
      if (updated[idx]) updated[idx].rate = isNaN(v) ? 0 : v;
    });
    state.materials = updated;
    try {
      if (state.db) await state.db.doc("settings/materials").set({ items: updated });
      toast("Raw material rates saved.", "success");
      rebuildMaterialGrid();
      updateLiveSummary();
    } catch (e) {
      toast("Could not save rates: " + e.message, "error");
    }
  }

  async function saveLabourSettings() {
    const payload = Object.assign({}, state.labour, {
      operatorRate: parseFloat($("#s-operator-rate").value) || 0,
      loadmanRate: parseFloat($("#s-loadman-rate").value) || 0,
      processingCost: parseFloat($("#s-processing-cost").value) || 0,
    });
    state.labour = payload;
    try {
      if (state.db) await state.db.doc("settings/labour").set(payload);
      toast("Labour & processing settings saved.", "success");
      updateLiveSummary();
    } catch (e) {
      toast("Could not save settings: " + e.message, "error");
    }
  }

  async function saveProcessingBreakdown() {
    const payload = Object.assign({}, state.labour, {
      ebCost: parseFloat($("#s-eb-cost").value) || 0,
      fuelCost: parseFloat($("#s-fuel-cost").value) || 0,
      maintenanceCost: parseFloat($("#s-maintenance-cost").value) || 0,
      electricalMaintenanceCost: parseFloat($("#s-electrical-maintenance-cost").value) || 0,
      stitchingExpense: parseFloat($("#s-stitching-expense").value) || 0,
      sackExpenses: parseFloat($("#s-sack-expenses").value) || 0,
      departmentExpenses: parseFloat($("#s-department-expenses").value) || 0,
      staffSalaries: parseFloat($("#s-staff-salaries").value) || 0,
      budgetedMonthlyOutputMT: parseFloat($("#s-budgeted-output-mt").value) || 0,
    });
    // Keep the "Fallback processing cost per batch" field in sync with the
    // breakdown's computed ₹/MT rate, so the two never show conflicting
    // numbers (per-batch cost is always calculated in MT via this rate —
    // see processingCostPerMT/computeCosts — the fallback is just the
    // number that's also stored/shown so nothing looks out of date).
    const perMT = processingCostPerMT(payload);
    if (perMT != null) {
      payload.processingCost = Math.round(perMT * 100) / 100;
      if ($("#s-processing-cost")) $("#s-processing-cost").value = payload.processingCost;
    }
    state.labour = payload;
    try {
      if (state.db) await state.db.doc("settings/labour").set(payload);
      toast("Processing cost breakdown saved" + (perMT != null ? " — fallback field updated to " + fmtINR(payload.processingCost) + "/MT." : "."), "success");
      updateProcessingBreakdownReadout();
      updateLiveSummary();
    } catch (e) {
      toast("Could not save breakdown: " + e.message, "error");
    }
  }

  async function saveAccessPasswords() {
    const newAdmin = ($("#s-admin-password").value || "").trim();
    const newTeam = ($("#s-team-password").value || "").trim();
    if (!newAdmin && !newTeam) return toast("Enter a new password in at least one field.", "warn");
    const payload = Object.assign({}, state.access);
    if (newAdmin) payload.adminHash = await sha256Hex(newAdmin);
    if (newTeam) payload.teamHash = await sha256Hex(newTeam);
    state.access = payload;
    try {
      if (state.db) await state.db.doc("settings/access").set(payload);
      $("#s-admin-password").value = "";
      $("#s-team-password").value = "";
      toast("Password(s) updated. Share the new one(s) with whoever needs them.", "success");
    } catch (e) {
      toast("Could not update passwords: " + e.message, "error");
    }
  }

  // ---------------------------------------------------------------
  // Wire up static DOM events (once)
  // ---------------------------------------------------------------
  function wireEvents() {
    $("#btn-unlock").addEventListener("click", attemptUnlock);
    $("#lock-password").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptUnlock(); });
    $("#btn-logout").addEventListener("click", lockApp);
    $("#btn-save-access").addEventListener("click", saveAccessPasswords);

    $all(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

    $("#f-date").value = todayStr();
    $("#f-date").addEventListener("change", renderTodayList);
    if ($("#date-jump")) {
      $("#date-jump").addEventListener("change", () => {
        const v = $("#date-jump").value;
        if (!v) return;
        exitEditMode();
        $("#f-date").value = v;
        renderTodayList();
        $("#today-list-label").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    $("#entry-form").addEventListener("input", updateLiveSummary);
    $("#btn-submit").addEventListener("click", submitEntry);
    $("#btn-repeat-last").addEventListener("click", repeatLastBatch);
    if ($("#btn-cancel-edit")) $("#btn-cancel-edit").addEventListener("click", cancelEdit);
    if ($("#btn-view-close")) $("#btn-view-close").addEventListener("click", closeViewModal);
    if ($("#btn-close-view")) $("#btn-close-view").addEventListener("click", closeViewModal);
    if ($("#view-modal")) $("#view-modal").addEventListener("click", (e) => { if (e.target.id === "view-modal") closeViewModal(); });
    if ($("#btn-view-edit")) {
      $("#btn-view-edit").addEventListener("click", () => {
        if (!viewedEntry) return;
        const entry = viewedEntry;
        closeViewModal();
        editEntry(entry);
      });
    }
    $("#mat-search").addEventListener("input", (e) => {
      state.materialFilter = e.target.value;
      rebuildMaterialGrid();
    });
    if ($("#f-jobwork-company")) $("#f-jobwork-company").addEventListener("change", updateLiveSummary);

    // Entry form — "+ Add new product…" inline
    $("#f-product").addEventListener("change", () => {
      const isOther = $("#f-product").value === "__other__";
      $("#add-product-inline").hidden = !isOther;
      if (isOther) $("#new-prod-name-inline").focus();
    });
    $("#btn-confirm-add-product-inline").addEventListener("click", async () => {
      const item = await addProduct($("#new-prod-name-inline").value, $("#new-prod-unit-inline").value);
      if (item) {
        $("#new-prod-name-inline").value = "";
        $("#new-prod-unit-inline").value = "Kg";
        $("#add-product-inline").hidden = true;
        $("#f-product").value = item.id;
        updateLiveSummary();
      }
    });
    $("#btn-cancel-add-product-inline").addEventListener("click", () => {
      $("#new-prod-name-inline").value = "";
      $("#new-prod-unit-inline").value = "Kg";
      $("#add-product-inline").hidden = true;
      $("#f-product").value = "";
    });

    // Entry form — "+ Add material" inline
    $("#btn-show-add-material-inline").addEventListener("click", () => {
      $("#add-material-inline").hidden = false;
      $("#new-mat-name-inline").focus();
    });
    $("#btn-cancel-add-material-inline").addEventListener("click", () => {
      $("#add-material-inline").hidden = true;
      $("#new-mat-name-inline").value = "";
      $("#new-mat-rate-inline").value = "";
    });
    $("#btn-confirm-add-material-inline").addEventListener("click", async () => {
      const item = await addMaterial(
        $("#new-mat-name-inline").value,
        $("#new-mat-unit-inline").value,
        $("#new-mat-rate-inline").value
      );
      if (item) {
        $("#new-mat-name-inline").value = "";
        $("#new-mat-rate-inline").value = "";
        $("#new-mat-unit-inline").value = "Kg";
        $("#add-material-inline").hidden = true;
      }
    });

    // Settings — "+ Add material"
    $("#btn-show-add-material").addEventListener("click", () => {
      $("#add-material-row").hidden = false;
      $("#new-mat-name").focus();
    });
    $("#btn-cancel-add-material").addEventListener("click", () => {
      $("#add-material-row").hidden = true;
    });
    $("#btn-confirm-add-material").addEventListener("click", async () => {
      const item = await addMaterial($("#new-mat-name").value, $("#new-mat-unit").value, $("#new-mat-rate").value);
      if (item) {
        $("#new-mat-name").value = "";
        $("#new-mat-unit").value = "Kg";
        $("#new-mat-rate").value = "";
        $("#add-material-row").hidden = true;
      }
    });

    // Settings — "+ Add product"
    $("#btn-show-add-product").addEventListener("click", () => {
      $("#add-product-row").hidden = false;
      $("#new-prod-name").focus();
    });
    $("#btn-cancel-add-product").addEventListener("click", () => {
      $("#add-product-row").hidden = true;
    });
    $("#btn-confirm-add-product").addEventListener("click", async () => {
      const item = await addProduct($("#new-prod-name").value, $("#new-prod-unit").value);
      if (item) {
        $("#new-prod-name").value = "";
        $("#new-prod-unit").value = "Kg";
        $("#add-product-row").hidden = true;
      }
    });

    // Reports — downloads
    $("#btn-download-csv").addEventListener("click", downloadCSV);
    $("#btn-download-xlsx").addEventListener("click", downloadExcel);
    $("#btn-download-pdf").addEventListener("click", downloadPDF);

    ["#rep-start", "#rep-end", "#rep-product", "#rep-company"].forEach((sel) => {
      if ($(sel)) $(sel).addEventListener("change", renderReports);
    });
    $("#rep-start").value = monthStartStr();
    $("#rep-end").value = todayStr();
    $("#rep-preset-month").addEventListener("click", () => {
      $("#rep-start").value = monthStartStr();
      $("#rep-end").value = todayStr();
      renderReports();
    });
    $("#rep-preset-all").addEventListener("click", () => {
      $("#rep-start").value = "";
      $("#rep-end").value = "";
      renderReports();
    });

    $("#st-date").value = todayStr();
    $("#st-product").addEventListener("change", stockAutofillOpening);
    $("#st-date").addEventListener("change", stockAutofillOpening);
    $("#btn-stock-save").addEventListener("click", submitStock);

    $("#btn-save-rates").addEventListener("click", saveMaterialRates);
    $("#btn-save-labour").addEventListener("click", saveLabourSettings);

    // Processing cost breakdown — live readout as the user types, before saving.
    $("#btn-save-processing-breakdown").addEventListener("click", saveProcessingBreakdown);
    [
      "#s-eb-cost", "#s-fuel-cost", "#s-maintenance-cost", "#s-electrical-maintenance-cost",
      "#s-stitching-expense", "#s-sack-expenses", "#s-department-expenses", "#s-staff-salaries",
      "#s-budgeted-output-mt",
    ].forEach((sel) => $(sel).addEventListener("input", updateProcessingBreakdownReadout));

    // Job Work — company / product management (admin only)
    if ($("#jw-btn-show-add-company")) {
      $("#jw-btn-show-add-company").addEventListener("click", () => {
        $("#jw-add-company-row").hidden = false;
        $("#jw-new-company-name").focus();
      });
    }
    if ($("#jw-btn-cancel-add-company")) {
      $("#jw-btn-cancel-add-company").addEventListener("click", () => {
        $("#jw-add-company-row").hidden = true;
        $("#jw-new-company-name").value = "";
      });
    }
    if ($("#jw-btn-confirm-add-company")) {
      $("#jw-btn-confirm-add-company").addEventListener("click", async () => {
        const item = await addJobCompany($("#jw-new-company-name").value);
        if (item) {
          $("#jw-new-company-name").value = "";
          $("#jw-add-company-row").hidden = true;
        }
      });
    }
    if ($("#jw-btn-show-add-product")) {
      $("#jw-btn-show-add-product").addEventListener("click", () => {
        $("#jw-add-product-row").hidden = false;
        if ($("#jw-new-product-link")) $("#jw-new-product-link").focus();
      });
    }
    if ($("#jw-btn-cancel-add-product")) {
      $("#jw-btn-cancel-add-product").addEventListener("click", () => {
        $("#jw-add-product-row").hidden = true;
        $("#jw-new-product-rate").value = "";
        $("#jw-new-product-note").value = "";
        if ($("#jw-new-product-link")) $("#jw-new-product-link").value = "";
      });
    }
    if ($("#jw-btn-confirm-add-product")) {
      $("#jw-btn-confirm-add-product").addEventListener("click", async () => {
        const item = await addJobProduct(
          $("#jw-new-product-company").value,
          $("#jw-new-product-link") ? $("#jw-new-product-link").value : "",
          $("#jw-new-product-rate").value,
          $("#jw-new-product-note").value
        );
        if (item) {
          $("#jw-new-product-rate").value = "";
          $("#jw-new-product-note").value = "";
          if ($("#jw-new-product-link")) $("#jw-new-product-link").value = "";
          $("#jw-add-product-row").hidden = true;
        }
      });
    }
    if ($("#jw-btn-save-rates")) $("#jw-btn-save-rates").addEventListener("click", saveJobRates);

    // Job Work — profit & loss filters
    if ($("#jw-rep-start")) {
      ["#jw-rep-start", "#jw-rep-end", "#jw-rep-company"].forEach((sel) => {
        $(sel).addEventListener("change", renderJobPnL);
      });
      $("#jw-rep-start").value = monthStartStr();
      $("#jw-rep-end").value = todayStr();
      $("#jw-rep-preset-month").addEventListener("click", () => {
        $("#jw-rep-start").value = monthStartStr();
        $("#jw-rep-end").value = todayStr();
        renderJobPnL();
      });
      $("#jw-rep-preset-all").addEventListener("click", () => {
        $("#jw-rep-start").value = "";
        $("#jw-rep-end").value = "";
        renderJobPnL();
      });
    }
  }

  function renderAll() {
    rebuildMaterialGrid();
    populateProductSelects();
    renderSettingsMaterials();
    renderSettingsProducts();
    renderSettingsLabour();
    updateLiveSummary();
    renderTodayList();
    renderReports();
    renderStock();
    populateJobCompanySelect();
    renderJobCompanies();
    renderJobPnL();
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireEvents();
    renderAll();
    initDb();

    // Already unlocked earlier this browser tab session? Skip the gate.
    let savedRole = null;
    try { savedRole = sessionStorage.getItem(ROLE_STORAGE_KEY); } catch (e) { /* ignore */ }
    if (savedRole === "admin" || savedRole === "team") {
      applyRole(savedRole);
    } else {
      $("#lock-password").focus();
    }
  });
})();
