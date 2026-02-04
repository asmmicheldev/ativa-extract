import { dbGetAllItems, dbPutItem, dbSetMeta } from "./db.js";
import { nowISO, uuid } from "./utils.js";

export async function exportBackup() {
  const items = await dbGetAllItems();

  const payload = {
    app: "AtivasExtract",
    version: 2,
    exportedAt: nowISO(),
    items: items.map(it => ({
      id: it.id,
      name: it.name,
      alwaysOn: it.alwaysOn,
      incidentPaused: it.incidentPaused,
      archived: !!it.archived,
      cardUrl: it.cardUrl || "",
      notes: it.notes || "",
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,

      effectiveStart: it.effectiveStart || null,
      effectiveEnd: it.effectiveEnd || null,
      bufferEnd: it.bufferEnd || null,
      windowStart: it.windowStart || null,
      windowEnd: it.windowEnd || null,
      nextReviewAt: it.nextReviewAt || null,

      // compact
      events: Array.isArray(it.events) ? it.events : [],
      channels: it.channels || { push:[], banner:[], mktScreen:{ url:"", blocks:[] } }
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ativas_extract_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  await dbSetMeta("lastExportAt", payload.exportedAt);
  return payload.exportedAt;
}

export async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (!data || data.app !== "AtivasExtract" || !Array.isArray(data.items)) {
    throw new Error("Arquivo inválido (não parece um backup do Ativas Extract).");
  }

  for (const raw of data.items) {
    const id = raw.id || uuid();
    const item = {
      id,
      name: raw.name || "Item",
      alwaysOn: raw.alwaysOn || "no",
      incidentPaused: raw.incidentPaused || "no",
      archived: !!raw.archived,
      cardUrl: raw.cardUrl || "",
      notes: raw.notes || "",
      createdAt: raw.createdAt || nowISO(),
      updatedAt: nowISO(),

      effectiveStart: raw.effectiveStart || null,
      effectiveEnd: raw.effectiveEnd || null,
      bufferEnd: raw.bufferEnd || null,
      windowStart: raw.windowStart || null,
      windowEnd: raw.windowEnd || null,
      nextReviewAt: raw.nextReviewAt || null,

      events: Array.isArray(raw.events) ? raw.events : [],
      channels: raw.channels || { push:[], banner:[], mktScreen:{ url:"", blocks:[] } }
    };
    await dbPutItem(item);
  }

  if (data.exportedAt) {
    await dbSetMeta("lastExportAt", data.exportedAt);
  }

  return data.items.length;
}
