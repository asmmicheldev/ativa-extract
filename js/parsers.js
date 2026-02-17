// js/parsers.js (COMPLETO)
import { parseAnyISOish, stableHash } from "./utils.js";

const ALLOWED_JOURNEY_CHANNELS = new Set(["push", "email", "whatsapp", "sms"]);
const ALLOWED_OFFER_CHANNELS = new Set(["inapp", "banner", "mktscreen"]);

function normalizeChannel(raw) {
  const s = String(raw || "").toLowerCase().trim();

  if (s.includes("push")) return "push";
  if (s.includes("email") || s.includes("e-mail")) return "email";
  if (s.includes("whatsapp") || s.includes("wpp") || s.includes("zap")) return "whatsapp";
  if (s.includes("sms")) return "sms";

  if (s.includes("inapp") || s.includes("in-app") || s.includes("in app")) return "inapp";
  if (s.includes("banner")) return "banner";
  if (s.includes("mktscreen") || s.includes("marketing screen") || s.includes("mkt screen")) return "mktscreen";
  if (/\bmkt\b/.test(s)) return "mktscreen";

  return "outro";
}

function detectPontual(rawText) {
  const t = String(rawText || "").toLowerCase();
  if (t.includes("always-on") || t.includes("always on") || t.includes("alwayson") || t.includes("always_on")) return false;
  if (t.includes("pontual") || t.includes("pontuai")) return true;
  return true;
}

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
 * Parser Journey (calendário)
 */
export function parseCardChannels(rawText, itemNameForLabels = "") {
  const isPontual = detectPontual(rawText);
  if (!isPontual) {
    return {
      isPontual: false,
      events: [],
      channelCounts: { push: 0, email: 0, whatsapp: 0, sms: 0 }
    };
  }

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim());

  let section = null;
  let current = null;

  const comms = [];

  const commitCurrent = () => {
    if (!current) return;
    if (ALLOWED_JOURNEY_CHANNELS.has(String(current.channel || ""))) comms.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const comm = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(([^)]+)\)/i);
    if (comm) {
      commitCurrent();

      const chRaw = comm[1] || "";
      const ch = normalizeChannel(chRaw);

      if (!ALLOWED_JOURNEY_CHANNELS.has(ch)) {
        section = null;
        current = null;
        continue;
      }

      section = ch;
      current = { channel: ch, posicaoJornada: "", dataInicio: null, nomeComunicacao: "" };
      continue;
    }

    if (current && section && ALLOWED_JOURNEY_CHANNELS.has(section)) {
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
  }

  commitCurrent();

  const events = [];
  const counts = { push: 0, email: 0, whatsapp: 0, sms: 0 };

  for (const c of comms) {
    counts[c.channel] = (counts[c.channel] || 0) + 1;
    if (!c.dataInicio) continue;

    const pos = c.posicaoJornada || "";
    const nome = c.nomeComunicacao || "";
    const label = nome
      ? `${c.channel.toUpperCase()} ${pos} — ${nome}`.trim()
      : `${c.channel.toUpperCase()} ${pos}`.trim();

    const evIdSeed = `${itemNameForLabels}|journey|${c.channel}|touch|${c.dataInicio}|${label}|${nome}`;
    const id = "ev_" + stableHash(evIdSeed);

    events.push({
      id,
      space: "journey",
      channel: c.channel,
      kind: "touch",
      at: c.dataInicio,
      label,
      meta: {
        posicaoJornada: pos,
        nomeComunicacao: nome
      },
      alias: ""
    });
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { isPontual: true, events, channelCounts: counts };
}

/**
 * Parser OFFERS (InApp/Banner/MktScreen)
 * - Agora pega posicao P0/P4 do CABEÇALHO: "COMUNICAÇÃO X - P0 (BANNER)"
 * - Também aceita posicaoJornada: dentro do bloco (fallback)
 * - MktScreen: pega Blocos + Deeplink, e ignora posição na UI (mas guarda se vier)
 */
export function parseCardOffers(rawText, itemNameForLabels = "") {
  const isPontual = detectPontual(rawText);
  if (!isPontual) return { isPontual: false, offers: [] };

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim());

  let section = null;
  let current = null;

  const offersRaw = [];

  const parseISO = (v) => {
    const dt = parseAnyISOish(String(v || "").trim());
    return dt ? dt.toISOString() : "";
  };

  const commit = () => {
    if (!current) return;
    if (ALLOWED_OFFER_CHANNELS.has(String(current.channel || ""))) offersRaw.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // pega cabeçalho com posição e canal:
    // "---------- COMUNICAÇÃO 6 - P0 (BANNER) ----------"
    const comm2 = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+\s*-\s*(P\d+)\s*\(([^)]+)\)/i);
    if (comm2) {
      commit();

      const posFromHeader = (comm2[1] || "").trim();
      const rawChannel = (comm2[2] || "").trim();
      const ch = normalizeChannel(rawChannel);

      if (!ALLOWED_OFFER_CHANNELS.has(ch)) {
        section = null;
        current = null;
        continue;
      }

      section = ch;
      current = {
        channel: ch,
        rawChannel,
        posicaoJornada: posFromHeader || "",
        startAt: "",
        endAt: "",
        name: "",
        blocksCount: 0,
        deeplink: ""
      };
      continue;
    }

    // fallback: cabeçalho antigo sem posição explícita
    const comm = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(([^)]+)\)/i);
    if (comm) {
      commit();

      const rawChannel = (comm[1] || "").trim();
      const ch = normalizeChannel(rawChannel);

      if (!ALLOWED_OFFER_CHANNELS.has(ch)) {
        section = null;
        current = null;
        continue;
      }

      // tenta inferir P? do texto do header se existir
      const posGuess = (line.match(/\b(P\d+)\b/i)?.[1] || "").toUpperCase();

      section = ch;
      current = {
        channel: ch,
        rawChannel,
        posicaoJornada: posGuess || "",
        startAt: "",
        endAt: "",
        name: "",
        blocksCount: 0,
        deeplink: ""
      };
      continue;
    }

    if (current && section && ALLOWED_OFFER_CHANNELS.has(section)) {
      const pj = line.match(/^posicaoJornada:\s*(.+)$/i);
      if (pj) {
        // só sobrescreve se vier algo útil
        const v = pj[1].trim();
        if (v && v.toUpperCase() !== "NA") current.posicaoJornada = v;
        continue;
      }

      const di = line.match(/^dataInicio:\s*(.+)$/i);
      if (di) { current.startAt = parseISO(di[1]); continue; }

      const df =
        line.match(/^dataFim:\s*(.+)$/i) ||
        line.match(/^dataFinal:\s*(.+)$/i) ||
        line.match(/^dataEncerramento:\s*(.+)$/i) ||
        line.match(/^dataTermino:\s*(.+)$/i) ||
        line.match(/^dataT[eé]rmino:\s*(.+)$/i);

      if (df) { current.endAt = parseISO(df[1]); continue; }

      const ne = line.match(/^Nome Experiência:\s*(.+)$/i);
      if (ne) { current.name = ne[1].trim(); continue; }

      const nc = line.match(/^Nome Campanha:\s*(.+)$/i);
      if (nc && !current.name) { current.name = nc[1].trim(); continue; }

      const ncom = line.match(/^Nome Comunicação:\s*(.+)$/i);
      if (ncom && !current.name) { current.name = ncom[1].trim(); continue; }

      if (section === "mktscreen") {
        const bl = line.match(/^Blocos:\s*(\d+)/i);
        if (bl) { current.blocksCount = Number(bl[1]) || 0; continue; }

        const url = line.match(/^URL:\s*(appxpinvestimentos:\/\/\S+)/i);
        if (url) { current.deeplink = url[1].trim(); continue; }

        const url2 = line.match(/^MktScreen\s*URL:\s*(appxpinvestimentos:\/\/\S+)/i);
        if (url2) { current.deeplink = url2[1].trim(); continue; }
      }

      continue;
    }
  }

  commit();

  const offers = offersRaw.map((o) => {
    const name = (o.name || "").trim();
    const labelBase = name ? name : `${String(o.channel || "").toUpperCase()}`;

    const idSeed = `${itemNameForLabels}|offers|${o.channel}|${o.posicaoJornada || ""}|${o.startAt || ""}|${o.endAt || ""}|${labelBase}|${o.deeplink || ""}|${o.blocksCount || 0}`;
    const id = "of_" + stableHash(idSeed);

    return {
      id,
      space: "offers",
      channel: o.channel, // inapp|banner|mktscreen
      startAt: o.startAt || "",
      endAt: o.endAt || "",
      name: name,
      label: labelBase,
      meta: {
        posicaoJornada: (o.posicaoJornada || "").trim(),
        rawChannel: o.rawChannel || "",
        blocksCount: Number(o.blocksCount ?? 0) || 0,
        deeplink: o.deeplink || ""
      }
    };
  });

  return { isPontual: true, offers };
}
