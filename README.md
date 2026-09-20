# LeMatic Field Service PWA

Split static package for GitHub Pages.

## Folder

All files are flat in one folder (no subfolders) — this matches how
`index.html` references them (`app.css`, `app.js`, etc. with no path prefix).

```
pwa/
  index.html
  app.css
  app.js
  templates.js
  qrcode.min.js
  exceljs.min.js
  jspdf.umd.min.js
  jspdf.plugin.autotable.min.js
  (exceljs.min.js / jspdf.umd.min.js / jspdf.plugin.autotable.min.js are
   loaded on demand, only when a PDF/Excel export is used)
  Punchlist_Template_ExcelJS.xlsx
  timecard-template.xlsx
  icon-192.png / icon-512.png / icon-512-maskable.png
  apple-touch-icon.png
  manifest.webmanifest
  sw.js
```

## What's in this build

This package now contains the current app — the same one that's been
under active development (Parts Requests feature, its Web Share/photo
fixes, the light-mode fixes, the punchlist item ID fix, etc.) — split back
out into the file layout GitHub Pages / this repo actually deploys, rather
than the single merged HTML file used for in-chat testing.

`app.css` / `app.js` were extracted directly from that current, tested
`app.html` — not hand-edited separately — so the two should never drift
out of sync as long as future changes go through the same process.

## Add to GitHub

### New repo
1. Create an empty GitHub repo (no README).
2. On your computer:

```bash
cd pwa
git init
git add .
git commit -m "LeMatic field service PWA"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

3. Repo → **Settings** → **Pages**
4. Source: **Deploy from a branch**
5. Branch: `main` / folder: `/ (root)`
6. Save. Wait a minute.

Site URL:

`https://YOUR_USER.github.io/YOUR_REPO/`

### Existing repo
Copy everything inside `pwa/` into the repo root (or into `/docs` and set Pages to `/docs`). Commit and push. Then enable Pages as above.

## Test on phone
1. Open the Pages URL in Safari or Chrome.
2. iPhone: Share → Add to Home Screen.
3. Android: Install app / Add to Home Screen.

Needs HTTPS (Pages provides that). Do not open as a `file://` page.

## Local test
From the `pwa` folder:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`

## Note
If the app is not at the domain root (`/YOUR_REPO/`), keep `start_url` and `scope` as `./` in `manifest.webmanifest`. That already matches a project-site URL.

## Updates not showing on iPhone
iOS keeps the last installed PWA in cache. After you upload a new build to GitHub:

1. Bump the `?v=` number on `app.css`, `app.js`, `templates.js`, and `sw.js` (this build is `v=70`).
2. Open the app **while online** and leave it on Home for a few seconds.
3. Swipe it closed, then open it again.

If it is still old: delete the icon from the Home Screen, then Add to Home Screen again from Safari. Safari website data can also be cleared under Settings → Safari → Advanced → Website Data.
