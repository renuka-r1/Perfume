/* Sillage: UI layer. Rendering is plain template strings + event delegation. */
(function () {
  const E = window.ScentEngine;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => Math.round(x * 100) + "%";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const STORE_KEY = "sillage.v1";
  const SEASON_LABEL = { spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter" };
  const TIME_LABEL = { day: "Day", night: "Night" };

  /* ---------- state ---------- */

  const state = {
    tab: "foryou",
    ratings: {},
    imported: [],          // records from the user's spreadsheet
    autoLoaded: [],        // records from data/perfumes.csv, if present
    hemisphere: "north",
    gender: "all",          // all | men | women | unisex
    withUnisex: false,      // show unisex alongside men or women
    filters: { q: "", season: "all", time: "all", kind: "all", sort: "match" },
    seasonView: null,
    seasonScope: "all",
    catLimit: 60,
    dupeId: null,
    quizSkip: [],
    importDraft: null,
    confirmClear: false,
  };
  let catalog, model;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      Object.assign(state, {
        ratings: s.ratings || {}, imported: s.imported || [], hemisphere: s.hemisphere || "north", gender: s.gender || "all", withUnisex: !!s.withUnisex,
        tab: s.tab || state.tab,
      });
    } catch (e) { /* storage unavailable: start fresh */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        ratings: state.ratings, imported: state.imported, hemisphere: state.hemisphere, tab: state.tab, gender: state.gender, withUnisex: state.withUnisex,
      }));
    } catch (e) { /* storage unavailable: keep working in memory */ }
  }

  function rebuild() {
    const seed = window.SEED_PERFUMES.map((p) => ({ house: p.house, name: p.name, gender: p.gender, accords: E.weightAccords(p.accords), notes: p.notes, dupes: p.dupes }));
    const sheet = (window.SHEET_PERFUMES || []).map((p) => ({ house: p.house, name: p.name, gender: p.gender, accords: E.weightAccords(p.accords), dupes: p.dupes, fromSheet: true }));
    catalog = E.buildCatalog(seed.concat(sheet, state.autoLoaded, state.imported));
    retrain();
  }
  function retrain() { model = E.trainTaste(catalog, state.ratings); }

  // Gender filter applied across every tab.
  const shown = (it) => state.gender === "all" || it.gender === state.gender || (state.withUnisex && it.gender === "unisex");
  const view = () => ({ items: catalog.items.filter(shown), byId: catalog.byId });
  const GENDER_LABEL = { men: "Men", women: "Women", unisex: "Unisex" };

  const nowSeason = () => E.currentSeason(new Date(), state.hemisphere);
  const nowTime = () => { const h = new Date().getHours(); return h >= 6 && h < 18 ? "day" : "night"; };
  const match = (it) => E.predict(model, it);

  function rank(items) {
    return items.map((it) => ({ it, m: match(it) }))
      .sort((a, b) => (b.m ?? -1) - (a.m ?? -1) || a.it.name.localeCompare(b.it.name))
      .map((x) => x.it);
  }

  /* ---------- small components ---------- */

  function strip(it) {
    const entries = Object.entries(it.accords).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<div class="strip strip-empty" title="No notes yet"><span>Add notes in your sheet to place this scent</span></div>`;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    return `<div class="strip" role="img" aria-label="Accords: ${esc(entries.map(([a]) => window.ACCORDS[a].label).join(", "))}">${entries
      .map(([a, w]) => `<i style="flex-grow:${(w / total).toFixed(3)};background:${window.ACCORDS[a].hue}" title="${esc(window.ACCORDS[a].label)}"></i>`).join("")}</div>
      <div class="accord-labels">${entries.slice(0, 4).map(([a]) => `<span>${esc(window.ACCORDS[a].label)}</span>`).join("")}</div>`;
  }

  function climateChips(it) {
    return `<div class="chips">${E.SEASONS.map((s) => `<span class="chip season-${s} ${it.seasons.includes(s) ? "on" : ""}">${SEASON_LABEL[s]}</span>`).join("")}
      <span class="sep"></span>${E.TIMES.map((t) => `<span class="chip time-${t} ${it.times.includes(t) ? "on" : ""}">${TIME_LABEL[t]}</span>`).join("")}</div>`;
  }

  function kindBadge(it) {
    if (it.kind === "dupe") {
      const of = it.dupeOf.map((id) => catalog.byId.get(id)).filter(Boolean);
      return `<span class="badge dupe">Dupe of ${of.map((o) => `<button class="linklike" data-action="dupes" data-id="${esc(o.id)}">${esc(o.name)}</button>`).join(", ")}</span>`;
    }
    if (it.budget) return `<span class="badge budget">Affordable</span>`;
    return `<span class="badge original">Original${it.dupes.length ? ` · ${it.dupes.length} dupe${it.dupes.length > 1 ? "s" : ""}` : ""}</span>`;
  }

  function matchMeter(it) {
    const m = match(it);
    if (m == null) return "";
    const tone = m >= 0.66 ? "hi" : m >= 0.45 ? "mid" : "lo";
    return `<div class="match ${tone}" title="How likely you are to love this, learned from your ratings"><b>${pct(m)}</b><span>match</span></div>`;
  }

  function rateButtons(it) {
    const r = state.ratings[it.id];
    return `<div class="rate">
      <button class="btn-love ${r === 1 ? "on" : ""}" data-action="rate" data-id="${esc(it.id)}" data-v="1" aria-pressed="${r === 1}">${r === 1 ? "Loved" : "Love"}</button>
      <button class="btn-pass ${r === -1 ? "on" : ""}" data-action="rate" data-id="${esc(it.id)}" data-v="-1" aria-pressed="${r === -1}">Not for me</button>
      <button class="btn-ghost" data-action="dupes" data-id="${esc(it.id)}">${it.kind === "dupe" ? "Compare" : "Dupes"}</button>
    </div>`;
  }

  function card(it, extra = "") {
    return `<article class="card ${state.ratings[it.id] === 1 ? "loved" : ""}">
      <header><div class="card-title"><div class="house">${esc(it.house || "Unknown house")}</div><h3>${esc(it.name)}</h3></div>${matchMeter(it)}</header>
      <div class="badges">${kindBadge(it)}<span class="badge g-${it.gender}">${GENDER_LABEL[it.gender]}</span></div>
      ${strip(it)}
      ${climateChips(it)}
      ${extra}
      ${rateButtons(it)}
    </article>`;
  }

  function miniRow(it, right = "") {
    return `<li class="mini"><button class="mini-main" data-action="dupes" data-id="${esc(it.id)}">
      <span class="mini-dot" style="background:${topHue(it)}"></span>
      <span class="mini-text"><b>${esc(it.name)}</b><small>${esc(it.house)}</small></span></button>${right}</li>`;
  }
  const topHue = (it) => { const e = Object.entries(it.accords).sort((a, b) => b[1] - a[1])[0]; return e ? window.ACCORDS[e[0]].hue : "var(--line)"; };

  /* ---------- tabs ---------- */

  const TABS = [
    ["foryou", "For you"],
    ["dupes", "Dupe finder"],
    ["seasons", "Seasons"],
    ["catalogue", "Catalogue"],
    ["import", "My spreadsheet"],
  ];

  function render() {
    $("#tabs").innerHTML = TABS.map(([k, l]) => `<button role="tab" aria-selected="${state.tab === k}" class="${state.tab === k ? "on" : ""}" data-action="tab" data-tab="${k}">${l}</button>`).join("");
    const lovedN = Object.values(state.ratings).filter((v) => v > 0).length;
    $("#genderbar").innerHTML = `<div class="seg gender" role="group" aria-label="Who it's for">${[["all", "Everyone"], ["men", "Men"], ["women", "Women"], ["unisex", "Unisex"]]
      .map(([k, l]) => `<button class="${state.gender === k ? "on" : ""}" data-action="gender" data-v="${k}" aria-pressed="${state.gender === k}">${l}</button>`).join("")}</div>
      ${state.gender === "men" || state.gender === "women" ? `<label class="check"><input type="checkbox" id="with-unisex" ${state.withUnisex ? "checked" : ""}> Include unisex</label>` : ""}
      <span class="gcount">${view().items.length} shown</span>`;
    $("#status").innerHTML = `<span>${catalog.items.length} perfumes</span><span>${Object.keys(state.ratings).length} rated · ${lovedN} loved</span><span>Now: ${SEASON_LABEL[nowSeason()]} ${nowTime() === "day" ? "day" : "night"}</span>`;
    const tabView = { foryou: viewForYou, dupes: viewDupes, seasons: viewSeasons, catalogue: viewCatalogue, import: viewImport }[state.tab];
    $("#view").innerHTML = tabView();
    if (state.tab === "import") bindImport();
  }

  /* For you: active-learning quiz, learned taste, recommendations */
  function viewForYou() {
    const q = E.nextQuestion(view(), model, state.ratings, state.quizSkip);
    const profile = E.tasteProfile(model);
    const likes = profile.filter((p) => p.weight > 0).slice(0, 8);
    const dislikes = profile.filter((p) => p.weight < 0).slice(-6).reverse();
    const maxW = Math.max(0.01, ...profile.map((p) => Math.abs(p.weight)));
    const bar = (p) => `<div class="tbar"><span class="tlabel">${esc(window.ACCORDS[p.accord].label)}</span>
      <span class="ttrack"><span class="tfill ${p.weight > 0 ? "pos" : "neg"}" style="width:${(Math.abs(p.weight) / maxW * 100).toFixed(1)}%"></span></span>
      <span class="tval">${p.weight > 0 ? "+" : "−"}${Math.abs(p.weight).toFixed(2)}</span></div>`;

    let lean = "";
    if (model.loved.length) {
      const avg = { spring: 0, summer: 0, fall: 0, winter: 0, day: 0, night: 0 };
      model.loved.forEach((it) => Object.keys(avg).forEach((k) => (avg[k] += it.climate[k] / model.loved.length)));
      const seasons = E.SEASONS.slice().sort((a, b) => avg[b] - avg[a]);
      lean = `<p class="lean">Your loves lean <b>${SEASON_LABEL[seasons[0]]}</b> and <b>${SEASON_LABEL[seasons[1]]}</b>, worn more by <b>${avg.day >= avg.night ? "day" : "night"}</b>.</p>`;
    }

    const recs = model.n
      ? rank(view().items.filter((it) => !(it.id in state.ratings) && !it.unknownScent)).slice(0, 9)
      : [];
    const because = (it) => {
      const best = model.loved.map((o) => [o, E.cosine(o.vector, it.vector)]).sort((a, b) => b[1] - a[1])[0];
      return best ? `<p class="because">Because you loved <b>${esc(best[0].name)}</b> (${pct(best[1])} similar)</p>` : "";
    };

    const season = nowSeason(), time = nowTime();
    const tonight = rank(view().items.filter((it) => it.seasons.includes(season) && it.times.includes(time) && (state.ratings[it.id] === 1 || !(it.id in state.ratings))))
      .slice(0, 4);

    return `
    <section class="split">
      <div class="panel quiz">
        <div class="eyebrow">Teach the algorithm · ${model.n} rating${model.n === 1 ? "" : "s"}</div>
        <h2>Would you wear this?</h2>
        <p class="hint">Each answer retrains a taste model on your ratings. It asks next about the perfume it is least sure you would like, so every answer teaches it something new.</p>
        ${q ? `<div class="quiz-card">${card(q)}<button class="btn-ghost wide" data-action="skip" data-id="${esc(q.id)}">Haven't smelled it, show another</button></div>`
            : `<p class="empty">You've rated everything in the catalogue. Import your spreadsheet to add more.</p>`}
      </div>
      <div class="panel">
        <div class="eyebrow">What it has learned</div>
        <h2>Your scent profile</h2>
        ${model.n < 1 ? `<p class="empty">Rate a few perfumes and your preferred accords appear here, along with the seasons your favourites suit.</p>` : `
          ${lean}
          ${likes.length ? `<h4>Drawn to</h4>${likes.map(bar).join("")}` : ""}
          ${dislikes.length ? `<h4>Steers away from</h4>${dislikes.map(bar).join("")}` : ""}
          <button class="btn-ghost small" data-action="reset-ratings">Reset my ratings</button>
          ${state.confirmClear === "ratings" ? `<div class="confirm">Clear all ${model.n} ratings? <button class="btn-pass" data-action="reset-ratings-yes">Clear</button><button class="btn-ghost" data-action="cancel-confirm">Keep</button></div>` : ""}`}
      </div>
    </section>

    <section>
      <div class="section-head"><div><div class="eyebrow">${SEASON_LABEL[season]} · ${time === "day" ? "Daytime" : "Evening"}</div><h2>Wear right now</h2></div>
      <button class="btn-ghost small" data-action="tab" data-tab="seasons">All seasons</button></div>
      <div class="grid">${tonight.map((it) => card(it)).join("")}</div>
    </section>

    <section>
      <div class="section-head"><div><div class="eyebrow">Ranked by your taste model</div><h2>Recommended for you</h2></div></div>
      ${recs.length ? `<div class="grid">${recs.map((it) => card(it, because(it))).join("")}</div>`
        : `<p class="empty">Love or pass on at least one perfume above and recommendations appear here, ranked by how likely you are to love them.</p>`}
    </section>`;
  }

  /* Dupe finder */
  function viewDupes() {
    const loved = catalog.items.filter((it) => state.ratings[it.id] === 1);
    let sel = state.dupeId && catalog.byId.get(state.dupeId);
    if (!sel) sel = loved.find((it) => it.kind === "original") || catalog.items.find((it) => it.dupes.length) || catalog.items[0];
    const listed = sel.dupes.map((id) => catalog.byId.get(id)).filter(Boolean);
    const parents = sel.dupeOf.map((id) => catalog.byId.get(id)).filter(Boolean);
    const exclude = listed.map((d) => d.id).concat(parents.map((p) => p.id));
    const budget = E.similar(view(), sel, { limit: 6, budgetOnly: true, exclude });
    const close = E.similar(view(), sel, { limit: 6, exclude: exclude.concat(budget.map((b) => b.item.id)) });
    const simNote = (s) => `<p class="because"><b>${pct(s)}</b> accord overlap</p>`;
    const options = catalog.items.map((it) => `<option value="${esc(it.name + " — " + it.house)}"></option>`).join("");

    return `
    <section class="panel finder">
      <div class="eyebrow">Dupe finder</div>
      <h2>Find a dupe for…</h2>
      <form class="search-row" data-form="dupe">
        <label class="sr" for="dupe-q">Perfume name</label>
        <input id="dupe-q" list="all-perfumes" placeholder="Start typing, e.g. Baccarat Rouge 540" autocomplete="off">
        <datalist id="all-perfumes">${options}</datalist>
        <button class="btn-love" type="submit">Find dupes</button>
      </form>
      ${loved.length ? `<div class="quick"><span>Your loves:</span>${loved.map((it) => `<button class="chip-btn ${it.id === sel.id ? "on" : ""}" data-action="dupes" data-id="${esc(it.id)}">${esc(it.name)}</button>`).join("")}</div>` : ""}
      <div class="quick"><span>Most dupes:</span>${view().items.filter((it) => it.dupes.length).sort((a, b) => b.dupes.length - a.dupes.length).slice(0, 8).map((it) => `<button class="chip-btn ${it.id === sel.id ? "on" : ""}" data-action="dupes" data-id="${esc(it.id)}">${esc(it.name)}</button>`).join("")}</div>
    </section>

    <section class="split">
      <div>${card(sel)}</div>
      <div class="panel">
        ${parents.length ? `<div class="eyebrow">This is a dupe of</div><ul class="minis">${parents.map((p) => miniRow(p)).join("")}</ul>` : ""}
        <div class="eyebrow">${sel.fromSheet ? "From your spreadsheet and" : "From"} community dupe lists</div>
        <h2>${listed.length ? `${listed.length} known dupe${listed.length > 1 ? "s" : ""}` : "No listed dupes yet"}</h2>
        ${listed.length ? `<ul class="minis">${listed.map((d) => miniRow(d, `<span class="mini-tag">${d.fromSheet ? "your sheet" : "listed"}</span>`)).join("")}</ul>`
          : `<p class="hint">Nobody has listed one yet. The scent-matching picks below compare accords across the whole catalogue instead.</p>`}
      </div>
    </section>

    ${budget.length ? `<section><div class="section-head"><div><div class="eyebrow">Matched by accords</div><h2>Smells close, costs less</h2></div></div>
      <div class="grid">${budget.map((b) => card(b.item, simNote(b.score))).join("")}</div></section>` : ""}
    ${close.length ? `<section><div class="section-head"><div><div class="eyebrow">Matched by accords</div><h2>Same family</h2></div></div>
      <div class="grid">${close.map((b) => card(b.item, simNote(b.score))).join("")}</div></section>` : ""}`;
  }

  /* Seasons: wardrobe matrix + per-season day/night lists */
  function viewSeasons() {
    const season = state.seasonView || nowSeason();
    const loved = view().items.filter((it) => state.ratings[it.id] === 1);
    const cell = (s, t) => loved.filter((it) => it.seasons.includes(s) && it.times.includes(t));
    const gapPick = (s, t) => rank(view().items.filter((it) => it.seasons.includes(s) && it.times.includes(t) && !(it.id in state.ratings)))[0];

    const matrix = `<div class="matrix-wrap"><table class="matrix">
      <thead><tr><th></th>${E.SEASONS.map((s) => `<th class="season-${s}"><button data-action="season" data-season="${s}" class="${s === season ? "on" : ""}">${SEASON_LABEL[s]}</button></th>`).join("")}</tr></thead>
      <tbody>${E.TIMES.map((t) => `<tr><th class="time-${t}">${TIME_LABEL[t]}</th>${E.SEASONS.map((s) => {
        const c = cell(s, t);
        const g = !c.length && gapPick(s, t);
        return `<td class="${s === season ? "cur" : ""}">${c.length ? c.slice(0, 4).map((it) => `<button class="m-item" data-action="dupes" data-id="${esc(it.id)}">${esc(it.name)}</button>`).join("") + (c.length > 4 ? `<span class="more">+${c.length - 4} more</span>` : "")
          : g ? `<span class="gap">Gap. Try <button class="linklike" data-action="dupes" data-id="${esc(g.id)}">${esc(g.name)}</button></span>` : `<span class="gap">Nothing yet</span>`}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;

    const pool = view().items.filter((it) => it.seasons.includes(season) && (state.seasonScope === "all" ||
      (state.seasonScope === "loved" && state.ratings[it.id] === 1) || (state.seasonScope === "budget" && it.budget)));
    const col = (t) => {
      const list = rank(pool.filter((it) => it.times.includes(t)));
      return `<div class="col"><h3 class="col-title time-${t}">${t === "day" ? "Daytime" : "Night-time"} <small>${list.length}</small></h3>
        ${list.length ? `<div class="stack">${list.slice(0, 12).map((it) => card(it)).join("")}</div>` : `<p class="empty">Nothing here yet.</p>`}
        ${list.length > 12 ? `<p class="hint">Showing the top 12. See every one in the Catalogue tab.</p>` : ""}</div>`;
    };

    return `
    <section class="panel">
      <div class="section-head"><div><div class="eyebrow">Your wardrobe by season and time of wear</div><h2>Scent calendar</h2></div>
        <div class="seg" role="group" aria-label="Hemisphere">
          <button class="${state.hemisphere === "north" ? "on" : ""}" data-action="hemi" data-v="north">Northern</button>
          <button class="${state.hemisphere === "south" ? "on" : ""}" data-action="hemi" data-v="south">Southern</button></div></div>
      <p class="hint">Perfumes you've loved, sorted into the seasons and times their accords suit. Citrus, aquatic and green notes read as warm-weather and daytime; vanilla, amber, oud, tobacco and spice read as cold-weather and evening. Columns from your spreadsheet override this.</p>
      ${loved.length ? matrix : `<p class="empty">Love a few perfumes and they'll fill this calendar, with suggestions for any empty slot.</p>`}
    </section>

    <section>
      <div class="section-head">
        <div class="seg seasons" role="group" aria-label="Season">${E.SEASONS.map((s) => `<button class="season-${s} ${s === season ? "on" : ""}" data-action="season" data-season="${s}">${SEASON_LABEL[s]}${s === nowSeason() ? " · now" : ""}</button>`).join("")}</div>
        <div class="seg" role="group" aria-label="Show">${[["all", "All"], ["loved", "Loved"], ["budget", "Affordable"]].map(([k, l]) => `<button class="${state.seasonScope === k ? "on" : ""}" data-action="scope" data-v="${k}">${l}</button>`).join("")}</div>
      </div>
      <div class="two-col">${col("day")}${col("night")}</div>
    </section>`;
  }

  /* Catalogue */
  function viewCatalogue() {
    const f = state.filters;
    const q = E.norm(f.q);
    let list = view().items.filter((it) =>
      (!q || E.norm(it.name + " " + it.house + " " + it.notes).includes(q)) &&
      (f.season === "all" || it.seasons.includes(f.season)) &&
      (f.time === "all" || it.times.includes(f.time)) &&
      (f.kind === "all" || (f.kind === "original" && it.kind === "original" && !it.budget) || (f.kind === "dupe" && it.budget) ||
        (f.kind === "loved" && state.ratings[it.id] === 1) || (f.kind === "sheet" && it.fromSheet)));
    list = f.sort === "match" ? rank(list) : list.slice().sort((a, b) => a.name.localeCompare(b.name));
    const sel = (id, label, key, opts) => `<label class="fld"><span>${label}</span><select id="${id}" data-filter="${key}">${opts.map(([v, l]) => `<option value="${v}" ${f[key] === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
    return `
    <section class="panel filters">
      <label class="fld grow"><span>Search</span><input id="cat-q" data-filter="q" value="${esc(f.q)}" placeholder="Name, house or note (e.g. vanilla)"></label>
      ${sel("cat-season", "Season", "season", [["all", "Any season"], ...E.SEASONS.map((s) => [s, SEASON_LABEL[s]])])}
      ${sel("cat-time", "Time", "time", [["all", "Day or night"], ["day", "Daytime"], ["night", "Night-time"]])}
      ${sel("cat-kind", "Show", "kind", [["all", "Everything"], ["original", "Originals"], ["dupe", "Dupes & affordable"], ["loved", "Loved"], ["sheet", "From my spreadsheet"]])}
      ${sel("cat-sort", "Sort", "sort", [["match", "Best match"], ["name", "A–Z"]])}
    </section>
    <p class="count">${list.length} perfume${list.length === 1 ? "" : "s"}</p>
    <div class="grid">${list.slice(0, state.catLimit).map((it) => card(it)).join("")}</div>
    ${list.length > state.catLimit ? `<button class="btn-ghost wide" data-action="more">Show ${Math.min(60, list.length - state.catLimit)} more</button>` : ""}`;
  }

  /* Spreadsheet import */
  function viewImport() {
    const d = state.importDraft;
    const fields = [["name", "Original perfume"], ["house", "Original brand"], ["dupe", "Dupe(s)"], ["dupeHouse", "Dupe brand"], ["notes", "Notes / accords"], ["season", "Season"], ["time", "Day / night"], ["gender", "Men / women / unisex"]];
    const sheetCount = state.imported.length;
    return `
    <section class="split">
      <div class="panel">
        <div class="eyebrow">Bring in your list</div>
        <h2>Add your spreadsheet</h2>
        <ol class="steps">
          <li>Open your Google Sheet and choose <b>File → Download → Comma-separated values (.csv)</b> or <b>Microsoft Excel (.xlsx)</b>. Then pick that file below.</li>
          <li>Or select all the cells in the sheet, copy, and paste them into the box.</li>
          <li>Check which column is which, then add them. Originals already in the catalogue are merged, and your rows win.</li>
        </ol>
        <label class="fld"><span>Spreadsheet file (.csv, .xlsx, .tsv)</span><input id="imp-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.ods"></label>
        <label class="fld"><span>Or paste cells</span><textarea id="imp-paste" rows="6" placeholder="Original	Dupe	Notes&#10;Baccarat Rouge 540	Zara Red Temptation	saffron, amber, jasmine"></textarea></label>
        <button class="btn-ghost" data-action="parse-paste">Read pasted cells</button>
        <p class="hint" id="imp-msg">${esc(state.importMsg || "")}</p>
      </div>
      <div class="panel">
        <div class="eyebrow">Currently loaded</div>
        <h2>${sheetCount ? `${sheetCount} extra rows added` : "Your clone list is loaded"}</h2>
        <p class="hint">Built in: <b>${(window.SHEET_PERFUMES || []).length} originals</b> from MIDDLE_EASTERN_CLONES_2024, with ${(window.SHEET_PERFUMES || []).reduce((s, p) => s + p.dupes.length, 0)} dupes. Anything you add here is merged on top.</p>
        <p class="hint">${state.autoLoaded.length ? `Also loaded ${state.autoLoaded.length} rows from data/perfumes.csv in the project folder. ` : ""}Rows stay in this browser so the app remembers them next time.</p>
        ${sheetCount ? `<ul class="minis">${state.imported.slice(0, 8).map((r) => `<li class="mini"><span class="mini-text"><b>${esc(r.name)}</b><small>${esc(r.house)}${r.dupes.length ? " · " + r.dupes.length + " dupe" + (r.dupes.length > 1 ? "s" : "") : ""}</small></span></li>`).join("")}</ul>
          ${sheetCount > 8 ? `<p class="hint">and ${sheetCount - 8} more</p>` : ""}
          <button class="btn-ghost small" data-action="clear-import">Remove spreadsheet rows</button>
          ${state.confirmClear === "import" ? `<div class="confirm">Remove all ${sheetCount} rows? Your ratings stay. <button class="btn-pass" data-action="clear-import-yes">Remove</button><button class="btn-ghost" data-action="cancel-confirm">Keep</button></div>` : ""}` : ""}
      </div>
    </section>
    ${d ? `<section class="panel">
      <div class="eyebrow">${d.body.length} rows found${d.sheets && d.sheets.length > 1 ? ` · tab` : ""}</div>
      ${d.sheets && d.sheets.length > 1 ? `<label class="fld inline"><span>Sheet tab</span><select id="imp-sheet">${d.sheets.map((s, i) => `<option value="${i}" ${i === d.sheetIndex ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>` : ""}
      <h2>Match your columns</h2>
      <div class="mapping">${fields.map(([k, l]) => `<label class="fld"><span>${l}</span><select data-map="${k}" id="map-${k}"><option value="-1">Not in my sheet</option>${d.headers.map((h, i) => `<option value="${i}" ${d.mapping[k] === i ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></label>`).join("")}</div>
      <div class="table-wrap"><table class="preview"><thead><tr>${d.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${d.body.slice(0, 6).map((r) => `<tr>${d.headers.map((_, i) => `<td>${esc(r[i] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="hint">${(() => { const recs = E.recordsFromTable(d.body, d.mapping); const dn = recs.reduce((s, r) => s + r.dupes.length, 0); return `Reads as ${recs.length} perfumes and ${dn} dupes.${recs[0] ? ` First row: <b>${esc(recs[0].name)}</b>${recs[0].house ? " by " + esc(recs[0].house) : ""}${recs[0].dupes[0] ? ` → ${esc(recs[0].dupes.map((x) => x.filter(Boolean).join(" ")).join(", "))}` : ""}.` : ""}`; })()}</p>
      <div class="rate"><button class="btn-love" data-action="do-import">Add to catalogue</button><button class="btn-ghost" data-action="cancel-import">Cancel</button></div>
    </section>` : ""}`;
  }

  /* ---------- spreadsheet reading ---------- */

  function setDraft(sheets, sheetIndex = 0) {
    const { headers, body } = E.splitTable(sheets[sheetIndex].rows);
    if (!body.length) { state.importMsg = "That sheet has no rows under its header. Check the file and try again."; state.importDraft = null; return; }
    state.importDraft = { sheets: sheets.map((s) => s.name), all: sheets, sheetIndex, headers, body, mapping: E.guessMapping(headers, body) };
    state.importMsg = "";
  }

  function readFile(file) {
    const isText = /\.(csv|tsv|txt)$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (isText) setDraft([{ name: file.name, rows: E.parseDelimited(reader.result) }]);
        else {
          if (!window.XLSX) throw new Error("The spreadsheet reader didn't load. Save the sheet as .csv and try again.");
          const wb = window.XLSX.read(reader.result, { type: "array" });
          setDraft(wb.SheetNames.map((n) => ({ name: n, rows: window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }) })));
        }
      } catch (e) { state.importMsg = e.message || "Couldn't read that file. Try saving it as .csv."; state.importDraft = null; }
      render();
    };
    isText ? reader.readAsText(file) : reader.readAsArrayBuffer(file);
  }

  function bindImport() {
    const f = $("#imp-file");
    if (f) f.addEventListener("change", () => f.files[0] && readFile(f.files[0]));
  }

  async function autoLoad() {
    try {
      const res = await fetch("data/perfumes.csv", { cache: "no-store" });
      if (!res.ok) return;
      const text = await res.text();
      if (!text.trim() || /<html/i.test(text.slice(0, 200))) return;
      const { headers, body } = E.splitTable(E.parseDelimited(text));
      state.autoLoaded = E.recordsFromTable(body, E.guessMapping(headers, body));
      rebuild();
      render();
    } catch (e) { /* no bundled sheet: fine */ }
  }

  /* ---------- events ---------- */

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-action]");
    if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    switch (a) {
      case "tab": state.tab = b.dataset.tab; state.confirmClear = false; save(); render(); window.scrollTo({ top: 0 }); return;
      case "rate": {
        const v = +b.dataset.v;
        if (state.ratings[id] === v) delete state.ratings[id]; else state.ratings[id] = v;
        retrain(); save(); render(); return;
      }
      case "skip": state.quizSkip.push(id); render(); return;
      case "dupes": state.dupeId = id; state.tab = "dupes"; save(); render(); window.scrollTo({ top: 0, behavior: "smooth" }); return;
      case "season": state.seasonView = b.dataset.season; render(); return;
      case "scope": state.seasonScope = b.dataset.v; render(); return;
      case "more": state.catLimit += 60; render(); return;
      case "gender": state.gender = b.dataset.v; save(); render(); return;
      case "hemi": state.hemisphere = b.dataset.v; state.seasonView = null; save(); render(); return;
      case "reset-ratings": state.confirmClear = "ratings"; render(); return;
      case "reset-ratings-yes": state.ratings = {}; state.quizSkip = []; state.confirmClear = false; retrain(); save(); render(); return;
      case "clear-import": state.confirmClear = "import"; render(); return;
      case "clear-import-yes": state.imported = []; state.confirmClear = false; rebuild(); save(); render(); return;
      case "cancel-confirm": state.confirmClear = false; render(); return;
      case "parse-paste": {
        const t = $("#imp-paste").value;
        if (!t.trim()) { state.importMsg = "Paste some cells first."; render(); return; }
        setDraft([{ name: "Pasted cells", rows: E.parseDelimited(t) }]); render(); return;
      }
      case "do-import": {
        const d = state.importDraft;
        const recs = E.recordsFromTable(d.body, d.mapping);
        state.imported = state.imported.concat(recs);
        state.importDraft = null;
        state.importMsg = `Added ${recs.length} perfumes from your sheet.`;
        rebuild(); save(); render(); return;
      }
      case "cancel-import": state.importDraft = null; render(); return;
    }
  });

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.dataset.map && state.importDraft) { state.importDraft.mapping[t.dataset.map] = +t.value; render(); }
    else if (t.id === "with-unisex") { state.withUnisex = t.checked; save(); render(); }
    else if (t.id === "imp-sheet") { setDraft(state.importDraft.all, +t.value); render(); }
    else if (t.dataset.filter && t.tagName === "SELECT") { state.filters[t.dataset.filter] = t.value; state.catLimit = 60; render(); }
  });

  let qTimer;
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.filter === "q") {
      state.filters.q = t.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { render(); const i = $("#cat-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 180);
    }
  });

  document.addEventListener("submit", (ev) => {
    const f = ev.target;
    if (f.dataset.form !== "dupe") return;
    ev.preventDefault();
    const v = E.norm($("#dupe-q").value.split(" — ")[0]);
    if (!v) return;
    const hit = catalog.items.find((it) => E.norm(it.name) === v) || catalog.items.find((it) => E.norm(it.name + " " + it.house).includes(v));
    if (hit) { state.dupeId = hit.id; render(); }
    else { $("#dupe-q").setCustomValidity("Not in the catalogue yet. Add it through My spreadsheet."); $("#dupe-q").reportValidity(); setTimeout(() => $("#dupe-q") && $("#dupe-q").setCustomValidity(""), 2500); }
  });

  load();
  rebuild();
  render();
  autoLoad();
})();
