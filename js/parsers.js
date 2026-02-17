// js/parsers.js (COMPLETO)
// Regras deste parser (fase calendário):
// - Só extrai COMUNICAÇÃO ... que sejam CANAIS DE JORNADA (Push/Email/WhatsApp/SMS)
// - Ignora Banner e InApp por enquanto (Offers)
// - Só retorna eventos se o card for PONTUAL (se detectar Always-On, bloqueia)
import { parseAnyISOish, stableHash } from "./utils.js";

const ALLOWED_JOURNEY_CHANNELS = new Set(["push", "email", "whatsapp", "sms"]);

function normalizeChannel(raw) {
  const s = String(raw || "").toLowerCase().trim();

  if (s.includes("push")) return "push";
  if (s.includes("email") || s.includes("e-mail")) return "email";
  if (s.includes("whatsapp") || s.includes("wpp") || s.includes("zap")) return "whatsapp";
  if (s.includes("sms")) return "sms";

  // ignorados por enquanto (offers)
  if (s.includes("inapp") || s.includes("in-app") || s.includes("in app")) return "inapp";
  if (s.includes("banner")) return "banner";
  if (s.includes("mktscreen") || s.includes("marketing screen") || s.includes("mkt screen") || s.includes("mkt")) return "mktscreen";

  return "outro";
}

function detectPontual(rawText) {
  const t = String(rawText || "").toLowerCase();

  // sinais fortes de always-on
  if (t.includes("always-on") || t.includes("always on") || t.includes("alwayson") || t.includes("always_on")) return false;

  // sinais de pontual (se tiver, ótimo)
  if (t.includes("pontual") || t.includes("pontuai")) return true;

  // fallback: se não detectou always-on, assume pontual (pra não te travar)
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
 * Parser mix (fase calendário):
 * - extrai comunicações por canal (Jornada) e transforma em events
 * - retorna isPontual e channelCounts (somente canais permitidos)
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

  let section = null; // "push"|"email"|"whatsapp"|"sms"|...|null
  let current = null;

  const comms = []; // { channel, posicaoJornada, dataInicio, nomeComunicacao }

  const commitCurrent = () => {
    if (!current) return;
    // só comita se for canal permitido
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

      // se for banner/inapp/etc, ignora (apenas não cria "current")
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

    // AON sem data -> não entra no calendário
    if (!c.dataInicio) continue;

    const pos = c.posicaoJornada || "";
    const nome = c.nomeComunicacao || "";
    const label = nome ? `${c.channel.toUpperCase()} ${pos} — ${nome}`.trim() : `${c.channel.toUpperCase()} ${pos}`.trim();

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
