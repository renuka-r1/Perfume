/*
 * Scent engine: builds the catalogue, classifies season / time of day,
 * measures similarity between perfumes, and learns the user's taste.
 */
(function () {
  const ACCORD_KEYS = Object.keys(window.ACCORDS);
  const SEASONS = ["spring", "summer", "fall", "winter"];
  const TIMES = ["day", "night"];

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  const idOf = (house, name) => (norm(house) + "|" + norm(name)).replace(/ /g, "-");

  /* ---------- accords ---------- */

  // Ordered accord list → weighted vector (strongest accord = 1).
  function weightAccords(list) {
    const v = {};
    list.forEach((a, i) => { if (window.ACCORDS[a]) v[a] = Math.max(v[a] || 0, Math.max(0.4, 1 - i * 0.15)); });
    return v;
  }

  // Free text notes → weighted accords, ordered by first mention.
  function accordsFromText(text) {
    const t = norm(text);
    if (!t) return {};
    const hits = [];
    window.NOTE_KEYWORDS.forEach(([re, accord]) => {
      const m = t.match(re);
      if (m) hits.push({ accord, at: m.index });
    });
    hits.sort((a, b) => a.at - b.at);
    const order = [];
    hits.forEach((h) => { if (!order.includes(h.accord)) order.push(h.accord); });
    return weightAccords(order);
  }

  function vec(accords) { return ACCORD_KEYS.map((k) => accords[k] || 0); }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  /* ---------- season & time of day ---------- */

  function climateScores(accords) {
    const s = [0, 0, 0, 0, 0, 0];
    let total = 0;
    for (const [a, w] of Object.entries(accords)) {
      const c = window.ACCORD_CLIMATE[a];
      if (!c) continue;
      c.forEach((x, i) => (s[i] += x * w));
      total += w;
    }
    return total ? s.map((x) => x / total) : [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  }

  function classify(accords) {
    const sc = climateScores(accords);
    const seasonScores = sc.slice(0, 4);
    const top = Math.max(...seasonScores);
    const seasons = SEASONS.filter((_, i) => seasonScores[i] >= Math.max(0.5, top * 0.82));
    if (!seasons.length) seasons.push(SEASONS[seasonScores.indexOf(top)]);
    const [day, night] = [sc[4], sc[5]];
    const times = [];
    if (day >= 0.55) times.push("day");
    if (night >= 0.55) times.push("night");
    if (!times.length) times.push(day >= night ? "day" : "night");
    return { seasons, times, scores: { spring: sc[0], summer: sc[1], fall: sc[2], winter: sc[3], day, night } };
  }

  function parseSeasons(text) {
    const t = norm(text);
    if (!t) return null;
    if (/\ball\b|year|any|every|versatile/.test(t)) return SEASONS.slice();
    const out = [];
    if (/spring/.test(t)) out.push("spring");
    if (/summer/.test(t)) out.push("summer");
    if (/fall|autumn/.test(t)) out.push("fall");
    if (/winter/.test(t)) out.push("winter");
    return out.length ? out : null;
  }

  function parseTimes(text) {
    const t = norm(text);
    if (!t) return null;
    if (/both|any|versatile|\ball\b/.test(t)) return TIMES.slice();
    const out = [];
    if (/day|morning|office|work|casual|afternoon/.test(t)) out.push("day");
    if (/night|evening|date|party|going out|club/.test(t)) out.push("night");
    return out.length ? out : null;
  }

  /* ---------- catalogue ---------- */

  function isBudget(house) { return window.BUDGET_HOUSES.includes(norm(house)); }

  function makeItem(house, name, extra) {
    return Object.assign({
      id: idOf(house, name), house: house || "", name, kind: "original",
      accords: {}, notes: "", dupeOf: [], dupes: [], explicitSeasons: null, explicitTimes: null, fromSheet: false,
    }, extra || {});
  }

  /*
   * records: [{ house, name, accords?, notes?, dupes: [[house, name]], seasons?, times?, fromSheet? }]
   * Later records merge into earlier ones, so imported rows refine the seed.
   */
  function buildCatalog(records) {
    const byId = new Map();
    const byName = new Map();

    function find(house, name) {
      const id = idOf(house, name);
      if (byId.has(id)) return byId.get(id);
      const n = norm(name);
      const list = byName.get(n) || [];
      // Same name, house written differently ("MFK" vs "Maison Francis Kurkdjian"):
      // treat as the same perfume when the name is unambiguous.
      if (list.length === 1 || !house) return list[0] || null;
      return list.find((x) => !x.house) || null;
    }
    function upsert(house, name, extra) {
      let item = find(house, name);
      if (!item) {
        item = makeItem(house, name);
        byId.set(item.id, item);
        const n = norm(name);
        byName.set(n, (byName.get(n) || []).concat(item));
      } else if (house && !item.house) {
        item.house = house;
      }
      if (extra) {
        if (extra.accords && Object.keys(extra.accords).length) item.accords = extra.accords;
        if (extra.notes) item.notes = extra.notes;
        if (extra.seasons) item.explicitSeasons = extra.seasons;
        if (extra.times) item.explicitTimes = extra.times;
        if (extra.fromSheet) item.fromSheet = true;
      }
      return item;
    }

    for (const r of records) {
      if (!r.name) continue;
      const accords = r.accords || accordsFromText(r.notes);
      const orig = upsert(r.house, r.name, { accords, notes: r.notes, seasons: r.seasons, times: r.times, fromSheet: r.fromSheet });
      for (const [dh, dn, dNotes] of r.dupes || []) {
        if (!dn) continue;
        const d = upsert(dh, dn, dNotes ? { accords: accordsFromText(dNotes), notes: dNotes, fromSheet: r.fromSheet } : { fromSheet: r.fromSheet });
        d.kind = "dupe";
        if (!d.dupeOf.includes(orig.id)) d.dupeOf.push(orig.id);
        if (!orig.dupes.includes(d.id)) orig.dupes.push(d.id);
      }
    }

    const items = [...byId.values()];
    // A dupe without its own notes borrows the scent profile of what it copies.
    for (const it of items) {
      if (!Object.keys(it.accords).length && it.dupeOf.length) {
        const src = byId.get(it.dupeOf[0]);
        it.accords = Object.fromEntries(Object.entries(src.accords).map(([k, w]) => [k, +(w * 0.95).toFixed(3)]));
        if (!it.notes) it.notes = src.notes;
        if (!it.explicitSeasons && src.explicitSeasons) it.explicitSeasons = src.explicitSeasons;
        if (!it.explicitTimes && src.explicitTimes) it.explicitTimes = src.explicitTimes;
      }
      if (it.kind === "original" && !it.dupeOf.length && isBudget(it.house) && !it.dupes.length) it.budget = true;
      if (it.kind === "dupe") it.budget = true;
      const c = classify(it.accords);
      it.seasons = it.explicitSeasons || c.seasons;
      it.times = it.explicitTimes || c.times;
      it.climate = c.scores;
      it.vector = vec(it.accords);
      it.unknownScent = !Object.keys(it.accords).length;
    }
    return { items, byId };
  }

  function similar(catalog, item, { limit = 5, budgetOnly = false, exclude = [] } = {}) {
    if (item.unknownScent) return [];
    return catalog.items
      .filter((o) => o.id !== item.id && !exclude.includes(o.id) && !o.unknownScent && (!budgetOnly || o.budget))
      .map((o) => ({ item: o, score: cosine(item.vector, o.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /* ---------- taste model ---------- */

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  function features(item) {
    const v = item.vector;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }

  /*
   * Logistic regression over accord features, trained by full-batch
   * gradient descent with L2 regularisation. ratings: { id: 1 | -1 }.
   */
  function trainTaste(catalog, ratings) {
    const data = Object.entries(ratings)
      .map(([id, r]) => [catalog.byId.get(id), r > 0 ? 1 : 0])
      .filter(([it]) => it && !it.unknownScent);
    const w = new Array(ACCORD_KEYS.length).fill(0);
    let b = 0;
    if (!data.length) return { w, b, n: 0, loved: [], disliked: [] };

    const X = data.map(([it]) => features(it));
    const y = data.map(([, l]) => l);
    const lr = 0.8, l2 = 0.04, epochs = 400;
    for (let e = 0; e < epochs; e++) {
      const gw = new Array(w.length).fill(0);
      let gb = 0;
      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((s, x, j) => s + x * w[j], b);
        const err = sigmoid(z) - y[i];
        for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
        gb += err;
      }
      for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
      b -= lr * (gb / X.length);
    }
    return {
      w, b, n: data.length,
      loved: data.filter(([, l]) => l === 1).map(([it]) => it),
      disliked: data.filter(([, l]) => l === 0).map(([it]) => it),
    };
  }

  /*
   * Match score 0..1. Blends the regression's opinion with nearest-neighbour
   * similarity to perfumes you loved (and away from ones you didn't).
   */
  function predict(model, item) {
    if (!model.n || item.unknownScent) return null;
    const x = features(item);
    const lrScore = sigmoid(x.reduce((s, v, j) => s + v * model.w[j], model.b));
    const near = (list) => list.reduce((m, o) => (o.id === item.id ? m : Math.max(m, cosine(item.vector, o.vector))), 0);
    const love = near(model.loved);
    const hate = near(model.disliked);
    const knn = Math.min(1, Math.max(0, 0.5 + 0.6 * (love - 0.5) - 0.45 * Math.max(0, hate - 0.5)));
    const trust = Math.min(1, model.n / 8);
    return (0.4 + 0.25 * trust) * lrScore + (0.6 - 0.25 * trust) * knn;
  }

  // Accord preferences the model has learned, strongest either way.
  function tasteProfile(model) {
    return ACCORD_KEYS.map((k, i) => ({ accord: k, weight: model.w[i] }))
      .filter((x) => Math.abs(x.weight) > 0.05)
      .sort((a, b) => b.weight - a.weight);
  }

  /*
   * Active learning: the next perfume to ask about is one the model is least
   * sure of, drawn from accords it hasn't seen much of yet.
   */
  function nextQuestion(catalog, model, ratings, skip = []) {
    const pool = catalog.items.filter((it) => !(it.id in ratings) && !skip.includes(it.id) && !it.unknownScent && it.kind === "original");
    const fallback = catalog.items.filter((it) => !(it.id in ratings) && !skip.includes(it.id) && !it.unknownScent);
    const list = pool.length ? pool : fallback;
    if (!list.length) return null;
    if (!model.n) return list[Math.floor(Math.random() * list.length)];
    const ranked = list.map((it) => ({ it, u: Math.abs(predict(model, it) - 0.5) })).sort((a, b) => a.u - b.u);
    const top = ranked.slice(0, 5);
    return top[Math.floor(Math.random() * top.length)].it;
  }

  /* ---------- spreadsheet import ---------- */

  const FIELD_PATTERNS = {
    name: /^(original|inspired by|designer|perfume|fragrance|scent|name|original perfume|original fragrance|designer fragrance|perfume name)$|original|inspired|designer(?! brand| house)/,
    house: /brand|house|maker|designer brand|original brand/,
    dupe: /dupe|clone|alternative|alt|affordable|budget|smells like|similar/,
    dupeHouse: /dupe.*(brand|house)|clone.*(brand|house)|(brand|house).*dupe/,
    notes: /note|accord|family|profile|smell|description|scent profile/,
    season: /season/,
    time: /time|day|night|occasion|wear/,
  };

  function guessMapping(headers) {
    const h = headers.map((x) => norm(x));
    const used = new Set();
    const pick = (re, avoid) => {
      const i = h.findIndex((x, idx) => x && !used.has(idx) && re.test(x) && !(avoid && avoid.test(x)));
      if (i >= 0) used.add(i);
      return i;
    };
    const m = {};
    m.dupeHouse = pick(FIELD_PATTERNS.dupeHouse);
    m.season = pick(FIELD_PATTERNS.season);
    m.time = pick(FIELD_PATTERNS.time);
    m.notes = pick(FIELD_PATTERNS.notes, FIELD_PATTERNS.dupe);
    m.dupe = pick(FIELD_PATTERNS.dupe, /notes?|accord/);
    m.house = pick(FIELD_PATTERNS.house, FIELD_PATTERNS.dupe);
    m.name = pick(FIELD_PATTERNS.name);
    if (m.name < 0) {
      const free = h.findIndex((x, idx) => x && !used.has(idx));
      if (free >= 0) { m.name = free; used.add(free); }
    }
    if (m.dupe < 0) {
      const free = h.findIndex((x, idx) => x && !used.has(idx));
      if (free >= 0) { m.dupe = free; used.add(free); }
    }
    return m;
  }

  // Find the header row: first row with at least two filled cells.
  function splitTable(rows) {
    const clean = rows.map((r) => (r || []).map((c) => (c == null ? "" : String(c).trim())));
    const hi = clean.findIndex((r) => r.filter(Boolean).length >= 2);
    if (hi < 0) return { headers: [], body: [] };
    const width = Math.max(...clean.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => clean[hi][i] || "Column " + (i + 1));
    const body = clean.slice(hi + 1).filter((r) => r.some(Boolean));
    return { headers, body };
  }

  const KNOWN_HOUSES = () => {
    const set = new Set(window.SEED_PERFUMES.flatMap((p) => [p.house, ...p.dupes.map((d) => d[0])]));
    return [...set].sort((a, b) => b.length - a.length);
  };

  // "Aventus by Creed", "Creed - Aventus", "Creed Aventus" → [house, name]
  function splitHouse(text, fallbackHouse) {
    const t = String(text || "").trim();
    if (!t) return ["", ""];
    let m = t.match(/^(.+?)\s+by\s+(.+)$/i);
    if (m) {
      const house = m[2].trim();
      let name = m[1].trim();
      if (name.toLowerCase().startsWith(house.toLowerCase() + " ")) name = name.slice(house.length).trim();
      return [house, name];
    }
    m = t.match(/^(.+?)\s+[-–—:|]\s+(.+)$/);
    if (m) return [m[1].trim(), m[2].trim()];
    if (fallbackHouse) return [fallbackHouse, t];
    const lower = t.toLowerCase();
    const known = KNOWN_HOUSES().find((h) => lower.startsWith(h.toLowerCase() + " "));
    if (known) return [known, t.slice(known.length).trim()];
    return ["", t];
  }

  function recordsFromTable(body, m) {
    const cell = (r, i) => (i >= 0 ? r[i] || "" : "");
    const records = [];
    let lastOrig = null;
    for (const r of body) {
      const nameCell = cell(r, m.name);
      const dupeCell = cell(r, m.dupe);
      // Rows with a blank original continue the previous perfume's dupes.
      if (!nameCell && dupeCell && lastOrig) {
        lastOrig.dupes.push(...splitDupes(dupeCell, cell(r, m.dupeHouse)));
        continue;
      }
      if (!nameCell) continue;
      const [house, name] = splitHouse(nameCell, cell(r, m.house));
      const rec = {
        house, name, notes: cell(r, m.notes),
        seasons: parseSeasons(cell(r, m.season)),
        times: parseTimes(cell(r, m.time)) || parseTimes(cell(r, m.season)),
        dupes: splitDupes(dupeCell, cell(r, m.dupeHouse)),
        fromSheet: true,
      };
      if (!rec.notes) delete rec.notes;
      records.push(rec);
      lastOrig = rec;
    }
    return records;
  }

  function splitDupes(text, dupeHouse) {
    if (!text) return [];
    return String(text).split(/\s*(?:;|\n|,(?![^(]*\))|\/(?=\s)|\bor\b)\s*/i)
      .map((s) => s.replace(/\(.*?\)/g, "").trim())
      .filter(Boolean)
      .map((s) => splitHouse(s, dupeHouse));
  }

  function currentSeason(date = new Date(), hemisphere = "north") {
    const mth = date.getMonth();
    const north = mth <= 1 || mth === 11 ? "winter" : mth <= 4 ? "spring" : mth <= 7 ? "summer" : "fall";
    if (hemisphere === "north") return north;
    return { winter: "summer", spring: "fall", summer: "winter", fall: "spring" }[north];
  }

  window.ScentEngine = {
    ACCORD_KEYS, SEASONS, TIMES, norm, idOf,
    weightAccords, accordsFromText, cosine, classify, parseSeasons, parseTimes,
    buildCatalog, similar, trainTaste, predict, tasteProfile, nextQuestion,
    splitTable, guessMapping, recordsFromTable, splitHouse, currentSeason,
  };
})();
