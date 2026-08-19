import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getStsSettings } from '@/lib/clopay-sts/dc-request'
import { signedUrl } from '@/lib/clopay-sts/attachments'
import { STS_CLOSED } from '@/lib/clopay-sts/stages'
import ClopayStsTable, { type StsOrder } from './ClopayStsTable'
import HdOrdersNav from './HdOrdersNav'
import { StsControls } from './StsControls'

// Clopay STS sub-tab of HD Orders — the full record for ship-to-store delivery
// orders emailed by Clopay: status pipeline, the DC round-trip flags, and the
// acknowledgement attachments. Data is service-role; each page guards its role.
export default async function ClopayStsView({ canManage = false, basePath = '/admin/vendor-orders' }: { canManage?: boolean; basePath?: string }) {
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const settings = await getStsSettings()

  const { data: orderRows } = await db
    .from('vendor_orders')
    .select('id, external_id, customer_po, status, details_requested_at, details_received_at, raw, first_seen_at, last_seen_at')
    .eq('vendor', 'clopay_sts')
    .order('first_seen_at', { ascending: false })
    .limit(1000)
  const base = (orderRows ?? []) as Array<Record<string, unknown>>

  // Attachments for these orders, with a short-lived signed URL each.
  const ids = base.map(o => o.id as string)
  const attachmentsByOrder = new Map<string, StsOrder['attachments']>()
  if (ids.length) {
    const { data: atts } = await db
      .from('vendor_order_attachments')
      .select('id, order_id, filename, mime_type, byte_size, source, created_at, storage_path')
      .in('order_id', ids)
      .order('created_at', { ascending: true })
    for (const a of (atts ?? []) as Array<Record<string, unknown>>) {
      const url = await signedUrl(a.storage_path as string)
      const list = attachmentsByOrder.get(a.order_id as string) ?? []
      list.push({
        id: a.id as string,
        filename: (a.filename as string) ?? 'attachment',
        mime_type: (a.mime_type as string) ?? null,
        byte_size: (a.byte_size as number) ?? null,
        source: (a.source as string) ?? 'manual',
        url,
      })
      attachmentsByOrder.set(a.order_id as string, list)
    }
  }

  const orders: StsOrder[] = base.map(o => {
    const raw = (o.raw as Record<string, unknown>) ?? {}
    return {
      id: o.id as string,
      external_id: o.external_id as string,
      customer_po: (o.customer_po as string) ?? null,
      status: (o.status as string) ?? 'Received',
      details_requested_at: (o.details_requested_at as string) ?? null,
      details_received_at: (o.details_received_at as string) ?? null,
      dc_reply_text: (raw.dc_reply_text as string) ?? null,
      first_seen_at: o.first_seen_at as string,
      attachments: attachmentsByOrder.get(o.id as string) ?? [],
    }
  })

  const open = orders.filter(o => o.status !== STS_CLOSED).length

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <HdOrdersNav base={basePath} />
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">HD Orders — Clopay STS</h1>
        <div className="flex items-center gap-4">
          <StsControls on={settings.enabled} dcEmail={settings.dcEmail} canManage={canManage} />
          <span className="text-sm text-gray-500">{orders.length} total · {open} open</span>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Ship-to-store delivery orders emailed by Clopay. We email the Distribution Center for details,
        attach the acknowledgement PDF they send back, and work each order through the status pipeline.
      </p>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No STS orders yet. They appear here when a Clopay email with an “STS” order line is forwarded to the STS address.
        </div>
      ) : (
        <ClopayStsTable orders={orders} />
      )}
    </div>
  )
}
