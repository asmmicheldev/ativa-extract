import { dbGetAllItems, dbPutItem, dbDeleteItem, dbGetMeta } from "./db.js";
import { exportBackup, importBackup } from "./backup.js";
import { parseCardHeader } from "./parsers.js";
import { parseCardChannels } from "./parsers.js";
import {
  uuid, nowISO, fmtDateTime, fmtDate, startOfDay, addDays, clampText
} from "./utils.js";

let state = {
  items: [],
  selectedId: null,
  view: "incident",
  search: ""
};

const $ = (id) => document.getElementById(id);

function badgeForArchived(archived) {
  return archived ? { text:"Arquivado", cls:"" } : { text:"Ativo", cls:"blue" };
}

function badgeForIncidentPaused(v) {
  return v === "yes" ? { text:"Incidente", cls:"red" } : null;
}

function computeBufferEndISO(effectiveEndISO, bufferDays = 1) {
  if (!effectiveEndISO) return null;
  const d = new Date(effectiveEndISO);
  if (isNaN(d.getTime())) return null;
  const d2 = addDays(d, bufferDays);
  return d2.toISOString();
}

function computeNextReviewISO(alwaysOn) {
  if (alwaysOn !== "yes") return null;
  const d = addDays(new Date(), 14);
  return d.toISOString();
}

function nextEventDate(item) {
  const now = new Date();
  const future = (item.events || [])
    .map(e => new Date(e.at))
    .filter(d => !isNaN(d.getTime()))
    .filter(d => d >= now)
    .sort((x,y)=>x-y);
  return future[0] || null;
}

function filterItems(items) {
  const q = state.search.trim().toLowerCase();

  let out = items.filter(it => {
    if (q) {
      const hay = `${it.name} ${it.cardUrl || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const now = new Date();
  const day0 = startOfDay(now);
  const day7 = addDays(day0, 7);

  if (state.view === "archived") {
    out = out.filter(it => !!it.archived);
  } else {
    out = out.filter(it => !it.archived);
  }

  if (state.view === "alwaysOn") {
    out = out.filter(it => it.alwaysOn === "yes");
  } else if (state.view === "activeToday") {
    out = out.filter(it => {
      if (it.alwaysOn === "yes") return true;
      const ws = it.windowStart ? new Date(it.windowStart) : null;
      const we = it.windowEnd ? new Date(it.windowEnd) : null;
      if (ws && we) return ws <= now && now <= we;
      if (ws && !we) return ws <= now;
      // se não tiver janela, considera se tem evento hoje
      return (it.events || []).some(ev => {
        const d = new Date(ev.at);
        return d >= day0 && d < addDays(day0, 1);
      });
    });
  } else if (state.view === "incident") {
    out = out.filter(it => {
      const hasUpcomingEvent = (it.events || []).some(ev => {
        const d = new Date(ev.at);
        return d >= day0 && d < day7;
      });

      if (hasUpcomingEvent) return true;

      // banner ativo hoje
      const ws = it.windowStart ? new Date(it.windowStart) : null;
      const we = it.windowEnd ? new Date(it.windowEnd) : null;
      if (ws && we && ws <= now && now <= we) return true;

      if (it.alwaysOn === "yes") return true;

      // buffer útil
      if (it.bufferEnd) {
        const b = new Date(it.bufferEnd);
        if (b >= day0 && b < addDays(day0, 2)) return true;
      }

      return false;
    });
  }

  out.sort((a,b) => {
    const aNext = nextEventDate(a) || new Date(a.updatedAt || 0);
    const bNext = nextEventDate(b) || new Date(b.updatedAt || 0);
    return aNext - bNext;
  });

  return out;
}

function renderList() {
  const host = $("itemsList");
  host.innerHTML = "";

  const items = filterItems(state.items);

  if (!items.length) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "Nenhum item para este filtro.";
    host.appendChild(div);
    return;
  }

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "list-item" + (it.id === state.selectedId ? " active" : "");
    div.onclick = () => selectItem(it.id);

    const top = document.createElement("div");
    top.className = "li-top";

    const title = document.createElement("div");
    title.className = "li-title";
    title.textContent = clampText(it.name, 70);

    const badges = document.createElement("div");
    badges.style.display = "flex";
    badges.style.gap = "6px";
    badges.style.alignItems = "center";

    const aB = badgeForArchived(!!it.archived);
    const b1 = document.createElement("span");
    b1.className = `badge ${aB.cls}`;
    b1.textContent = aB.text;
    badges.appendChild(b1);

    const inc = badgeForIncidentPaused(it.incidentPaused);
    if (inc) {
      const b2 = document.createElement("span");
      b2.className = `badge ${inc.cls}`;
      b2.textContent = inc.text;
      badges.appendChild(b2);
    }

    if (it.alwaysOn === "yes") {
      const b3 = document.createElement("span");
      b3.className = "badge green";
      b3.textContent = "Always On";
      badges.appendChild(b3);
    }

    top.appendChild(title);
    top.appendChild(badges);

    const meta = document.createElement("div");
    meta.className = "li-meta";

    const next = nextEventDate(it);
    const nextTxt = next ? `Próximo: ${fmtDateTime(next)}` : (it.alwaysOn === "yes" ? "Always On (sem eventos)" : "Sem eventos");
    const endTxt = it.bufferEnd ? ` | Buffer: ${fmtDate(it.bufferEnd)}` : "";
    meta.textContent = nextTxt + endTxt;

    div.appendChild(top);
    div.appendChild(meta);

    host.appendChild(div);
  }
}

function renderEventsTable(item) {
  const evs = Array.isArray(item.events) ? item.events : [];
  if (!evs.length) {
    $("eventsTable").innerHTML = `<div class="hint">Sem eventos extraídos.</div>`;
    return;
  }

  const rows = evs.map(e => `
    <tr>
      <td>${e.label || e.kind || "Evento"}</td>
      <td>${e.channel || "—"}</td>
      <td>${fmtDateTime(e.at)}</td>
    </tr>
  `).join("");

  $("eventsTable").innerHTML = `
    <table class="table">
      <thead><tr><th>Evento</th><th>Canal</th><th>Data/Hora</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderPushTable(item) {
  const push = item.channels?.push || [];
  if (!push.length) {
    $("pushTable").innerHTML = `<div class="hint">Sem push no card.</div>`;
    return;
  }

  const rows = push.map(p => `
    <tr>
      <td>${p.posicaoJornada || "—"}</td>
      <td><div class="small-mono">${(p.nome || "—")}</div></td>
      <td>${p.titulo || "—"}</td>
      <td>${fmtDateTime(p.dataInicio)}</td>
      <td><div class="small-mono">${p.url || "—"}</div></td>
    </tr>
  `).join("");

  $("pushTable").innerHTML = `
    <table class="table">
      <thead><tr><th>P</th><th>Nome</th><th>Título</th><th>Data</th><th>URL</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderBannerTable(item) {
  const banners = item.channels?.banner || [];
  if (!banners.length) {
    $("bannerTable").innerHTML = `<div class="hint">Sem banner no card.</div>`;
    return;
  }

  const rows = banners.map(b => `
    <tr>
      <td><div class="small-mono">${b.nomeExperiencia || "—"}</div></td>
      <td>${b.tela || "—"}</td>
      <td>${b.channel || "—"}</td>
      <td>${fmtDateTime(b.dataInicio)}</td>
      <td>${fmtDateTime(b.dataFim)}</td>
      <td><div class="small-mono">${b.ctaUrl || "—"}</div></td>
    </tr>
  `).join("");

  $("bannerTable").innerHTML = `
    <table class="table">
      <thead><tr><th>Experiência</th><th>Tela</th><th>Channel</th><th>Início</th><th>Fim</th><th>CTA URL</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMktScreen(item) {
  const ms = item.channels?.mktScreen || { url:"", blocks:[] };

  $("mktInfo").innerHTML = ms.url
    ? `<div class="meta"><span class="k">URL:</span> <span class="small-mono">${ms.url}</span></div>`
    : `<div class="hint">Sem Marketing Screen no card.</div>`;

  if (!ms.blocks?.length) {
    $("mktBlocks").innerHTML = ms.url ? `<div class="hint">Sem blocos extraídos (ou card não tem POSIÇÃO/Template).</div>` : "";
    return;
  }

  const rows = ms.blocks
    .sort((a,b)=> (a.posicao||0) - (b.posicao||0))
    .map(b => `
      <tr>
        <td>${b.posicao ?? "—"}</td>
        <td>${b.template || "—"}</td>
        <td>${b.titulo || "—"}</td>
        <td><div class="small-mono">${b.ctaUrl || "—"}</div></td>
      </tr>
    `).join("");

  $("mktBlocks").innerHTML = `
    <table class="table">
      <thead><tr><th>Pos</th><th>Template</th><th>Título</th><th>CTA</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderDetail() {
  const item = state.items.find(x => x.id === state.selectedId);
  if (!item) {
    $("detail").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    return;
  }

  $("emptyState").classList.add("hidden");
  $("detail").classList.remove("hidden");

  $("detailTitle").textContent = item.name;

  $("fieldName").value = item.name || "";
  $("fieldCardUrl").value = item.cardUrl || "";
  $("fieldAlwaysOn").value = item.alwaysOn || "no";
  $("fieldIncidentPaused").value = item.incidentPaused || "no";
  $("fieldNotes").value = item.notes || "";

  const info = [];
  info.push(`Criado: ${fmtDateTime(item.createdAt)}`);
  info.push(`Atualizado: ${fmtDateTime(item.updatedAt)}`);
  if (item.archived) info.push("Arquivado: sim");
  $("eventsInfo").textContent = info.join(" | ");

  $("effectiveStart").textContent = item.effectiveStart ? fmtDateTime(item.effectiveStart) : "—";
  $("effectiveEnd").textContent = item.effectiveEnd ? fmtDateTime(item.effectiveEnd) : "—";
  $("bufferEnd").textContent = item.bufferEnd ? fmtDateTime(item.bufferEnd) : "—";
  $("nextReview").textContent = item.nextReviewAt ? fmtDateTime(item.nextReviewAt) : "—";

  renderEventsTable(item);
  renderPushTable(item);
  renderBannerTable(item);
  renderMktScreen(item);

  renderTimeline();
}

function renderTimeline() {
  const items = filterItems(state.items);

  const now = new Date();
  const start = startOfDay(now);
  const days = state.view === "incident" ? 8 : 14;

  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const key = d.toISOString().slice(0,10);
    map.set(key, []);
  }

  for (const it of items) {
    for (const ev of (it.events || [])) {
      const dt = new Date(ev.at);
      if (isNaN(dt.getTime())) continue;
      if (dt < start || dt >= addDays(start, days)) continue;
      const key = dt.toISOString().slice(0,10);
      if (!map.has(key)) continue;
      map.get(key).push({
        id: it.id,
        name: it.name,
        label: ev.label || ev.kind,
        channel: ev.channel || "—",
        at: ev.at
      });
    }
  }

  for (const [k, arr] of map.entries()) {
    arr.sort((a,b)=> new Date(a.at) - new Date(b.at));
  }

  const host = $("timeline");
  host.innerHTML = "";

  for (const [dayISO, entries] of map.entries()) {
    const box = document.createElement("div");
    box.className = "timeline-day";

    const title = document.createElement("h4");
    const d = new Date(dayISO + "T00:00:00");
    title.textContent = d.toLocaleDateString("pt-BR", { weekday:"short", year:"numeric", month:"2-digit", day:"2-digit" });
    box.appendChild(title);

    if (!entries.length) {
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Sem eventos.";
      box.appendChild(h);
    } else {
      for (const e of entries) {
        const li = document.createElement("div");
        li.className = "timeline-item";
        li.style.cursor = "pointer";
        li.onclick = () => selectItem(e.id);

        li.innerHTML = `
          <div style="font-weight:700;font-size:12px">${fmtDateTime(e.at)} — ${e.label} (${e.channel})</div>
          <div style="font-size:12px;color:#6b7280">${clampText(e.name, 90)}</div>
        `;
        box.appendChild(li);
      }
    }

    host.appendChild(box);
  }
}

async function refresh() {
  state.items = await dbGetAllItems();
  renderList();
  renderDetail();
}

function selectItem(id) {
  state.selectedId = id;
  renderList();
  renderDetail();
}

async function createFromCard() {
  const raw = $("inputCard").value || "";
  if (!raw.trim()) {
    alert("Cole o texto do card.");
    return;
  }

  const alwaysOn = $("selectAlwaysOn").value;
  const incidentPaused = $("selectIncidentPaused").value;

  const header = parseCardHeader(raw);
  const parsed = parseCardChannels(raw);

  const createdAt = nowISO();
  const effectiveEnd = parsed.effectiveEnd;
  const bufferEnd = (alwaysOn === "yes") ? null : computeBufferEndISO(effectiveEnd, 1);
  const nextReviewAt = computeNextReviewISO(alwaysOn);

  const item = {
    id: uuid(),
    name: header.displayName || header.headerLine || "Item",
    alwaysOn,
    incidentPaused,
    archived: false,
    cardUrl: header.cardUrl || "",
    notes: "",
    createdAt,
    updatedAt: createdAt,

    windowStart: parsed.windowStart || null,
    windowEnd: parsed.windowEnd || null,
    effectiveStart: parsed.effectiveStart || null,
    effectiveEnd: effectiveEnd || null,
    bufferEnd,
    nextReviewAt,

    events: parsed.events || [],
    channels: parsed.channels || { push:[], banner:[], mktScreen:{ url:"", blocks:[] } }
  };

  await dbPutItem(item);

  $("inputCard").value = "";
  await refresh();
  selectItem(item.id);
}

async function saveDetail() {
  const item = state.items.find(x => x.id === state.selectedId);
  if (!item) return;

  item.name = $("fieldName").value.trim() || "Item";
  item.cardUrl = $("fieldCardUrl").value.trim();
  item.alwaysOn = $("fieldAlwaysOn").value;
  item.incidentPaused = $("fieldIncidentPaused").value;
  item.notes = $("fieldNotes").value || "";
  item.updatedAt = nowISO();

  item.nextReviewAt = computeNextReviewISO(item.alwaysOn);
  if (item.alwaysOn === "yes") item.bufferEnd = null;
  else item.bufferEnd = item.bufferEnd || computeBufferEndISO(item.effectiveEnd, 1);

  await dbPutItem(item);
  await refresh();
}

async function reparseSelected() {
  const item = state.items.find(x => x.id === state.selectedId);
  if (!item) return;

  const raw = prompt("Cole novamente o texto do card (isso atualiza canais/datas/eventos).");
  if (!raw || !raw.trim()) return;

  const header = parseCardHeader(raw);
  const parsed = parseCardChannels(raw);

  item.name = item.name || header.displayName || "Item";
  item.cardUrl = item.cardUrl || header.cardUrl || "";

  item.events = parsed.events || [];
  item.channels = parsed.channels || item.channels;

  item.windowStart = parsed.windowStart || null;
  item.windowEnd = parsed.windowEnd || null;
  item.effectiveStart = parsed.effectiveStart || null;
  item.effectiveEnd = parsed.effectiveEnd || null;

  if (item.alwaysOn !== "yes") item.bufferEnd = computeBufferEndISO(item.effectiveEnd, 1);
  item.updatedAt = nowISO();

  await dbPutItem(item);
  await refresh();
}

async function archiveSelected() {
  const item = state.items.find(x => x.id === state.selectedId);
  if (!item) return;
  const ok = confirm(`Arquivar "${item.name}"?`);
  if (!ok) return;
  item.archived = true;
  item.updatedAt = nowISO();
  await dbPutItem(item);
  state.selectedId = null;
  await refresh();
}

async function deleteSelected() {
  const item = state.items.find(x => x.id === state.selectedId);
  if (!item) return;
  const ok = confirm(`Deletar "${item.name}"? Isso não tem como desfazer.`);
  if (!ok) return;
  await dbDeleteItem(item.id);
  state.selectedId = null;
  await refresh();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  document.querySelector(`.chip[data-view="${view}"]`)?.classList.add("active");
  renderList();
  renderDetail();
}

async function initBackupStamp() {
  const last = await dbGetMeta("lastExportAt");
  $("backupStamp").textContent = last ? `Último backup: ${fmtDateTime(last)}` : "Último backup: —";
}

async function runExport() {
  try {
    const when = await exportBackup();
    await initBackupStamp();
    alert(`Backup exportado. Data: ${fmtDateTime(when)}`);
  } catch (e) {
    alert("Falha ao exportar backup: " + (e?.message || e));
  }
}

async function runImport(file) {
  try {
    const n = await importBackup(file);
    await refresh();
    await initBackupStamp();
    alert(`Import concluído. Itens importados/mesclados: ${n}`);
  } catch (e) {
    alert("Falha ao importar backup: " + (e?.message || e));
  }
}

// bindings
$("btnParseCreate").onclick = createFromCard;
$("btnClearInput").onclick = () => ($("inputCard").value = "");
$("btnSave").onclick = saveDetail;
$("btnReparse").onclick = reparseSelected;
$("btnArchive").onclick = archiveSelected;
$("btnDelete").onclick = deleteSelected;

$("btnExport").onclick = runExport;

$("fileImport").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  await runImport(f);
  e.target.value = "";
});

$("searchBox").addEventListener("input", (e) => {
  state.search = e.target.value || "";
  renderList();
});

document.querySelectorAll(".chip").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

// init
await refresh();
await initBackupStamp();
setView("incident");
