// js/app.js
import { dbGetAllItems, dbGetItem, dbPutItem, dbClearAll, dbDeleteItem } from "./db.js";
import { parseCardHeader, parseCardChannels } from "./parsers.js";
import { uuid, nowISO, dayKeyLocal, startOfMonth, endOfMonth, addDays, clampText } from "./utils.js";

let state = {
  items: [],
  monthCursor: startOfMonth(new Date()),
  filterSpace: "all",
  filterChannel: "all",
  search: ""
};

const $ = (id) => document.getElementById(id);

// ---------- Modal state ----------
let modalBound = false;
let currentModalEvent = null;
let aliasDirty = false;
let saveTimer = null;

function fmtDateOnly(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = String(dt.getFullYear());
  return `${dd}/${mm}/${yy}`;
}

function getDisplayName(ev) {
  const a = (ev?.alias || "").trim();
  if (a) return a;
  return (ev?.label || "Push").trim();
}

function getPosFromEvent(ev) {
  const pos = (ev?.meta?.posicaoJornada || "").trim();
  if (pos) return pos;
  const m = String(ev?.label || "").match(/\bP\d+\b/i);
  return m ? m[0].toUpperCase() : "P?";
}

function getComunicacaoName(ev) {
  const n = (ev?.meta?.nomeComunicacao || "").trim();
  if (n) return n;

  const label = String(ev?.label || "");
  const parts = label.split("—");
  if (parts.length >= 2) return parts.slice(1).join("—").trim();
  return label.trim() || "—";
}

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Modal binding ----------
function bindModalOnce() {
  if (modalBound) return;

  const modal = $("modal");
  const backdrop = $("modalClose");
  const btnDelete = $("btnDeleteCard");
  const titleEl = $("modalTitle");

  const missing = [];
  if (!modal) missing.push("modal");
  if (!backdrop) missing.push("modalClose");
  if (!btnDelete) missing.push("btnDeleteCard");
  if (!titleEl) missing.push("modalTitle");

  if (missing.length) {
    console.error("IDs do modal não encontrados no HTML:", missing.join(", "));
    return;
  }

  // fechar (salva antes)
  backdrop.addEventListener("click", async () => {
    await saveAliasIfDirty();
    closeModal();
  });

  document.addEventListener("keydown", async (e) => {
    const modalEl = $("modal");
    if (!modalEl || modalEl.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      await saveAliasIfDirty();
      closeModal();
    }
  });

  // Excluir card
  btnDelete.addEventListener("click", async () => {
    if (!currentModalEvent?.itemId) return;
    const ok = confirm("Excluir este card inteiro (todos os eventos dele)?");
    if (!ok) return;

    await dbDeleteItem(currentModalEvent.itemId);
    closeModal();
    await refresh();
  });

  // Auto-save: edição no título
  titleEl.addEventListener("input", () => {
    aliasDirty = true;
    scheduleSave();
  });

  // Ao sair do título: salva
  titleEl.addEventListener("blur", async () => {
    await saveAliasIfDirty();
  });

  modalBound = true;
}

function showSaving(on) {
  $("saveState").classList.toggle("hidden", !on);
  if (on) $("saveOk").classList.add("hidden");
}

function showSavedOk() {
  $("saveOk").classList.remove("hidden");
  setTimeout(() => $("saveOk").classList.add("hidden"), 900);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  showSaving(true);
  saveTimer = setTimeout(async () => {
    await saveAliasIfDirty();
  }, 450);
}

async function saveAliasIfDirty() {
  if (!aliasDirty) {
    showSaving(false);
    return;
  }
  if (!currentModalEvent?.itemId || !currentModalEvent?.id) {
    aliasDirty = false;
    showSaving(false);
    return;
  }

  const titleEl = $("modalTitle");
  const newAlias = (titleEl.textContent || "").trim();

  try {
    const item = await dbGetItem(currentModalEvent.itemId);
    if (!item) throw new Error("Card não encontrado.");

    const idx = (item.events || []).findIndex(e => e && e.id === currentModalEvent.id);
    if (idx === -1) throw new Error("Evento não encontrado no card.");

    item.events[idx].alias = newAlias;
    item.updatedAt = nowISO();

    await dbPutItem(item);

    currentModalEvent.alias = newAlias;
    aliasDirty = false;
    showSaving(false);
    showSavedOk();

    await refresh(); // atualiza o pill
  } catch (err) {
    console.error(err);
    showSaving(false);
  }
}

function openModalBase(titleText, bodyHTML) {
  bindModalOnce();

  $("modalTitle").textContent = titleText || "—";

  const body = $("modalBody");
  body.innerHTML = bodyHTML || "";

  const modal = $("modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  aliasDirty = false;
  showSaving(false);
  $("saveOk").classList.add("hidden");

  // foca no título (edição direta)
  $("modalTitle").focus();
}

function closeModal() {
  const modal = $("modal");
  if (!modal) return;

  if (document.activeElement && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  currentModalEvent = null;
  aliasDirty = false;

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// ---------- Calendar ----------
function monthLabel(d) {
  return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

function passesFilters(ev, itemName) {
  if (state.filterSpace !== "all" && ev.space !== state.filterSpace) return false;
  if (state.filterChannel !== "all" && ev.channel !== state.filterChannel) return false;

  const q = state.search.trim().toLowerCase();
  if (q) {
    const hay = `${itemName} ${ev.label || ""} ${ev.alias || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function collectEventsForMonth() {
  const start = startOfMonth(state.monthCursor);
  const end = endOfMonth(state.monthCursor);

  const map = new Map();

  for (const it of state.items) {
    const itemName = it.name || "Item";

    for (const ev of (it.events || [])) {
      if (!ev?.at) continue;

      if (ev.space !== "journey" || ev.channel !== "push") continue;
      if (!passesFilters(ev, itemName)) continue;

      const dt = new Date(ev.at);
      if (isNaN(dt.getTime())) continue;

      if (dt < start || dt > addDays(end, 1)) continue;

      const key = dayKeyLocal(dt);
      if (!key) continue;

      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        itemId: it.id,
        itemName,
        ...ev
      });
    }
  }

  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => new Date(a.at) - new Date(b.at));
    map.set(k, arr);
  }

  return map;
}

function buildMonthGridDates(monthCursor) {
  const first = startOfMonth(monthCursor);
  const firstDow = first.getDay();
  const gridStart = addDays(first, -firstDow);

  const last = endOfMonth(monthCursor);
  const lastDow = last.getDay();
  const gridEnd = addDays(last, 6 - lastDow);

  const dates = [];
  let cur = new Date(gridStart);
  while (cur <= gridEnd) {
    dates.push(new Date(cur));
    cur = addDays(cur, 1);
  }
  return dates;
}

function renderCalendar() {
  $("monthLabel").textContent = monthLabel(state.monthCursor);

  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const eventsMap = collectEventsForMonth();
  const dates = buildMonthGridDates(state.monthCursor);

  const month = state.monthCursor.getMonth();
  const todayKey = dayKeyLocal(new Date());

  let totalVisible = 0;

  for (const d of dates) {
    const key = dayKeyLocal(d);
    const isOutside = d.getMonth() !== month;
    const isToday = key && key === todayKey;

    const cell = document.createElement("div");
    cell.className = "day" + (isOutside ? " outside" : "") + (isToday ? " today" : "");

    const header = document.createElement("div");
    header.className = "day-num";

    const left = document.createElement("div");
    left.textContent = String(d.getDate()).padStart(2, "0");

    const right = document.createElement("div");
    right.innerHTML = isToday ? `<span class="dot"></span>` : "";

    header.appendChild(left);
    header.appendChild(right);
    cell.appendChild(header);

    const pillsHost = document.createElement("div");
    pillsHost.className = "pills";

    const entries = (key && eventsMap.get(key)) ? eventsMap.get(key) : [];
    if (entries.length) totalVisible += entries.length;

    const showMax = 3;
    const show = entries.slice(0, showMax);
    const hidden = entries.length - show.length;

    for (const ev of show) {
      const pill = document.createElement("div");
      pill.className = "pill push";

      const t1 = document.createElement("div");
      t1.className = "t1";
      t1.textContent = clampText(getDisplayName(ev), 70);
      pill.appendChild(t1);

      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        openEventModal(ev);
      });

      pillsHost.appendChild(pill);
    }

    if (hidden > 0) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `+${hidden} itens`;
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openDayModal(key, entries);
      });
      pillsHost.appendChild(more);
    }

    cell.addEventListener("click", () => {
      if (entries.length) openDayModal(key, entries);
    });

    cell.appendChild(pillsHost);
    grid.appendChild(cell);
  }

  $("emptyHint").classList.toggle("hidden", totalVisible > 0);
}

// ---------- Modal content ----------
function openEventModal(ev) {
  currentModalEvent = ev;

  // ✅ título do modal = alias (ou label se ainda não tiver)
  const title = getDisplayName(ev);

  const pos = getPosFromEvent(ev);
  const when = fmtDateOnly(ev.at);
  const commName = getComunicacaoName(ev);

  const bodyHTML =
    `<div class="mb-journey">${escapeHTML(ev.itemName || "—")}</div>
     <div class="mb-date">${escapeHTML(`${pos} (PUSH) - ${when}`)}</div>
     <div class="mb-push">${escapeHTML(commName)}</div>`;

  openModalBase(title, bodyHTML);
}

function openDayModal(dayKey, entries) {
  const d = new Date(dayKey + "T00:00:00");
  const title = d.toLocaleDateString("pt-BR", { weekday: "long", year: "numeric", month: "long", day: "2-digit" });

  const lines = entries.map(ev => `• ${escapeHTML(getDisplayName(ev))}`).join("<br/>");
  currentModalEvent = null;
  openModalBase(title, lines || "Sem eventos.");
}

// ---------- Data / actions ----------
async function refresh() {
  state.items = await dbGetAllItems();
  renderCalendar();
}

// ✅ AGORA: alias default = só o nome completo do card
function makeDefaultAlias(cardFullTitle) {
  return String(cardFullTitle || "").trim() || "Card";
}

async function createFromCard() {
  const raw = $("inputCard").value || "";
  if (!raw.trim()) {
    alert("Cole o texto do card.");
    return;
  }

  const header = parseCardHeader(raw);

  // nome completo da task (primeira linha inteira)
  const fullTitle = (header.headerLine || "").trim() || "Card";

  // nome “curto” pro item (continua igual)
  const name = header.displayName || header.headerLine || "Item";

  const parsed = parseCardChannels(raw, name);

  // ✅ preenche alias default em cada evento (se vier vazio)
  for (const ev of (parsed.events || [])) {
    if (!ev.alias || !String(ev.alias).trim()) {
      ev.alias = makeDefaultAlias(fullTitle);
    }
  }

  const createdAt = nowISO();
  const item = {
    id: uuid(),
    name,
    cardUrl: header.cardUrl || "",
    notes: "",
    createdAt,
    updatedAt: createdAt,
    events: parsed.events || []
  };

  await dbPutItem(item);
  $("inputCard").value = "";
  await refresh();
}

function shiftMonth(delta) {
  const d = new Date(state.monthCursor);
  d.setMonth(d.getMonth() + delta);
  state.monthCursor = startOfMonth(d);
  renderCalendar();
}

function gotoToday() {
  state.monthCursor = startOfMonth(new Date());
  renderCalendar();
}

// ---------- Bindings ----------
$("btnParseCreate").addEventListener("click", createFromCard);
$("btnClearInput").addEventListener("click", () => ($("inputCard").value = ""));

$("btnPrev").addEventListener("click", () => shiftMonth(-1));
$("btnNext").addEventListener("click", () => shiftMonth(1));
$("btnToday").addEventListener("click", gotoToday);

$("filterSpace").addEventListener("change", (e) => {
  state.filterSpace = e.target.value;
  renderCalendar();
});

$("filterChannel").addEventListener("change", (e) => {
  state.filterChannel = e.target.value;
  renderCalendar();
});

$("searchBox").addEventListener("input", (e) => {
  state.search = e.target.value || "";
  renderCalendar();
});

$("btnWipeAll").addEventListener("click", async () => {
  const ok = confirm("Apagar tudo que está salvo localmente neste navegador?");
  if (!ok) return;
  await dbClearAll();
  await refresh();
});

// init
bindModalOnce();
await refresh();
gotoToday();
