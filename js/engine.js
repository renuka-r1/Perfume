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

  // "Armani" ~ "Giorgio Armani", "MFK" ~ "Maison Francis Kurkdjian", "YSL" ~ "Yves Saint Laurent".
  function sameHouse(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return true;
    const cx = x.replace(/ /g, ""), cy = y.replace(/ /g, "");
    if (cx === cy || cx.includes(cy) || cy.includes(cx)) return true;
    const initials = (s) => s.split(" ").map((w) => w[0]).join("");
    if (initials(x) === cy || initials(y) === cx) return true;
    return x.split(" ")[0] === y.split(" ")[0] && x.split(" ")[0].length > 3;
  }

  /* ---------- gender ---------- */

  const GENDERS = ["men", "women", "unisex"];
  function parseGender(text) {
    const t = " " + norm(text) + " ";
    if (!t.trim()) return null;
    if (/ (unisex|shared|both|all) /.test(t)) return "unisex";
    if (/ (women|woman|female|womens|ladies|lady|her|she|femme|donna|pour femme|girl|f) /.test(t)) return "women";
    if (/ (men|man|male|mens|him|he|homme|uomo|pour homme|boy|m) /.test(t)) return "men";
    return null;
  }
  // Hints in a perfume's own name: "Fierce (Men)", "Pour Homme", "for Her"…
  function genderFromName(name) {
    const t = " " + norm(name) + " ";
    if (/ (women|woman|womens|for her|pour femme|femme|donna|lady|girl|elle|her) /.test(t)) return "women";
    if (/ (men|man|mens|for him|pour homme|homme|uomo|boy|him|male) /.test(t)) return "men";
    return null;
  }

  function makeItem(house, name, extra) {
    return Object.assign({
      id: idOf(house, name), house: house || "", name, kind: "original",
      accords: {}, notes: "", dupeOf: [], dupes: [], explicitSeasons: null, explicitTimes: null, fromSheet: false, gender: null,
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
      if (!house) return list[0] || null;
      return list.find((x) => sameHouse(x.house, house)) || null;
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
        if (extra.gender) item.gender = extra.gender;
      }
      return item;
    }

    for (const r of records) {
      if (!r.name) continue;
      const accords = r.accords || accordsFromText(r.notes);
      const orig = upsert(r.house, r.name, { accords, notes: r.notes, seasons: r.seasons, times: r.times, fromSheet: r.fromSheet, gender: r.gender });
      for (const [dh, dn, dNotes] of r.dupes || []) {
        if (!dn) continue;
        const d = upsert(dh, dn, dNotes ? { accords: accordsFromText(dNotes), notes: dNotes, fromSheet: r.fromSheet } : { fromSheet: r.fromSheet });
        if (d === orig) continue;
        d.kind = "dupe";
        if (!d.dupeOf.includes(orig.id)) d.dupeOf.push(orig.id);
        if (!orig.dupes.includes(d.id)) orig.dupes.push(d.id);
      }
    }

    const items = [...byId.values()];
    // Gender: the sheet's column or annotation, else a hint in the name ("Pour Homme"),
    // else whatever the original it copies is marketed as. Originals first.
    const ordered = items.filter((it) => !it.dupeOf.length).concat(items.filter((it) => it.dupeOf.length));
    for (const it of ordered) {
      if (it.gender) continue;
      const src = it.dupeOf.map((id) => byId.get(id)).find((o) => o.gender);
      it.gender = genderFromName(it.name) || (src && src.gender) || "unisex";
    }
    // A dupe without its own notes borrows the scent profile of what it copies.
    for (const it of items) {
      if (!Object.keys(it.accords).length && it.dupeOf.length) {
        const src = byId.get(it.dupeOf[0]);
        it.accords = Object.fromEntries(Object.entries(src.accords).map(([k, w]) => [k, +(w * 0.95).toFixed(3)]));
        if (!it.notes) it.notes = src.notes;
        if (!it.explicitSeasons && src.explicitSeasons) it.explicitSeasons = src.explicitSeasons;
        if (!it.explicitTimes && src.explicitTimes) it.explicitTimes = src.explicitTimes;
      }
      // Gender: the sheet's own column or annotation, else a hint in the name,
      // else whatever the original it copies is marketed as.
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

    // With few "not for me" answers there is nothing to contrast loves against,
    // so a spread of unrated perfumes joins in as weak negatives (PU learning).
    const pos = data.filter(([, l]) => l === 1).length;
    const neg = data.length - pos;
    const sw = data.map(() => 1);
    if (pos && neg < pos) {
      const unrated = catalog.items.filter((it) => !(it.id in ratings) && !it.unknownScent);
      const k = Math.min(unrated.length, 4 * pos);
      for (let i = 0; i < k; i++) {
        data.push([unrated[Math.floor((i * unrated.length) / k)], 0]);
        sw.push(0.25);
      }
    }
    const X = data.map(([it]) => features(it));
    const y = data.map(([, l]) => l);
    const lr = 0.8, l2 = 0.04, epochs = 400;
    for (let e = 0; e < epochs; e++) {
      const gw = new Array(w.length).fill(0);
      let gb = 0;
      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((s, x, j) => s + x * w[j], b);
        const err = (sigmoid(z) - y[i]) * sw[i];
        for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
        gb += err;
      }
      const n = sw.reduce((a, x) => a + x, 0);
      for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
      b -= lr * (gb / n);
    }
    const real = pos + neg;
    data.length = real;
    return {
      w, b, n: real,
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
    gender: /gender|sex|for men|for women|men women|category|target/,
  };

  function guessMapping(headers, body = []) {
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
    m.gender = pick(FIELD_PATTERNS.gender);
    m.time = pick(FIELD_PATTERNS.time);
    m.notes = pick(FIELD_PATTERNS.notes, FIELD_PATTERNS.dupe);
    m.dupe = pick(FIELD_PATTERNS.dupe, /notes?|accord/);
    m.house = pick(FIELD_PATTERNS.house, FIELD_PATTERNS.dupe);
    m.name = pick(FIELD_PATTERNS.name);

    // Columns whose header says nothing useful are judged by their contents.
    const filled = (i) => body.map((r) => r[i] || "").filter(Boolean);
    const free = () => headers.map((_, i) => i).filter((i) => !used.has(i) && filled(i).length >= Math.min(3, body.length));
    if (m.house < 0 && body.length) {
      // A brand column repeats the same few short values ("Dior", "Dior", "Chanel"…).
      const cand = free().map((i) => {
        const v = filled(i);
        return { i, rep: 1 - new Set(v.map(norm)).size / v.length, short: v.every((x) => x.length < 40) };
      }).filter((c) => c.short && c.rep >= 0.25 && (m.name < 0 || c.i < m.name)).sort((a, b) => b.rep - a.rep)[0];
      if (cand) { m.house = cand.i; used.add(cand.i); }
    }
    for (const key of ["name", "dupe"]) {
      if (m[key] < 0) {
        const f = free()[0] ?? h.findIndex((x, idx) => x && !used.has(idx));
        if (f >= 0) { m[key] = f; used.add(f); }
      }
    }
    for (const k of ["dupeHouse", "season", "gender", "time", "notes", "dupe", "house", "name"]) if (m[k] === undefined) m[k] = -1;
    return m;
  }

  // Find the header row: first row with at least two filled cells.
  function splitTable(rows) {
    const clean = rows.map((r) => (r || []).map((c) => (c == null ? "" : String(c).trim())));
    const hi = clean.findIndex((r) => r.filter(Boolean).length >= 2);
    if (hi < 0) return { headers: [], body: [] };
    const width = Math.max(...clean.map((r) => r.length));
    let headers = Array.from({ length: width }, (_, i) => clean[hi][i] || "Column " + (i + 1));
    const body = clean.slice(hi + 1).filter((r) => r.some(Boolean));
    // Drop columns that are empty all the way down.
    const keep = headers.map((_, i) => clean[hi][i] || body.some((r) => r[i]));
    headers = headers.filter((_, i) => keep[i]);
    return { headers, body: body.map((r) => r.filter((_, i) => keep[i])) };
  }

  // Spelling variants seen in real dupe lists → one name per house.
  const HOUSE_ALIASES = {
    "alhambra": "Maison Alhambra", "mason alhambra": "Maison Alhambra", "lataffa": "Lattafa", "haramain": "Al Haramain",
    "rouge perfumes": "Rogue Perfumes", "ryhaan": "Rayhaan", "fragrance wolrd": "Fragrance World", "arabiyt prestige": "Arabiyat Prestige",
    "arabiyat": "Arabiyat Prestige", "frenche avenue": "French Avenue", "french ave": "French Avenue", "afan": "Afnan",
    "granduer elite": "Grandeur Elite", "emer": "Emper", "riffs": "Riiffs", "carolina herrara": "Carolina Herrera",
    "louis vitton": "Louis Vuitton", "billy eilish": "Billie Eilish", "brittany spears": "Britney Spears",
    "emporo armani": "Emporio Armani", "dreis van noten": "Dries Van Noten", "mont blanc": "Montblanc", "memo paris": "Memo",
    "penhaligons": "Penhaligon's", "armani": "Giorgio Armani", "pana dora": "Pana Dora",
  };
  const canonHouse = (h) => HOUSE_ALIASES[norm(h)] || String(h || "").trim();

  // Houses that make dupes; used to read "Name, House" entries.
  const DUPE_HOUSES = ["Lattafa", "Lattafa Pride", "Lattafa Niche Emarati", "Armaf", "Afnan", "Al Haramain", "Maison Alhambra", "Fragrance World",
    "French Avenue", "Paris Corner", "Zimaya", "Rasasi", "Khadlaj", "Orientica", "Emir", "Zakat", "Rogue Perfumes", "MPF", "Dubai Essences",
    "Ard Al Zaafaran", "Arabiyat Prestige", "Arabiyat", "Swiss Arabian", "Al Rehab", "Riiffs", "Al Wataniah", "Rayhaan", "Grandeur", "Grandeur Elite",
    "Emper", "Jo Milano", "Pendora Scents", "Pendora", "Borouj", "Ajmal", "Lucianno", "Mawj", "North Stag Expressions", "North Stag",
    "Luxe Vision", "Asdaaf", "Attar Collection", "Arabian Oud", "Ahmed Al Maghribi", "FA Paris", "Fayrouz", "Nuha", "Reyane", "Nusuk",
    "Aroma Concepts", "Aroma West", "Autobiography", "Oros Pure", "Albait Aldimashqi", "Ainash Parfums", "Ibraheem Al Qurashi", "Luxador",
    "Mamlakat Al Oud", "Maison Asrar", "Milestone", "Volare", "Ether Perfumes", "Monster Perfumes", "Al Aneeq", "White Oud Perfumes",
    "Zoghbi", "Jeanne Arthes", "Franck Olivier", "Rawae'e", "Ministry of Oud", "Fragrance World Ministry of Oud", "Privezarah", "Athoor Al Alam",
    "Artisan Collection", "Out Al Zaafaran", "Zara", "Dossier", "Alt", "Oakcha", "Alexandria", "Ariana Grande"];
  const KNOWN_HOUSES = () => {
    const set = new Set(window.SEED_PERFUMES.flatMap((p) => [p.house, ...p.dupes.map((d) => d[0])]).concat(DUPE_HOUSES));
    return [...set].sort((a, b) => b.length - a.length);
  };
  const isKnownHouse = (s) => { const n = norm(s); return !!n && (KNOWN_HOUSES().some((h) => norm(h) === n) || n in HOUSE_ALIASES); };

  // "Aventus by Creed", "Creed - Aventus", "Creed Aventus" → [house, name]
  function splitHouse(text, fallbackHouse) {
    const t = String(text || "").trim();
    if (!t) return ["", ""];
    let m = t.match(/^(.+?)\s+by\s+(.+)$/i);
    if (m) {
      const house = m[2].trim();
      let name = m[1].trim();
      if (name.toLowerCase().startsWith(house.toLowerCase() + " ")) name = name.slice(house.length).trim();
      return [canonHouse(house), name];
    }
    m = t.match(/^(.+?)\s+[-–—:|]\s+(.+)$/);
    if (m) return [canonHouse(m[1].trim()), m[2].trim()];
    if (fallbackHouse) return [canonHouse(fallbackHouse), t];
    const lower = t.toLowerCase();
    const known = KNOWN_HOUSES().find((h) => lower.startsWith(h.toLowerCase() + " "));
    if (known) return [canonHouse(known), t.slice(known.length).trim()];
    return ["", t];
  }

  const cleanEntry = (s) => s.replace(/\((?:[^)]*)\)/g, "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  const entriesOf = (text) => String(text || "").split(/\s*(?:\n|;|\s\/\/?\s)\s*/).map(cleanEntry).filter(Boolean);

  /*
   * Dupe cells come in two shapes:
   *   list:       "Zara Red Temptation, Ariana Grande Cloud"   (house first, comma between dupes)
   *   name-house: "Rhagba, Lattafa" / "Rose D'Prive, French Avenue, Fragrance World"  (one dupe per line)
   * The column's own contents decide which.
   */
  function dupeStyle(cells) {
    const entries = cells.flatMap(entriesOf).filter((e) => e.includes(","));
    if (!entries.length) return "list";
    const tailKnown = entries.filter((e) => isKnownHouse(e.split(",").pop())).length;
    return tailKnown / entries.length >= 0.3 ? "name-house" : "list";
  }

  function splitDupeEntry(entry, style, dupeHouse) {
    if (style !== "name-house" || !entry.includes(",")) return splitHouse(entry, dupeHouse);
    const parts = entry.split(",").map((p) => p.trim()).filter(Boolean);
    const houses = [];
    while (parts.length > 1 && isKnownHouse(parts[parts.length - 1])) houses.unshift(canonHouse(parts.pop()));
    if (!houses.length && parts.length > 1) houses.push(canonHouse(parts.pop()));
    const house = houses.length > 1 ? `${houses[0]} (${houses.slice(1).join(", ")})` : houses[0] || dupeHouse || "";
    return [house, parts.join(" ")];
  }

  function splitDupes(text, dupeHouse, style = "list") {
    if (!text) return [];
    const entries = style === "name-house"
      ? entriesOf(text)
      : String(text).split(/\s*(?:;|\n|,(?![^(]*\))|\s\/\/?\s|\bor\b)\s*/i).map(cleanEntry).filter(Boolean);
    return entries.map((e) => splitDupeEntry(e, style, dupeHouse)).filter(([, n]) => n);
  }

  function recordsFromTable(body, m, style) {
    const cell = (r, i) => (i >= 0 ? r[i] || "" : "");
    style = style || dupeStyle(body.map((r) => cell(r, m.dupe)));
    const records = [];
    let lastOrig = null;
    for (const r of body) {
      const nameCell = cell(r, m.name);
      const dupeCell = cell(r, m.dupe);
      // Rows with a blank original continue the previous perfume's dupes.
      if (!nameCell && dupeCell && lastOrig) {
        lastOrig.dupes.push(...splitDupes(dupeCell, cell(r, m.dupeHouse), style));
        continue;
      }
      if (!nameCell) continue;
      const houseCell = /^\d+(\.\d+)?$/.test(cell(r, m.house)) ? "" : cell(r, m.house);
      const [house, rawName] = splitHouse(nameCell, houseCell);
      const name = rawName;
      const rec = {
        house, name, notes: cell(r, m.notes),
        seasons: parseSeasons(cell(r, m.season)),
        times: parseTimes(cell(r, m.time)) || parseTimes(cell(r, m.season)),
        gender: parseGender(cell(r, m.gender)) || genderFromName(rawName),
        dupes: splitDupes(dupeCell, cell(r, m.dupeHouse), style),
        fromSheet: true,
      };
      if (!rec.notes) delete rec.notes;
      if (!rec.gender) delete rec.gender;
      records.push(rec);
      lastOrig = rec;
    }
    return records;
  }

  // CSV / TSV (pasted from Google Sheets) → rows of cells.
  function parseDelimited(text) {
    const delim = text.includes("\t") ? "\t" : ",";
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"' && !cell) q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function currentSeason(date = new Date(), hemisphere = "north") {
    const mth = date.getMonth();
    const north = mth <= 1 || mth === 11 ? "winter" : mth <= 4 ? "spring" : mth <= 7 ? "summer" : "fall";
    if (hemisphere === "north") return north;
    return { winter: "summer", spring: "fall", summer: "winter", fall: "spring" }[north];
  }

  window.ScentEngine = {
    ACCORD_KEYS, SEASONS, TIMES, GENDERS, norm, idOf, parseGender, genderFromName,
    weightAccords, accordsFromText, cosine, classify, parseSeasons, parseTimes,
    buildCatalog, similar, trainTaste, predict, tasteProfile, nextQuestion,
    splitTable, guessMapping, recordsFromTable, splitHouse, splitDupes, dupeStyle, parseDelimited, currentSeason,
  };
})();
