import { parseAnyISOish } from "./utils.js";

/**
 * Header: pega primeira linha e primeira URL
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
  if (parts.length >= 2) {
    displayName = parts.slice(0, 2).join(" - ").trim();
  }

  return { headerLine: first, cardUrl: url, displayName };
}

/**
 * Parser de canais (mix):
 * - Push: COMUNICAÇÃO ... (PUSH) + dataInicio + Nome Comunicação + Título/Subtítulo + URL de Redirecionamento
 * - Banner: COMUNICAÇÃO ... (BANNER) + dataInicio + dataFim + Nome Experiência + Tela/Channel + URL/Imagem
 * - MktScreen: COMUNICAÇÃO ... (MKTSCREEN) + URL + Blocos/POSIÇÃO + Template/Titulo/Subtitulo/Imagem/CTA/JSON
 *
 * Resultado:
 * {
 *   channels: { push:[], banner:[], mktScreen:{ url:"", blocks:[] } },
 *   events: [{label, at, kind, channel}],
 *   windowStart, windowEnd,
 *   effectiveStart, effectiveEnd
 * }
 */
export function parseCardChannels(rawText) {
  const lines = String(rawText || "").split(/\r?\n/).map(l => l.replace(/\t/g," ").trim());

  const channels = {
    push: [],
    banner: [],
    mktScreen: { url: "", blocks: [] }
  };

  const events = [];
  let windowStart = null;
  let windowEnd = null;

  let section = null; // "push" | "banner" | "mktscreen" | null
  let current = null; // objeto de push/banner
  let currentBlock = null; // mktscreen block

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

  const setMinISO = (iso) => {
    if (!iso) return;
    if (!windowStart || new Date(iso) < new Date(windowStart)) windowStart = iso;
  };
  const setMaxISO = (iso) => {
    if (!iso) return;
    if (!windowEnd || new Date(iso) > new Date(windowEnd)) windowEnd = iso;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Detecta início de seção de comunicação
    const comm = line.match(/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(([^)]+)\)/i);
    if (comm) {
      // fecha o que estiver aberto
      commitCurrent();
      commitBlock();

      const ch = comm[1].toLowerCase();
      if (ch.includes("push")) section = "push";
      else if (ch.includes("banner")) section = "banner";
      else if (ch.includes("mktscreen") || ch.includes("marketing") || ch.includes("mkt")) section = "mktscreen";
      else section = null;

      if (section === "push") current = { posicaoJornada:"", dataInicio:null, nome:"", titulo:"", subtitulo:"", url:"", utm:"" };
      if (section === "banner") current = { dataInicio:null, dataFim:null, nomeExperiencia:"", tela:"", channel:"", ctaUrl:"", imageUrl:"", titulo:"", subtitulo:"" };
      continue;
    }

    // Detecta início MktScreen (às vezes tem um header específico)
    if (/^-{2,}\s*COMUNICAÇÃO\s*\d+.*\(MKTSCREEN\)/i.test(line)) {
      // já coberto pelo regex acima
    }

    // MktScreen URL principal
    if (section === "mktscreen") {
      const mUrl = line.match(/^URL:\s*(.+)$/i);
      if (mUrl && !channels.mktScreen.url) {
        channels.mktScreen.url = mUrl[1].trim();
        continue;
      }

      // início de bloco
      const pos = line.match(/^-{2,}\s*POSIÇÃO\s*(\d+)/i);
      if (pos) {
        commitBlock();
        currentBlock = { posicao: +pos[1], template:"", titulo:"", subtitulo:"", imageUrl:"", ctaUrl:"", rawJson:"" };
        continue;
      }

      if (currentBlock) {
        const t1 = line.match(/^Template:\s*(.+)$/i);
        if (t1) { currentBlock.template = t1[1].trim(); continue; }

        const tt = line.match(/^Titulo:\s*(.+)$/i);
        if (tt) { currentBlock.titulo = tt[1].trim(); continue; }

        const st = line.match(/^Subtitulo:\s*(.+)$/i);
        if (st) { currentBlock.subtitulo = st[1].trim(); continue; }

        const im = line.match(/^Imagem:\s*(.+)$/i);
        if (im) { currentBlock.imageUrl = im[1].trim(); continue; }

        const cta = line.match(/^(URL|ctaUrl|URL de Redirecionamento):\s*(.+)$/i);
        if (cta) { currentBlock.ctaUrl = cta[2].trim(); continue; }

        // JSON (captura “JSON do ...:” e o bloco seguinte {...})
        if (/^JSON/i.test(line)) {
          // tenta capturar bloco JSON logo adiante (simples)
          let buf = "";
          for (let j = i+1; j < Math.min(i+80, lines.length); j++) {
            const l2 = lines[j];
            if (l2.includes("{") || buf) buf += l2 + "\n";
            if (buf && l2.includes("}")) { i = j; break; }
          }
          currentBlock.rawJson = buf.trim();
          continue;
        }
      }

      continue; // não cai no push/banner
    }

    // Push fields
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

      const su = line.match(/^Subtítulo:\s*(.+)$/i);
      if (su) { current.subtitulo = su[1].trim(); continue; }

      const ur = line.match(/^URL de Redirecionamento:\s*(.+)$/i);
      if (ur) { current.url = ur[1].trim(); continue; }

      const ut = line.match(/^UTM:\s*(.+)$/i);
      if (ut) { current.utm = ut[1].trim(); continue; }

      continue;
    }

    // Banner fields
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

      const ti = line.match(/^Titulo:\s*(.+)$/i);
      if (ti) { current.titulo = ti[1].trim(); continue; }

      const st = line.match(/^Subtitulo:\s*(.+)$/i);
      if (st) { current.subtitulo = st[1].trim(); continue; }

      const ur = line.match(/^URL de Redirecionamento:\s*(.+)$/i);
      if (ur) { current.ctaUrl = ur[1].trim(); continue; }

      const im = line.match(/^Imagem:\s*(.+)$/i);
      if (im) { current.imageUrl = im[1].trim(); continue; }

      continue;
    }
  }

  // fecha objetos abertos
  commitCurrent();
  commitBlock();

  // cria eventos a partir dos canais
  for (const p of channels.push) {
    if (p.dataInicio) {
      events.push({
        kind: "touch",
        channel: "push",
        label: p.nome ? `Push ${p.posicaoJornada || ""} — ${p.nome}` : `Push ${p.posicaoJornada || ""}`.trim(),
        at: p.dataInicio
      });
      setMinISO(p.dataInicio);
      setMaxISO(p.dataInicio);
    }
  }

  for (const b of channels.banner) {
    if (b.dataInicio) {
      events.push({
        kind: "start",
        channel: "banner",
        label: b.nomeExperiencia ? `Banner start — ${b.nomeExperiencia}` : "Banner start",
        at: b.dataInicio
      });
      setMinISO(b.dataInicio);
    }
    if (b.dataFim) {
      events.push({
        kind: "end",
        channel: "banner",
        label: b.nomeExperiencia ? `Banner end — ${b.nomeExperiencia}` : "Banner end",
        at: b.dataFim
      });
      setMaxISO(b.dataFim);
    }
  }

  // Ordena eventos
  events.sort((a,b) => new Date(a.at) - new Date(b.at));

  const effectiveStart = windowStart;
  // Fim efetivo: último touch push se existir, senão windowEnd, senão último evento
  const lastPush = [...events].reverse().find(e => e.channel === "push");
  const effectiveEnd = lastPush?.at || windowEnd || (events.length ? events[events.length-1].at : null);

  return {
    channels,
    events,
    windowStart,
    windowEnd,
    effectiveStart,
    effectiveEnd
  };
}
