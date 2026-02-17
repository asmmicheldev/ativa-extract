// js/app.js (COMPLETO)
import { dbGetAllItems, dbGetItem, dbPutItem, dbClearAll, dbDeleteItem } from "./db.js";
import { parseCardHeader, parseCardChannels, parseCardOffers } from "./parsers.js";
import { uuid, nowISO, dayKeyLocal, startOfMonth, endOfMonth, addDays, clampText } from "./utils.js";

const ALLOWED_JOURNEY_CHANNELS = new Set(["push", "email", "whatsapp", "sms"]);

let state = {
  items: [],
  monthCursor: startOfMonth(new Date()),
  filterSpace: "all",
  filterChannel: "all",
  search: ""
};

const $ = (id) => document.getElementById(id);

// ---------- Helpers ----------
function todayStartLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDateOnly(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = String(dt.getFullYear());
  return `${dd}/${mm}/${yy}`;
}

function getItemById(id) {
  return state.items.find(x => x && x.id === id) || null;
}

function getFullCardTitle(item) {
  // nome completo do card (headerLine original)
  const ft = String(item?.fullTitle || "").trim();
  if (ft) return ft;
  const nm = String(item?.name || "").trim();
  return nm || "—";
}

function getDisplayName(ev) {
  const a = (ev?.alias || "").trim();
  if (a) return a;
  const card = (ev?.itemName || "").trim();
  if (card) return card;
  return (ev?.label || "Evento").trim();
}

function getPosFromEvent(ev) {
  const pos = (ev?.meta?.posicaoJornada || "").trim();
  if (pos) return pos;
  const m = String(ev?.label || "").match(/\bP\d+\b/i);
  return m ? m[0].toUpperCase() : "—";
}

function getComunicacaoName(ev) {
  const n = (ev?.meta?.nomeComunicacao || "").trim();
  if (n) return n;

  const label = String(ev?.label || "").trim();
  const cleaned = label.replace(/^[A-Z]+\s+\S+\s+—\s+/i, "").trim();
  return cleaned || label || "—";
}

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Status por card (journey) ----------
function computeCardLastAt(item) {
  let max = null;
  for (const ev of (item.events || [])) {
    if (!ev?.at) continue;
    if (ev.space !== "journey") continue;
    if (!ALLOWED_JOURNEY_CHANNELS.has(String(ev.channel || ""))) continue;

    const dt = new Date(ev.at);
    if (isNaN(dt.getTime())) continue;
    if (!max || dt > max) max = dt;
  }
  return max;
}

function computeCardStatus(item) {
  if (item?.journeyDisabled === true) return "disabled";

  const lastAt = computeCardLastAt(item);
  if (!lastAt) return "active";

  const today0 = todayStartLocal();
  return (lastAt < today0) ? "expired" : "active";
}

function statusClass(status) {
  if (status === "disabled") return "status-disabled";
  if (status === "expired") return "status-expired";
  return "status-active";
}

// ---------- Status por offer ----------
function isOfferExpired(ofr) {
  // mkt screen não expira (não tem janela de data)
  if (String(ofr?.channel || "") === "mktscreen") return false;

  const end = String(ofr?.endAt || "").trim();
  if (!end) return false;

  const endDt = new Date(end);
  if (isNaN(endDt.getTime())) return false;

  // compara com "hoje 00:00 local" (se end < hoje, expirou)
  const today0 = todayStartLocal();
  return endDt < today0;
}

function offerBorderClass(ofr) {
  // regra pedida: offers expirados => cinza (mesmo do disabled)
  return isOfferExpired(ofr) ? "status-disabled" : "status-active";
}

// ---------- Modal state ----------
let modalBound = false;
let currentModalEvent = null; // journey OU offer (só pra deletar card)
let aliasDirty = false;
let saveTimer = null;

function safeClassToggle(id, className, on) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle(className, on);
}

function showSaving(on) {
  safeClassToggle("saveState", "hidden", !on);
  if (on) safeClassToggle("saveOk", "hidden", true);
}

function showSavedOk() {
  const el = $("saveOk");
  if (!el) return;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 900);
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

  // só salva alias para journey
  if (currentModalEvent.space !== "journey") {
    aliasDirty = false;
    showSaving(false);
    return;
  }

  const titleEl = $("modalTitle");
  const newAlias = (titleEl?.textContent || "").trim();

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

    await refresh();
  } catch (err) {
    console.error(err);
    showSaving(false);
  }
}

// ---------- Modal binding ----------
function bindModalOnce() {
  if (modalBound) return;

  const modal = $("modal");
  const backdrop = $("modalClose");
  const btnDelete = $("btnDeleteCard");
  const btnDisable = $("btnDisableJourney");
  const titleEl = $("modalTitle");

  const missing = [];
  if (!modal) missing.push("modal");
  if (!backdrop) missing.push("modalClose");
  if (!btnDelete) missing.push("btnDeleteCard");
  if (!btnDisable) missing.push("btnDisableJourney");
  if (!titleEl) missing.push("modalTitle");

  if (missing.length) {
    console.error("IDs do modal não encontrados no HTML:", missing.join(", "));
    return;
  }

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

  btnDelete.addEventListener("click", async () => {
    if (!currentModalEvent?.itemId) return;
    const ok = confirm("Excluir este card inteiro (todos os eventos e offers dele)?");
    if (!ok) return;

    await dbDeleteItem(currentModalEvent.itemId);
    closeModal();
    await refresh();
  });

  btnDisable.addEventListener("click", async () => {
    if (!currentModalEvent?.itemId) return;
    if (currentModalEvent.space !== "journey") return;

    const ok = confirm("Confirmar: você já desativou a jornada na Adobe e quer marcar este card como 'Jornada desativada' aqui?");
    if (!ok) return;

    const item = await dbGetItem(currentModalEvent.itemId);
    if (!item) return;

    item.journeyDisabled = true;
    item.journeyDisabledAt = nowISO();
    item.updatedAt = nowISO();

    await dbPutItem(item);
    await refresh();
    closeModal();
  });

  titleEl.addEventListener("input", () => {
    if (currentModalEvent?.space !== "journey") return;
    aliasDirty = true;
    scheduleSave();
  });

  titleEl.addEventListener("blur", async () => {
    await saveAliasIfDirty();
  });

  modalBound = true;
}

function openModalBase(titleText, bodyHTML) {
  bindModalOnce();

  const titleEl = $("modalTitle");
  const bodyEl = $("modalBody");
  const modal = $("modal");

  if (!titleEl || !bodyEl || !modal) return;

  titleEl.textContent = titleText || "—";
  bodyEl.innerHTML = bodyHTML || "";

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  aliasDirty = false;
  showSaving(false);
  safeClassToggle("saveOk", "hidden", true);

  titleEl.focus();
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
  // hard rules do CALENDÁRIO
  if (ev.space !== "journey") return false;
  if (!ALLOWED_JOURNEY_CHANNELS.has(String(ev.channel || ""))) return false;

  // filtros do UI
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
    const cardStatus = computeCardStatus(it);

    for (const ev of (it.events || [])) {
      if (!ev?.at) continue;
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
        cardStatus,
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
      pill.className = `pill ${String(ev.channel || "push")} ${statusClass(ev.cardStatus)}`;

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

// ---------- Modal content (journey) ----------
function getChannelCountsForItem(item) {
  const cc = item?.channelCounts || {};
  const pairs = [
    ["push", "Push"],
    ["email", "Email"],
    ["whatsapp", "WhatsApp"],
    ["sms", "SMS"]
  ];

  const parts = [];
  for (const [k, label] of pairs) {
    const n = Number(cc?.[k] ?? 0) || 0;
    if (n > 0) parts.push(`${label} (${n})`);
  }
  return parts.join(" ");
}

function openEventModal(ev) {
  $("btnDisableJourney")?.classList.remove("hidden");

  currentModalEvent = ev;

  const item = getItemById(ev.itemId);
  const title = getDisplayName(ev);

  const cardName = (getDisplayName(ev) || "—").trim();
  const pos = getPosFromEvent(ev);
  const when = fmtDateOnly(ev.at);
  const commName = getComunicacaoName(ev);

  const counts = item ? getChannelCountsForItem(item) : "";
  const countsSuffix = counts ? ` | ${counts}` : "";

  const ch = String(ev.channel || "push").toUpperCase();

  const bodyHTML = `
    <div class="mb-journey">${escapeHTML(cardName)}</div>
    <div class="mb-date">${escapeHTML(`${pos} (${ch}) - ${when}${countsSuffix}`)}</div>
    <div class="mb-push">${escapeHTML(commName)}</div>
  `;

  openModalBase(title, bodyHTML);
}

function openDayModal(dayKey, entries) {
  const d = new Date(dayKey + "T00:00:00");
  const title = d.toLocaleDateString("pt-BR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "2-digit"
  });

  const itemsHTML = (entries || []).map((ev, idx) => {
    const ch = String(ev.channel || "push").toUpperCase();
    const when = fmtDateOnly(ev.at);
    const pos = getPosFromEvent(ev);
    const commName = getComunicacaoName(ev);

    return `
      <div class="pill ${String(ev.channel || "push")} ${statusClass(ev.cardStatus)} day-pill" data-idx="${idx}">
        <div class="t1">${escapeHTML(clampText(getDisplayName(ev), 90))}</div>
        <div class="t2">${escapeHTML(`${pos} (${ch}) - ${when}`)}</div>
        <div class="t3">${escapeHTML(commName)}</div>
      </div>
    `;
  }).join("");

  currentModalEvent = null;
  openModalBase(title, `<div class="day-modal-list">${itemsHTML || "Sem eventos."}</div>`);

  const bodyEl = $("modalBody");
  if (!bodyEl) return;

  bodyEl.querySelectorAll(".day-pill").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      const ev = entries?.[idx];
      if (ev) openEventModal(ev);
    });
  });
}

// ---------- OFFERS + MKTSCREEN ----------
function inferPosFromText(s) {
  const m = String(s || "").match(/\b(P\d+)\b/i);
  return m ? m[1].toUpperCase() : "NA";
}

function getOfferPos(ofr) {
  const pos = String(ofr?.meta?.posicaoJornada || "").trim();
  if (pos) return pos.toUpperCase();
  return inferPosFromText(ofr?.name || ofr?.label || "");
}

function fmtOfferLine2(ofr) {
  const ch = String(ofr.channel || "").toUpperCase();

  if (ofr.channel === "mktscreen") {
    const blocks = Number(ofr?.meta?.blocksCount ?? 0) || 0;
    return `${blocks || "—"} (${ch})`;
  }

  const pos = getOfferPos(ofr);
  const ini = ofr.startAt ? fmtDateOnly(ofr.startAt) : "—";
  const fim = ofr.endAt ? fmtDateOnly(ofr.endAt) : "—";
  return `${pos} (${ch}) | Início: ${ini} | Fim: ${fim}`;
}

function renderOffersLists() {
  const q = state.search.trim().toLowerCase();

  const offers = [];
  const mkts = [];

  for (const it of state.items) {
    const cardFull = getFullCardTitle(it);
    const arr = Array.isArray(it.offers) ? it.offers : [];

    for (const ofr of arr) {
      const nm = (ofr?.name || ofr?.label || "").trim();
      const hay = `${cardFull} ${nm} ${ofr.channel || ""} ${ofr?.meta?.deeplink || ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      const enriched = {
        ...ofr,
        itemId: it.id,
        itemFullTitle: cardFull
      };

      if (String(ofr.channel) === "mktscreen") mkts.push(enriched);
      else offers.push(enriched);
    }
  }

  offers.sort((a, b) => new Date(a.startAt || "2100-01-01") - new Date(b.startAt || "2100-01-01"));
  mkts.sort((a, b) => String(a.itemFullTitle).localeCompare(String(b.itemFullTitle)));

  const offersMeta = $("offersMeta");
  if (offersMeta) offersMeta.textContent = `Total de offers: ${offers.length}`;

  const mktMeta = $("mktMeta");
  if (mktMeta) mktMeta.textContent = `Total de mkt screens: ${mkts.length}`;

  const renderBox = (hostId, arr) => {
    const host = $(hostId);
    if (!host) return;

    host.innerHTML = "";
    if (!arr.length) {
      host.innerHTML = `<div class="hint">—</div>`;
      return;
    }

    for (const ofr of arr) {
      const card = document.createElement("div");

      // TARGET (mktscreen) = sempre borda neutra
      // OFFERS (banner/inapp) = verde quando ativo, cinza quando expirado
      const border = (String(ofr?.channel || "") === "mktscreen")
        ? "status-neutral"
        : offerBorderClass(ofr);

      card.className = `pill ${border}`;

      // EXTERNO: somente nome completo do card
      const t1 = document.createElement("div");
      t1.className = "t1";
      t1.textContent = clampText(ofr.itemFullTitle || "—", 140);

      card.appendChild(t1);

      card.addEventListener("click", (e) => {
        e.stopPropagation();
        openOfferModal(ofr);
      });

      host.appendChild(card);
    }
  };

  renderBox("offersList", offers);
  renderBox("mktList", mkts);
}

function openOfferModal(ofr) {
  // offers não tem "desativar jornada"
  $("btnDisableJourney")?.classList.add("hidden");

  currentModalEvent = ofr;

  const cardFull = (ofr.itemFullTitle || "—").trim();
  const ch = String(ofr.channel || "").toUpperCase();

  if (ofr.channel === "mktscreen") {
    const blocks = Number(ofr?.meta?.blocksCount ?? 0) || 0;
    const deeplink = (ofr?.meta?.deeplink || "—").trim();

    const bodyHTML = `
      <div class="mb-journey">${escapeHTML(cardFull)}</div>
      <div class="mb-date">${escapeHTML(`${blocks || "—"} (${ch})`)}</div>
      <div class="mb-push">${escapeHTML(deeplink)}</div>
    `;

    openModalBase(cardFull, bodyHTML);
    return;
  }

  const pos = getOfferPos(ofr);
  const ini = ofr.startAt ? fmtDateOnly(ofr.startAt) : "—";
  const fim = ofr.endAt ? fmtDateOnly(ofr.endAt) : "—";
  const nm = (ofr.name || ofr.label || "—").trim();

  const bodyHTML = `
    <div class="mb-journey">${escapeHTML(cardFull)}</div>
    <div class="mb-date">${escapeHTML(`${pos} (${ch}) | Início: ${ini} | Fim: ${fim}`)}</div>
    <div class="mb-push">${escapeHTML(nm)}</div>
  `;

  openModalBase(cardFull, bodyHTML);
}

// ---------- Data / actions ----------
async function refresh() {
  state.items = await dbGetAllItems();
  renderCalendar();
  renderOffersLists();
}

function makeDefaultAlias(fullTitle) {
  return String(fullTitle || "").trim() || "Card";
}

async function createFromCard() {
  const raw = $("inputCard").value || "";
  if (!raw.trim()) {
    alert("Cole o texto do card.");
    return;
  }

  const header = parseCardHeader(raw);
  const fullTitle = (header.headerLine || "").trim() || "Card";
  const name = header.displayName || header.headerLine || "Item";

  const parsed = parseCardChannels(raw, name);
  const parsedOffers = parseCardOffers(raw, name);

  if (parsed?.isPontual === false || parsedOffers?.isPontual === false) {
    alert("Este card não foi adicionado: identificado como ALWAYS-ON (não pontual).");
    return;
  }

  const hasJourney = Array.isArray(parsed?.events) && parsed.events.length > 0;
  const hasOffers = Array.isArray(parsedOffers?.offers) && parsedOffers.offers.length > 0;

  if (!hasJourney && !hasOffers) {
    alert("Nada para adicionar: não encontrei eventos de Jornada nem Offers/MktScreen neste card.");
    return;
  }

  if (hasJourney) {
    for (const ev of (parsed.events || [])) {
      if (!ev.alias || !String(ev.alias).trim()) {
        ev.alias = makeDefaultAlias(fullTitle);
      }
    }
  }

  const createdAt = nowISO();

  const safeEvents = hasJourney ? (parsed.events || []) : [];
  const channelCounts = hasJourney
    ? (parsed.channelCounts || {
        push: safeEvents.filter(e => e.channel === "push").length,
        email: safeEvents.filter(e => e.channel === "email").length,
        whatsapp: safeEvents.filter(e => e.channel === "whatsapp").length,
        sms: safeEvents.filter(e => e.channel === "sms").length
      })
    : { push: 0, email: 0, whatsapp: 0, sms: 0 };

  const item = {
    id: uuid(),
    name,
    fullTitle, // <-- NOVO: nome completo do card
    cardUrl: header.cardUrl || "",
    notes: "",
    createdAt,
    updatedAt: createdAt,

    journeyDisabled: false,
    journeyDisabledAt: "",

    channelCounts,
    events: safeEvents,

    offers: hasOffers ? (parsedOffers.offers || []) : []
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

// ---------- Export / Import ----------
const EXPORT_MAGIC = "ativas-extract";
const EXPORT_SCHEMA = 2;

function sanitizeItemsForExport(items) {
  return (items || []).map(it => ({
    id: String(it.id || "").trim() || uuid(),
    name: String(it.name || "").trim() || "Item",
    fullTitle: String(it.fullTitle || ""), // <-- NOVO
    cardUrl: String(it.cardUrl || ""),
    journeyDisabled: it.journeyDisabled === true,
    journeyDisabledAt: String(it.journeyDisabledAt || ""),
    channelCounts: {
      push: Number(it?.channelCounts?.push ?? 0) || 0,
      email: Number(it?.channelCounts?.email ?? 0) || 0,
      whatsapp: Number(it?.channelCounts?.whatsapp ?? 0) || 0,
      sms: Number(it?.channelCounts?.sms ?? 0) || 0
    },
    events: (it.events || [])
      .filter(e => e && e.space === "journey" && e.at && ALLOWED_JOURNEY_CHANNELS.has(String(e.channel || "")))
      .map(e => ({
        id: String(e.id || ""),
        space: "journey",
        channel: String(e.channel || "push"),
        kind: String(e.kind || "touch"),
        at: String(e.at || ""),
        label: String(e.label || ""),
        alias: String(e.alias || ""),
        meta: {
          posicaoJornada: String(e?.meta?.posicaoJornada || ""),
          nomeComunicacao: String(e?.meta?.nomeComunicacao || "")
        }
      })),
    offers: (it.offers || []).map(o => ({
      id: String(o.id || ""),
      space: "offers",
      channel: String(o.channel || ""),
      startAt: String(o.startAt || ""),
      endAt: String(o.endAt || ""),
      name: String(o.name || ""),
      label: String(o.label || ""),
      meta: {
        posicaoJornada: String(o?.meta?.posicaoJornada || ""),
        rawChannel: String(o?.meta?.rawChannel || ""),
        blocksCount: Number(o?.meta?.blocksCount ?? 0) || 0,
        deeplink: String(o?.meta?.deeplink || "")
      }
    }))
  }));
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportBackup() {
  await saveAliasIfDirty();

  const items = await dbGetAllItems();
  const minimal = sanitizeItemsForExport(items);

  const payload = {
    magic: EXPORT_MAGIC,
    schema: EXPORT_SCHEMA,
    exportedAt: nowISO(),
    items: minimal
  };

  const json = JSON.stringify(payload);

  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  const filename = `ativas_extract_backup_${y}${m}${day}_${hh}${mm}.json`;
  downloadTextFile(filename, json);
}

function isValidBackup(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.magic !== EXPORT_MAGIC) return false;
  if (!Array.isArray(obj.items)) return false;
  if (![1, 2].includes(Number(obj.schema))) return false;
  return true;
}

function normalizeImportedItem(raw) {
  const id = String(raw?.id || "").trim() || uuid();
  const name = String(raw?.name || "").trim() || "Item";
  const fullTitle = String(raw?.fullTitle || "").trim(); // <-- NOVO

  const channelCounts = raw?.channelCounts || {};
  const cc = {
    push: Number(channelCounts.push ?? 0) || 0,
    email: Number(channelCounts.email ?? 0) || 0,
    whatsapp: Number(channelCounts.whatsapp ?? 0) || 0,
    sms: Number(channelCounts.sms ?? 0) || 0
  };

  const events = Array.isArray(raw?.events) ? raw.events : [];
  const normalizedEvents = events
    .filter(e => e && e.at)
    .map(e => ({
      id: String(e.id || "").trim() || ("ev_" + uuid()),
      space: "journey",
      channel: String(e.channel || "push"),
      kind: String(e.kind || "touch"),
      at: String(e.at || ""),
      label: String(e.label || ""),
      alias: String(e.alias || ""),
      meta: {
        posicaoJornada: String(e?.meta?.posicaoJornada || ""),
        nomeComunicacao: String(e?.meta?.nomeComunicacao || "")
      }
    }))
    .filter(e => ALLOWED_JOURNEY_CHANNELS.has(String(e.channel || "")))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const anyCount = Object.values(cc).some(v => Number(v) > 0);
  if (!anyCount) {
    cc.push = 0; cc.email = 0; cc.whatsapp = 0; cc.sms = 0;
    for (const e of normalizedEvents) {
      const k = String(e.channel || "push");
      cc[k] = (cc[k] || 0) + 1;
    }
  }

  const offers = Array.isArray(raw?.offers) ? raw.offers : [];
  const normalizedOffers = offers.map(o => ({
    id: String(o.id || "").trim() || ("of_" + uuid()),
    space: "offers",
    channel: String(o.channel || ""),
    startAt: String(o.startAt || ""),
    endAt: String(o.endAt || ""),
    name: String(o.name || ""),
    label: String(o.label || ""),
    meta: {
      posicaoJornada: String(o?.meta?.posicaoJornada || ""),
      rawChannel: String(o?.meta?.rawChannel || ""),
      blocksCount: Number(o?.meta?.blocksCount ?? 0) || 0,
      deeplink: String(o?.meta?.deeplink || "")
    }
  })).filter(o => ["banner", "inapp", "mktscreen"].includes(String(o.channel || "")));

  const createdAt = String(raw?.createdAt || "") || nowISO();
  const updatedAt = String(raw?.updatedAt || "") || nowISO();

  return {
    id,
    name,
    fullTitle, // <-- NOVO
    cardUrl: String(raw?.cardUrl || ""),
    notes: String(raw?.notes || ""),
    createdAt,
    updatedAt,
    journeyDisabled: raw?.journeyDisabled === true,
    journeyDisabledAt: String(raw?.journeyDisabledAt || ""),
    channelCounts: cc,
    events: normalizedEvents,
    offers: normalizedOffers
  };
}

async function importBackupFromText(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    alert("Arquivo inválido: não é um JSON.");
    return;
  }

  if (!isValidBackup(parsed)) {
    alert("Backup inválido (magic/schema).");
    return;
  }

  const incoming = parsed.items || [];
  const normalized = incoming.map(normalizeImportedItem);

  const mode = prompt(
    "Importar backup:\n\nDigite 1 para SUBSTITUIR tudo (apaga o atual)\nDigite 2 para MESCLAR (mantém o atual e adiciona/atualiza por ID)\n\nPadrão: 2",
    "2"
  );

  const doReplace = String(mode || "2").trim() === "1";

  if (doReplace) {
    const ok = confirm("Isso vai APAGAR tudo que está salvo localmente e substituir pelo backup. Continuar?");
    if (!ok) return;
    await dbClearAll();
  }

  const existing = await dbGetAllItems();
  const byId = new Map(existing.map(it => [it.id, it]));

  for (const it of normalized) {
    const cur = byId.get(it.id);

    if (!cur) {
      await dbPutItem(it);
      continue;
    }

    const merged = {
      ...cur,
      name: it.name || cur.name,
      fullTitle: it.fullTitle || cur.fullTitle, // <-- NOVO
      cardUrl: it.cardUrl || cur.cardUrl,
      journeyDisabled: it.journeyDisabled === true,
      journeyDisabledAt: it.journeyDisabledAt || cur.journeyDisabledAt,
      updatedAt: nowISO()
    };

    const curEvents = Array.isArray(cur.events) ? cur.events : [];
    const evMap = new Map(curEvents.map(e => [e.id, e]));

    for (const e of (it.events || [])) {
      const prev = evMap.get(e.id);
      if (!prev) evMap.set(e.id, e);
      else {
        evMap.set(e.id, {
          ...prev,
          ...e,
          meta: { ...(prev.meta || {}), ...(e.meta || {}) },
          alias: (String(e.alias || "").trim() ? e.alias : (prev.alias || ""))
        });
      }
    }

    merged.events = Array.from(evMap.values())
      .filter(e => e && e.at && ALLOWED_JOURNEY_CHANNELS.has(String(e.channel || "")))
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    const curOffers = Array.isArray(cur.offers) ? cur.offers : [];
    const ofMap = new Map(curOffers.map(o => [o.id, o]));

    for (const o of (it.offers || [])) {
      const prev = ofMap.get(o.id);
      if (!prev) ofMap.set(o.id, o);
      else ofMap.set(o.id, { ...prev, ...o, meta: { ...(prev.meta || {}), ...(o.meta || {}) } });
    }

    merged.offers = Array.from(ofMap.values())
      .filter(o => o && ["banner", "inapp", "mktscreen"].includes(String(o.channel || "")));

    const counts = { push: 0, email: 0, whatsapp: 0, sms: 0 };
    for (const e of (merged.events || [])) {
      const k = String(e.channel || "push");
      counts[k] = (counts[k] || 0) + 1;
    }
    merged.channelCounts = { ...counts };

    await dbPutItem(merged);
  }

  await refresh();
  alert("Import concluído.");
}

async function importBackupFromFile(file) {
  if (!file) return;
  const text = await file.text();
  await importBackupFromText(text);
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
  renderOffersLists();
});

$("filterChannel").addEventListener("change", (e) => {
  state.filterChannel = e.target.value;
  renderCalendar();
  renderOffersLists();
});

$("searchBox").addEventListener("input", (e) => {
  state.search = e.target.value || "";
  renderCalendar();
  renderOffersLists();
});

$("btnWipeAll").addEventListener("click", async () => {
  const ok = confirm("Apagar tudo que está salvo localmente neste navegador?");
  if (!ok) return;
  await dbClearAll();
  await refresh();
});

$("btnExport")?.addEventListener("click", exportBackup);

$("btnImport")?.addEventListener("click", () => {
  const inp = $("fileImport");
  if (!inp) return;
  inp.value = "";
  inp.click();
});

$("fileImport")?.addEventListener("change", async (e) => {
  const file = e.target?.files?.[0];
  if (!file) return;
  await importBackupFromFile(file);
});

// init
bindModalOnce();
await refresh();
gotoToday();
