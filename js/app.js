// js/app.js
import { dbGetAllItems, dbPutItem, dbClearAll, dbDeleteItem } from "./db.js";
import { parseCardHeader, parseCardChannels } from "./parsers.js";
import { uuid, nowISO, dayKeyLocal, fmtDateTime, clampText, startOfMonth, endOfMonth, addDays } from "./utils.js";

let state = {
  items: [],
  monthCursor: startOfMonth(new Date()),
  filterSpace: "journey",
  filterChannel: "push",
  search: ""
};

const $ = (id) => document.getElementById(id);

// guarda contexto do modal (pra excluir o card)
let modalCtx = { itemId: null, dayKey: null };

function monthLabel(d) {
  return d.toLocaleDateString("pt-BR", { month:"long", year:"numeric" });
}

function passesFilters(ev, itemName) {
  // calendário = Journey/Push apenas
  if (ev.space !== "journey") return false;
  if (ev.channel !== "push") return false;

  const q = state.search.trim().toLowerCase();
  if (q) {
    const hay = `${itemName} ${ev.label || ""}`.toLowerCase();
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
    arr.sort((a,b) => new Date(a.at) - new Date(b.at));
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

function pillClass() {
  return "pill push";
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
      pill.className = pillClass(ev);

      const t1 = document.createElement("div");
      t1.className = "t1";
      t1.textContent = clampText(ev.label || "Push", 42);

      const t2 = document.createElement("div");
      t2.className = "t2";
      t2.textContent = `${clampText(ev.itemName || "Card", 42)} • ${fmtDateTime(ev.at).slice(11,16)}`;

      pill.appendChild(t1);
      pill.appendChild(t2);

      pill.onclick = () => openModal(ev);
      pillsHost.appendChild(pill);
    }

    if (hidden > 0) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `+${hidden} itens`;
      more.onclick = () => openDayModal(key, entries);
      pillsHost.appendChild(more);
    }

    cell.onclick = (e) => {
      if (e.target.closest(".pill") || e.target.closest(".more")) return;
      if (entries.length) openDayModal(key, entries);
    };

    cell.appendChild(pillsHost);
    grid.appendChild(cell);
  }

  $("emptyHint").classList.toggle("hidden", totalVisible > 0);
}

function openModal(ev) {
  modalCtx.itemId = ev.itemId || null;
  modalCtx.dayKey = null;

  $("modalTitle").textContent = `${ev.itemName || "Card"} — Journey/Push`;
  $("modalBody").textContent =
`Evento: ${ev.label || "—"}
Quando: ${fmtDateTime(ev.at)}
Tipo: ${ev.kind || "—"}`;

  $("modal").classList.remove("hidden");
  $("modal").setAttribute("aria-hidden", "false");
}

function openDayModal(dayKey, entries) {
  modalCtx.itemId = null;
  modalCtx.dayKey = dayKey;

  const d = new Date(dayKey + "T00:00:00");
  $("modalTitle").textContent = d.toLocaleDateString("pt-BR", { weekday:"long", year:"numeric", month:"long", day:"2-digit" });

  const lines = entries.map(ev => {
    const hhmm = fmtDateTime(ev.at).slice(11,16);
    return `• ${hhmm}  ${ev.label}\n  ${ev.itemName}`;
  }).join("\n\n");

  $("modalBody").textContent = lines || "Sem eventos.";
  $("modal").classList.remove("hidden");
  $("modal").setAttribute("aria-hidden", "false");
}

function closeModal() {
  modalCtx.itemId = null;
  modalCtx.dayKey = null;
  $("modal").classList.add("hidden");
  $("modal").setAttribute("aria-hidden", "true");
}

async function refresh() {
  state.items = await dbGetAllItems();
  renderCalendar();
}

/**
 * Identificador “simples” do card para evitar duplicação:
 * - prioridade: cardUrl (se existir)
 * - fallback: nome (displayName/headerLine)
 */
function findExistingItem({ cardUrl, name }) {
  const url = (cardUrl || "").trim();
  if (url) {
    return state.items.find(it => (it.cardUrl || "").trim() === url) || null;
  }
  const nm = (name || "").trim().toLowerCase();
  if (!nm) return null;
  return state.items.find(it => (it.name || "").trim().toLowerCase() === nm) || null;
}

function eventsFingerprint(events) {
  // fingerprint simples para detectar “mesmo conteúdo”
  const arr = (events || []).map(e => `${e.space}|${e.channel}|${e.kind}|${e.at}|${e.label || ""}`);
  arr.sort();
  return arr.join("||");
}

async function createFromCard() {
  const raw = $("inputCard").value || "";
  if (!raw.trim()) {
    alert("Cole o texto do card.");
    return;
  }

  const header = parseCardHeader(raw);
  const name = header.displayName || header.headerLine || "Item";
  const parsed = parseCardChannels(raw, name);

  // se não tiver nenhum push extraído, nem salva (evita “card vazio”)
  const newEvents = parsed.events || [];
  if (!newEvents.length) {
    alert("Nenhum Push (Journey) foi encontrado nesse card. Nada foi adicionado.");
    return;
  }

  const existing = findExistingItem({ cardUrl: header.cardUrl, name });

  if (existing) {
    // evita duplicar e permite “atualizar datas” do mesmo card
    const oldFp = eventsFingerprint(existing.events || []);
    const newFp = eventsFingerprint(newEvents);

    if (oldFp === newFp) {
      alert("Esse card já existe e não há mudanças de Push/datas. Não fiz nada.");
      return;
    }

    const ok = confirm(
      `Esse card já existe.\n\nQuer ATUALIZAR (substituir) os pushes salvos por estes novos?\n\n` +
      `Isso resolve mudanças de data e evita duplicação.`
    );
    if (!ok) return;

    existing.name = existing.name || name;
    existing.cardUrl = existing.cardUrl || (header.cardUrl || "");
    existing.channels = parsed.channels || existing.channels;
    existing.events = newEvents;
    existing.updatedAt = nowISO();

    await dbPutItem(existing);
    $("inputCard").value = "";
    await refresh();
    return;
  }

  // novo item
  const createdAt = nowISO();
  const item = {
    id: uuid(),
    name,
    cardUrl: header.cardUrl || "",
    createdAt,
    updatedAt: createdAt,
    events: newEvents,
    channels: parsed.channels || { push:[], banner:[], mktScreen:{ url:"", blocks:[] } }
  };

  await dbPutItem(item);
  $("inputCard").value = "";
  await refresh();
}

async function deleteCardFromModal() {
  const id = modalCtx.itemId;
  if (!id) {
    alert("Abra um evento (pill) para excluir o card inteiro.");
    return;
  }
  const it = state.items.find(x => x.id === id);
  const ok = confirm(`Excluir o card inteiro?\n\n${it?.name || id}\n\nIsso remove todos os pushes desse card.`);
  if (!ok) return;

  await dbDeleteItem(id);
  closeModal();
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

// bindings
$("btnParseCreate").onclick = createFromCard;
$("btnClearInput").onclick = () => ($("inputCard").value = "");

$("btnPrev").onclick = () => shiftMonth(-1);
$("btnNext").onclick = () => shiftMonth(1);
$("btnToday").onclick = gotoToday;

// trava selects (UI)
const spaceSel = $("filterSpace");
const chanSel = $("filterChannel");
if (spaceSel) { spaceSel.value = "journey"; spaceSel.disabled = true; }
if (chanSel) { chanSel.value = "push"; chanSel.disabled = true; }

$("searchBox").addEventListener("input", (e) => {
  state.search = e.target.value || "";
  renderCalendar();
});

$("btnWipeAll").onclick = async () => {
  const ok = confirm("Apagar tudo que está salvo localmente neste navegador?");
  if (!ok) return;
  await dbClearAll();
  await refresh();
};

$("modalClose").onclick = closeModal;
$("modalCloseBtn").onclick = closeModal;

const delBtn = $("modalDeleteBtn");
if (delBtn) delBtn.onclick = deleteCardFromModal;

// init
await refresh();
gotoToday();
