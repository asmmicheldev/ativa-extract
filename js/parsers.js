// js/parsers.js
import { parseAnyISOish } from "./utils.js";

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
 * Parser mix (fase calendário Journey-only):
 * - extrai seções, mas só gera eventos para PUSH (Journey)
 * Retorna:
 *   { channels, events }  // events = somente {space:"journey", channel:"push", ...}
 */
export function parseCardChannels(rawText, itemNameForLabels = "") {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim());

  const channels = {
    push: [],
    banner: [],
    mktScreen: { url: "", blocks: [] }
  };

  let section = null; // push|banner|mktscreen
  let current = null;
  let currentBlock = null;

  const commitCurrent = () => {
    if (!current) return;
    if (section === "push") channels.push.push(current);
    if (section === "banner") channels.banner.push(current);
    current = null;
  };

  const commitBlock = () => {
    if (!currentBlock) return;
    channels.mktScreen.blocks.push(currentBlock);
    currentBlock = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const comm = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(([^)]+)\)/i);
    if (comm) {
      commitCurrent();
      commitBlock();

      const ch = (comm[1] || "").toLowerCase();
      if (ch.includes("push")) section = "push";
      else if (ch.includes("banner")) section = "banner";
      else if (ch.includes("mktscreen") || ch.includes("marketing") || ch.includes("mkt")) section = "mktscreen";
      else section = null;

      if (section === "push") current = { posicaoJornada:"", dataInicio:null, nome:"", titulo:"", url:"" };
      if (section === "banner") current = { dataInicio:null, dataFim:null, nomeExperiencia:"", tela:"", channel:"" };

      continue;
    }

    // (mantemos parse de mktscreen/banner só para "channels" existir, mas não vira evento)
    if (section === "mktscreen") {
      const mUrl = line.match(/^URL:\s*(.+)$/i);
      if (mUrl && !channels.mktScreen.url) {
        channels.mktScreen.url = mUrl[1].trim();
        continue;
      }

      const pos = line.match(/^-{2,}\s*POSIÇÃO\s*(\d+)/i);
      if (pos) {
        commitBlock();
        currentBlock = { posicao:+pos[1], template:"", titulo:"", ctaUrl:"" };
        continue;
      }

      if (currentBlock) {
        const t1 = line.match(/^Template:\s*(.+)$/i);
        if (t1) { currentBlock.template = t1[1].trim(); continue; }

        const tt = line.match(/^Titulo:\s*(.+)$/i);
        if (tt) { currentBlock.titulo = tt[1].trim(); continue; }

        const cta = line.match(/^(URL|ctaUrl|URL de Redirecionamento):\s*(.+)$/i);
        if (cta) { currentBlock.ctaUrl = cta[2].trim(); continue; }
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
      if (nn) { current.nome = nn[1].trim(); continue; }

      const ti = line.match(/^Título:\s*(.+)$/i);
      if (ti) { current.titulo = ti[1].trim(); continue; }

      const ur = line.match(/^URL de Redirecionamento:\s*(.+)$/i);
      if (ur) { current.url = ur[1].trim(); continue; }

      continue;
    }

    if (section === "banner" && current) {
      const di = line.match(/^dataInicio:\s*(.+)$/i);
      if (di) {
        const dt = parseAnyISOish(di[1].trim());
        if (dt) current.dataInicio = dt.toISOString();
        continue;
      }

      const df = line.match(/^dataFim:\s*(.+)$/i);
      if (df) {
        const dt = parseAnyISOish(df[1].trim());
        if (dt) current.dataFim = dt.toISOString();
        continue;
      }

      const ne = line.match(/^Nome Experiência:\s*(.+)$/i);
      if (ne) { current.nomeExperiencia = ne[1].trim(); continue; }

      const tl = line.match(/^Tela:\s*(.+)$/i);
      if (tl) { current.tela = tl[1].trim(); continue; }

      const ch = line.match(/^Channel:\s*(.+)$/i);
      if (ch) { current.channel = ch[1].trim(); continue; }

      continue;
    }
  }

  commitCurrent();
  commitBlock();

  // >>> CALENDÁRIO: SOMENTE PUSH (Journey)
  const events = [];

  for (const p of channels.push) {
    if (!p.dataInicio) continue;
    const labelCore = p.nome
      ? `Push ${p.posicaoJornada || ""} — ${p.nome}`
      : `Push ${p.posicaoJornada || ""}`.trim();

    events.push({
      space: "journey",
      channel: "push",
      kind: "touch",
      label: labelCore,
      at: p.dataInicio,
      itemName: itemNameForLabels || ""
    });
  }

  events.sort((a,b) => new Date(a.at) - new Date(b.at));

  return { channels, events };
}
