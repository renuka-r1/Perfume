# Sillage — perfume dupe finder

An interactive web app that finds dupes for your favourite perfumes, learns which
fragrances you like, and sorts everything by **season** (spring, summer, fall, winter)
and **time of wear** (day or night).

Your list, **MIDDLE_EASTERN_CLONES_2024** (621 designer/niche originals, 1,181 Middle
Eastern clones), is built in. A **Men / Women / Unisex** switch under the tabs filters
every view; tick *Include unisex* to see shared scents alongside men's or women's.

Open `index.html` in a browser (or serve the folder, e.g. `python3 -m http.server`).
No build step. Ratings and imported spreadsheet rows are saved in your browser.

## What it does

| Tab | |
|---|---|
| **For you** | A quick "would you wear this?" quiz trains a taste model on your Love / Not for me answers. Shows your learned scent profile, what to wear right now (current season + day/night), and ranked recommendations with a "because you loved…" reason. |
| **Dupe finder** | Search any perfume to see its listed dupes, plus cheaper perfumes whose accords match closely and others in the same scent family. |
| **Seasons** | A scent calendar of your loved perfumes across the 4 seasons × day/night, with suggestions for empty slots, and full day/night lists for each season. Northern/Southern hemisphere toggle. |
| **Catalogue** | Everything, filterable by season, time of day, original vs dupe, loved, or "from my spreadsheet". |
| **My spreadsheet** | Import your own list (CSV, XLSX, or cells pasted from Google Sheets). Columns are auto-detected and can be re-mapped. |

## How the "AI" works (`js/engine.js`)

- **Scent vectors** – every perfume becomes a weighted vector over 24 accords
  (citrus, vanilla, oud, amber…). Free-text notes from a spreadsheet are mapped to
  accords by keyword (e.g. "bergamot" → citrus, "tonka" → gourmand).
- **Taste model** – logistic regression (gradient descent, L2-regularised) trained
  on your ratings, blended with nearest-neighbour similarity to perfumes you loved
  and away from ones you didn't. The blend shifts towards the regression as you rate more.
- **Active learning** – the quiz asks next about the perfume the model is least
  certain about, so every answer is informative.
- **Dupe matching** – cosine similarity between accord vectors, filtered to
  affordable houses (Zara, Armaf, Lattafa, Dossier, Al Haramain…).
- **Season & day/night** – each accord has a climate profile (e.g. citrus → summer/day,
  oud → winter/night); a perfume's seasons are those that score near its top.
  Season or time columns in your sheet override this.

## Your clone list

- `data/MIDDLE_EASTERN_CLONES_2024.xlsx` – the original upload; `data/middle-eastern-clones-2024.csv` – the same as CSV.
- `data/annotations.txt` – one line per sheet row: gender (m/f/u) and main accords.
  The sheet has no notes or gender column, so these are estimates from each
  original's published notes and how it's marketed. Correct any line, then run
  `node tools/build-sheet-data.js` to regenerate `js/sheet-data.js`.
- Dupes inherit their original's gender and scent profile unless their own name
  says otherwise ("Pour Homme", "for Her"…).

## Importing another Google Sheet

Either import it in the **My spreadsheet** tab, or save it as `data/perfumes.csv`
in this folder and it loads automatically on start-up. Useful columns (any names
close to these are detected): original perfume, brand, dupe(s), dupe brand,
notes, season, day/night, gender. A brand column with an odd header is
recognised from its repeated values. Dupes may be listed house-first
("Zara Red Temptation, Ariana Grande Cloud") or one per line as "Name, House"
("Rhagba, Lattafa"); the importer works out which from the column. Several dupes in one cell can be separated by commas,
semicolons or new lines; "Aventus by Creed" and "Creed - Aventus" are both understood.

The starter catalogue in `js/data.js` holds ~50 popular perfumes and commonly cited
dupes so the app is useful before you import anything.
