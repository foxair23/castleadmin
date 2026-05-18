'use client'

import { useState, useTransition } from 'react'
import { createWidget, toggleWidget } from './actions'

interface Widget {
  id: string
  display_name: string
  lead_source: string
  api_key: string
  is_active: boolean
  created_at: string
}

interface Props {
  initialWidgets: Widget[]
}

function EmbedSnippet({ widget }: { widget: Widget }) {
  const [copied, setCopied] = useState(false)

  const adminUrl = process.env.NEXT_PUBLIC_CASTLE_ADMIN_URL ?? 'https://admin.castlegaragedoors.com'
  const snippet = `<iframe
  src="${adminUrl}/embed/scheduler?key=${widget.api_key}"
  style="width:100%;border:none;min-height:600px"
  allow="payment"
  loading="lazy"
  title="Book a Service Appointment"
></iframe>
<script>
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'castle-scheduler-height') {
      var f = document.querySelector('iframe[src*="castle-scheduler"]');
      if (f) f.style.minHeight = e.data.height + 'px';
    }
  });
</script>`

  function copy() {
    navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 font-medium">Embed snippet</span>
        <button
          onClick={copy}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-all">
        {snippet}
      </pre>
    </div>
  )
}

export default function WidgetsClient({ initialWidgets }: Props) {
  const [widgets, setWidgets] = useState(initialWidgets)
  const [isPending, startTransition] = useTransition()
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSource, setNewSource] = useState('website')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState('')

  function handleCreate() {
    if (!newName.trim()) return
    setError('')
    startTransition(async () => {
      try {
        await createWidget(newName.trim(), newSource)
        setNewName('')
        setNewSource('website')
        setShowNew(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create widget')
      }
    })
  }

  function handleToggle(id: string, current: boolean) {
    setError('')
    startTransition(async () => {
      try {
        await toggleWidget(id, !current)
        setWidgets(prev => prev.map(w => w.id === id ? { ...w, is_active: !current } : w))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update widget')
      }
    })
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Widget Instances</h1>
        <button
          onClick={() => setShowNew(true)}
          className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 transition-colors"
        >
          + New widget
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      {showNew && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">New widget instance</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Display name</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Main Website"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Lead source tag</label>
              <input
                type="text"
                value={newSource}
                onChange={e => setNewSource(e.target.value)}
                placeholder="e.g. website, landing_page"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <p className="text-xs text-gray-400 mt-1">Stored on each lead for attribution.</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleCreate}
                disabled={isPending || !newName.trim()}
                className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
              >
                {isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                onClick={() => setShowNew(false)}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {widgets.map(widget => (
          <div key={widget.id} className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-gray-900">{widget.display_name}</h2>
                  {widget.is_active ? (
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">Active</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-xs font-medium">Inactive</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  Source: <span className="font-mono">{widget.lead_source}</span>
                  {' · '}
                  ID: <span className="font-mono">{widget.id}</span>
                </p>
              </div>
              <div className="flex gap-2 shrink-0 ml-4">
                <button
                  onClick={() => setExpandedId(expandedId === widget.id ? null : widget.id)}
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  {expandedId === widget.id ? 'Hide snippet' : 'Embed snippet'}
                </button>
                <button
                  onClick={() => handleToggle(widget.id, widget.is_active)}
                  disabled={isPending}
                  className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-40"
                >
                  {widget.is_active ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>

            <div className="mt-3 p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 font-medium">API key</span>
              </div>
              <p className="font-mono text-xs text-gray-700 mt-1 break-all">{widget.api_key}</p>
            </div>

            {expandedId === widget.id && <EmbedSnippet widget={widget} />}
          </div>
        ))}

        {widgets.length === 0 && (
          <div className="text-center py-12 text-gray-400">No widget instances yet.</div>
        )}
      </div>
    </div>
  )
}
