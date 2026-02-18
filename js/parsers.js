//parsers.js
import { parseAnyISOish, stableHash } from "./utils.js";

const ALLOWED_JOURNEY_CHANNELS = new Set(["push", "email", "whatsapp", "sms"]);
const ALLOWED_OFFER_CHANNELS = new Set(["inapp", "banner", "mktscreen"]);

const LONG_RUNNING_DAYS_THRESHOLD = 183;

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

function toISOOrEmpty(raw) {
  const dt = parseAnyISOish(String(raw || "").trim());
  return dt ? dt.toISOString() : "";
}

function diffDays(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const a = new Date(startISO).getTime();
  const b = new Date(endISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ms = b - a;
  if (ms < 0) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function isLongRunningOffer(startISO, endISO) {
  const d = diffDays(startISO, endISO);
  if (d === null) return false;
  return d >= LONG_RUNNING_DAYS_THRESHOLD;
}

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

export function parseCardChannels(rawText, itemNameForLabels = "") {
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
      current = { channel: ch, posicaoJornada: "", dataInicio: "", nomeComunicacao: "" };
      continue;
    }

    if (current && section && ALLOWED_JOURNEY_CHANNELS.has(section)) {
      const pj = line.match(/^posicaoJornada:\s*(.+)$/i);
      if (pj) { current.posicaoJornada = pj[1].trim(); continue; }

      const di = line.match(/^dataInicio:\s*(.+)$/i);
      if (di) { current.dataInicio = toISOOrEmpty(di[1]); continue; }

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

    const pos = c.posicaoJornada || "";
    const nome = c.nomeComunicacao || "";

    const label = nome
      ? `${c.channel.toUpperCase()} ${pos} — ${nome}`.trim()
      : `${c.channel.toUpperCase()} ${pos}`.trim();

    const at = c.dataInicio || "";

    const evIdSeed = `${itemNameForLabels}|journey|${c.channel}|touch|${at || "NO_DATE"}|${label}|${nome}`;
    const id = "ev_" + stableHash(evIdSeed);

    events.push({
      id,
      space: "journey",
      channel: c.channel,
      kind: "touch",
      at,
      label,
      meta: {
        posicaoJornada: pos,
        nomeComunicacao: nome,
        alwaysOn: false
      },
      alias: ""
    });
  }

  events.sort((a, b) => {
    const da = a.at ? new Date(a.at).getTime() : Infinity;
    const db = b.at ? new Date(b.at).getTime() : Infinity;
    return da - db;
  });

  return { isPontual: true, events, channelCounts: counts };
}

export function parseCardOffers(rawText, itemNameForLabels = "") {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim());

  let section = null;
  let current = null;

  const offersRaw = [];

  const commit = () => {
    if (!current) return;
    if (ALLOWED_OFFER_CHANNELS.has(String(current.channel || ""))) offersRaw.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const comm2 = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+\s*-\s*(P\d+|NA)\s*\(([^)]+)\)/i);
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
        posicaoJornada: posFromHeader && posFromHeader.toUpperCase() !== "NA" ? posFromHeader : "",
        startAt: "",
        endAt: "",
        name: "",
        blocksCount: 0,
        deeplink: ""
      };
      continue;
    }

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
        const v = pj[1].trim();
        if (v && v.toUpperCase() !== "NA") current.posicaoJornada = v;
        continue;
      }

      const di = line.match(/^dataInicio:\s*(.+)$/i);
      if (di) { current.startAt = toISOOrEmpty(di[1]); continue; }

      const df =
        line.match(/^dataFim:\s*(.+)$/i) ||
        line.match(/^dataFinal:\s*(.+)$/i) ||
        line.match(/^dataEncerramento:\s*(.+)$/i) ||
        line.match(/^dataTermino:\s*(.+)$/i) ||
        line.match(/^dataT[eé]rmino:\s*(.+)$/i);
      if (df) { current.endAt = toISOOrEmpty(df[1]); continue; }

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

    const startAt = o.startAt || "";
    const endAt = o.endAt || "";

    const alwaysOnNoEnd =
      String(o.channel || "") !== "mktscreen" &&
      !String(endAt || "").trim();

    const alwaysOnLong =
      Boolean(startAt && endAt && isLongRunningOffer(startAt, endAt));

    const alwaysOn = alwaysOnNoEnd || alwaysOnLong;

    const runningDays = diffDays(startAt, endAt);

    const idSeed = `${itemNameForLabels}|offers|${o.channel}|${o.posicaoJornada || ""}|${startAt || ""}|${endAt || ""}|${labelBase}|${o.deeplink || ""}|${o.blocksCount || 0}`;
    const id = "of_" + stableHash(idSeed);

    return {
      id,
      space: "offers",
      channel: o.channel,
      startAt,
      endAt,
      name,
      label: labelBase,
      meta: {
        posicaoJornada: (o.posicaoJornada || "").trim(),
        rawChannel: o.rawChannel || "",
        blocksCount: Number(o.blocksCount ?? 0) || 0,
        deeeplink: o.deeplink || "",
        deeplink: o.deeplink || "",
        alwaysOn,
        runningDays: Number.isFinite(runningDays) ? runningDays : null
      }
    };
  });

  const hasAlwaysOn = offers.some(o => o?.meta?.alwaysOn === true);
  return { isPontual: !hasAlwaysOn, offers };
}
