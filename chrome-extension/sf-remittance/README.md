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

### Job notes (customer-action audit trail)

The same poll also posts **job notes** into SF. Whenever Castle Admin does
something the customer sees — today, sending an **invoice reminder** (email/SMS)
— it queues a note, and this extension posts it onto the SF job so the office has
one source of truth. It uses SF's own "Add Note" AJAX request
(`POST /jobs/addNewNoteAjax`, body `note=…&id=<numeric job id>&updateChildrenJobs=0`).

- Reads `/api/sf-notes/queue`, posts each note (**skipped in dry-run**), reports
  back to `/api/sf-notes/callback` → row marked **posted**.
- Deduped per (invoice, reminder stage), so an email+SMS escalation logs one note.
- Extensible by `event`: CSAT, lead-gen outreach, etc. can queue notes the same way.

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

- `background.js` — poll loop + orchestration (payments pass + notes pass)
- `sf.js` — the Service Fusion payment form automation (reverse-engineered flow)
- `sf-note.js` — the Service Fusion add-note automation
- `app-api.js` — talks to Castle Admin (payment + note queue / callback)
- `options.html/js`, `popup.html/js`, `store.js`
