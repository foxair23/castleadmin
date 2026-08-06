# Service Fusion Remittance Poster (Chrome extension)

Posts **approved** vendor payment-remittance lines from Castle Admin into Service
Fusion automatically. Service Fusion has no API to add a payment to an existing
job (`PUT /jobs` returns 405), so this extension drives SF's own web form using
**your logged-in session cookies** — no SF password is stored anywhere.

## How it works

1. Castle Admin matches remittance lines to jobs. A human approves them (or
   per-vendor **autopilot** auto-approves confident PO matches).
2. This extension polls Castle Admin's `/api/remittance/apply-queue` for approved
   lines, and for each one, in the background:
   - resolves the SF invoice # → its web id (SF global search),
   - opens the Receive-a-Payment form (`POST /accounting/receiveAPayment`),
   - checks the amount fits the invoice's remaining balance (guards duplicates),
   - submits (`POST /saveInvoicePayments`) — **skipped in dry-run**,
   - reports the result back so the line is marked **applied** in the audit log.

It only needs Chrome open and you logged into `admin.servicefusion.com`.

## Setup

**Server (Castle Admin / Vercel):** set an env var
`REMITTANCE_APPLY_TOKEN` to a long random string. (Optional:
`REMITTANCE_SF_PAYMENT_TYPE_ID` default `980387038` "Other",
`REMITTANCE_SF_PAY_TYPE` default `CHECK`.)

**Extension:**
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this `sf-remittance/` folder.
2. Open the extension's **Options** and set:
   - **Castle Admin URL** — e.g. `https://castleadmin.vercel.app`
   - **Apply token** — the same value as `REMITTANCE_APPLY_TOKEN`
   - **Received by** — your initials (goes in SF's "Received By")
   - leave **Dry run ON** and toggle **Enabled** on.
3. Approve a line in Castle Admin → Remittances, then open the extension popup and
   click **Run now**.

## First run = dry run (important)

With **Dry run ON**, the extension does every step *except* the final submit and
shows exactly what it would post (open the popup, or the service-worker console
via `chrome://extensions` → "service worker"). **Verify a few** — especially that
the invoice # resolves correctly and the amount/reference/date look right — then
turn **Dry run OFF** in Options to go live. After that it's hands-free on the poll
interval.

## Security notes

- No SF credentials are stored; the extension rides your existing browser session.
- The only secret it holds is the Castle Admin apply token (in `chrome.storage`).
- Automating your own SF account for your own data is normally fine; review SF's
  terms if in doubt.

## Files

- `background.js` — poll loop + orchestration
- `sf.js` — the Service Fusion form automation (the reverse-engineered flow)
- `app-api.js` — talks to Castle Admin (queue + callback)
- `options.html/js`, `popup.html/js`, `store.js`
