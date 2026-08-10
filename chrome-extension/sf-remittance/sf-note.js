// Service Fusion note automation. Runs in the extension service worker and
// fetches admin.servicefusion.com with the user's session cookies
// (host_permissions + credentials:'include'). Posts a note onto an existing job
// via SF's AJAX endpoint — the same request the "Add Note" box fires:
//
//   POST /jobs/addNewNoteAjax
//   Content-Type: application/x-www-form-urlencoded
//   X-Requested-With: XMLHttpRequest            ← required (marks it AJAX)
//   body: note=<text>&id=<NUMERIC job id>&updateChildrenJobs=0
//
// `id` is the plain numeric SF job id (what Castle Admin's mirror stores as
// sf_jobs.id), NOT the hashed id from the job URL.

const SF = 'https://admin.servicefusion.com'
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&')

/** POST one note. Returns { ok, dryRun?, error?, trace }. */
export async function postNote(item, cfg) {
  const trace = []
  try {
    if (!item.sfJobId || !item.noteText) throw new Error('missing sfJobId or noteText')
    const body = form({ note: item.noteText, id: item.sfJobId, updateChildrenJobs: 0 })

    if (cfg.dryRun) {
      trace.push({ step: 'post', dryRun: true, wouldPost: '/jobs/addNewNoteAjax', jobId: item.sfJobId, note: item.noteText.slice(0, 120) })
      return { ok: true, dryRun: true, trace }
    }

    const res = await fetch(`${SF}/jobs/addNewNoteAjax`, {
      method: 'POST',
      credentials: 'include',
      // A logged-out SF 302s to auth.servicefusion.com/oauth. Don't FOLLOW it —
      // a credentialed cross-origin redirect trips CORS. Instead we get an
      // opaqueredirect we can detect as "session expired".
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    })
    trace.push({ step: 'post', status: res.status, type: res.type })

    // A dropped session redirects to the OAuth login (opaqueredirect / status 0).
    if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
      throw new Error('SF session expired (redirected to login) — sign in to admin.servicefusion.com')
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`addNewNoteAjax returned ${res.status}`)
    if (/name=["']?(password|_username)["']?/i.test(text)) throw new Error('SF session expired (got a login form)')

    return { ok: true, trace, snippet: text.slice(0, 200) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), trace }
  }
}
