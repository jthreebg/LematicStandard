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
  exceljs.min.js
  jspdf.umd.min.js
  jspdf.plugin.autotable.min.js
  (exceljs.min.js / jspdf.umd.min.js / jspdf.plugin.autotable.min.js are
   loaded on demand, only when a PDF/Excel export is used)
  Punchlist-Template.xlsx
  timecard-template.xlsx
  icon-192.png / icon-512.png / icon-512-maskable.png
  apple-touch-icon.png
  manifest.webmanifest
  sw.js
```

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

1. Bump the `?v=` number on `app.css`, `app.js`, `templates.js`, and `sw.js` (already set to 10 in this zip).
2. Open the app **while online** and leave it on Home for a few seconds.
3. Swipe it closed, then open it again.

If it is still old: delete the icon from the Home Screen, then Add to Home Screen again from Safari. Safari website data can also be cleared under Settings → Safari → Advanced → Website Data.

### Standardized job workflow
The Job dashboard is the primary workspace for field service. Inspections, punchlists, and time are surfaced as a three-step progress checklist. Job completion is explicit and can be reopened; existing UI and exports remain available.
