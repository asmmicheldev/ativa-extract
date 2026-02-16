// js/parsers.js
import { parseAnyISOish, stableHash } from "./utils.js";

/**
 * Header: primeira linha não vazia + primeira URL
 */
export function parseCardHeader(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  let first = "";
  let url = "";

  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (!first) first = t;
    if (!url && /^https?:\/\//i.test(t)) url = t;
    if (first && url) break;
  }

  let displayName = first || "Item";
  const parts = (first || "").split(" - ");
  if (parts.length >= 2) displayName = parts.slice(0, 2).join(" - ").trim();

  return { headerLine: first, cardUrl: url, displayName };
}

/**
 * Parser mix (fase calendário):
 * - extrai Push (COMUNICAÇÃO ... (PUSH)) e transforma em events
 * - CONTABILIZA quantas COMUNICAÇÕES por tipo (push/banner/mktscreen) para exibir no modal
 */
export function parseCardChannels(rawText, itemNameForLabels = "") {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim());

  let section = null; // push|banner|mktscreen|null
  let current = null;

  const pushes = [];
  let bannerCount = 0;
  let mktScreenCount = 0;

  const commitCurrent = () => {
    if (!current) return;
    if (section === "push") pushes.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const comm = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(([^)]+)\)/i);
    if (comm) {
      commitCurrent();

      const ch = (comm[1] || "").toLowerCase();
      if (ch.includes("push")) {
        section = "push";
        current = { posicaoJornada: "", dataInicio: null, nomeComunicacao: "" };
      } else if (ch.includes("banner")) {
        section = "banner";
        bannerCount += 1;
      } else if (ch.includes("mktscreen") || ch.includes("marketing") || ch.includes("mkt")) {
        section = "mktscreen";
        mktScreenCount += 1; // cada "COMUNICAÇÃO ... (MKTSCREEN)" conta 1
      } else {
        section = null;
      }

      continue;
    }

    if (section === "push" && current) {
      const pj = line.match(/^posicaoJornada:\s*(.+)$/i);
      if (pj) { current.posicaoJornada = pj[1].trim(); continue; }

      const di = line.match(/^dataInicio:\s*(.+)$/i);
      if (di) {
        const dt = parseAnyISOish(di[1].trim());
        if (dt) current.dataInicio = dt.toISOString();
        continue;
      }

      const nn = line.match(/^Nome Comunicação:\s*(.+)$/i);
      if (nn) { current.nomeComunicacao = nn[1].trim(); continue; }

      continue;
    }

    // outras seções ignoradas por enquanto
  }

  commitCurrent();

  const events = [];

  for (const p of pushes) {
    if (!p.dataInicio) continue; // AON sem data -> futuro
    const pos = p.posicaoJornada || "";
    const nome = p.nomeComunicacao || "";
    const label = nome ? `Push ${pos} — ${nome}`.trim() : `Push ${pos}`.trim();

    const evIdSeed = `${itemNameForLabels}|journey|push|touch|${p.dataInicio}|${label}|${nome}`;
    const id = "ev_" + stableHash(evIdSeed);

    events.push({
      id,
      space: "journey",
      channel: "push",
      kind: "touch",
      at: p.dataInicio,

      label,
      meta: {
        posicaoJornada: pos,
        nomeComunicacao: nome
      },
      alias: ""
    });
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const channelCounts = {
    push: pushes.length,
    banner: bannerCount,
    mktScreen: mktScreenCount
  };

  return { events, channelCounts };
}
