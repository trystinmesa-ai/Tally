# Tally: private money tracker (PWA)

A phone-first web app for logging income and spending by hand. Everything is stored on your device (IndexedDB). It has no accounts, no servers, no analytics and no bank connections.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | App page |
| `css/styles.css` | Dark, phone-first styles (with iPhone safe areas) |
| `js/core.js` | Calculation logic: integer-cent money, local dates, totals, splits, budgets, recurring schedules |
| `js/db.js` | IndexedDB storage. Confirmations are atomic to prevent duplicates |
| `js/ui.js` | Small DOM helpers, sheets, dialogs, toasts |
| `js/app.js` | Screens and forms |
| `sw.js` | Service worker that caches the app so it works offline |
| `manifest.webmanifest`, `icons/` | Home Screen install metadata |

There is no build step and there are no dependencies. Deploy the folder as it is.

## Run it locally (optional)

```
cd tally
python3 -m http.server 8000
```
Then open http://localhost:8000 in a desktop browser. To use it on your iPhone, you need HTTPS hosting (next section), because iOS only allows offline/service workers on HTTPS.

## Host it (free, about 5 minutes)

Any static HTTPS host works. Two easy options:

**Option A: Netlify Drop**
1. On a computer, go to https://app.netlify.com/drop and sign in or create a free account.
2. Drag the whole `tally` folder onto the page.
3. Netlify gives you a URL like `https://something.netlify.app`. Open that on your iPhone.

**Option B: GitHub Pages**
1. Create a new public repository on GitHub and upload the *contents* of the `tally` folder (so `index.html` is at the top level).
2. In the repo, open Settings → Pages, choose "Deploy from a branch", pick `main` and `/ (root)`, then Save.
3. After a minute your app is live at `https://<your-username>.github.io/<repo-name>/`.

Your financial data is never uploaded to the host. The host only serves the app's code.

## Add it to your iPhone Home Screen

1. Open your app URL in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. From now on, open **Tally** from the Home Screen icon. It opens full-screen and works offline.

Start using it from the Home Screen icon, not the Safari tab. On iPhone, the two keep **separate storage**, so entries made in a Safari tab won't appear in the Home Screen app.

## Honest limitations (iPhone / storage)

- **No backup.** Data lives only in this app's storage on this phone. You can lose it if you delete the Home Screen app, clear Safari website data, reset or replace your phone, or if iOS reclaims storage. This version has no export. iCloud device backups may not reliably include web-app data, so don't rely on them.
- Safari can clear storage for websites you haven't visited in a while. Home Screen web apps are generally exempt from that, which is another reason to use the Home Screen icon.
- **No push notifications.** Recurring items show as "due" or "overdue" inside the app only.
- **Updating the app:** if you change the code, edit `VERSION` in `sw.js` (for example `tally-v1.0.1`) and redeploy. The phone picks up the new version after the app is fully closed and reopened, sometimes on the second launch. Your data is not affected.
- Changing the host URL creates a different storage area. Keep the same URL once you start recording.

## How the numbers work

- Amounts are stored as integer cents, so there are no floating-point rounding errors.
- Dates are stored as local calendar dates (`YYYY-MM-DD`), so a transaction never shifts into another day or month because of time zones.
- **Net** = income − spending for the selected month or year. It is not a balance.
- A split expense counts once in total spending. Each part goes to its own category.
- Recurring occurrences are **not** counted until you confirm them. Each occurrence can be confirmed only once, enforced in a single database transaction. Turning an entry into a recurring schedule records that entry as the first occurrence, so it isn't duplicated.
- Monthly schedules on the 29th–31st use the last day of shorter months.
- A budget applies from the month you set it onward. Earlier months keep their own limits. Removing a budget never touches transactions.
