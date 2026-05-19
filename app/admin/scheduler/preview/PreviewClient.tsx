'use client'

import { useState } from 'react'

interface Widget {
  id: string
  display_name: string
  api_key: string
  is_active: boolean
}

type Viewport = 'mobile' | 'tablet' | 'desktop'

const VIEWPORT_WIDTHS: Record<Viewport, string> = {
  mobile:  '390px',
  tablet:  '768px',
  desktop: '100%',
}

const VIEWPORT_ICONS: Record<Viewport, React.ReactNode> = {
  mobile: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
  ),
  tablet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/>
      <line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
  ),
  desktop: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  ),
}

export default function PreviewClient({ widgets }: { widgets: Widget[] }) {
  const activeWidgets = widgets.filter(w => w.is_active)
  const [selectedKey, setSelectedKey] = useState(activeWidgets[0]?.api_key ?? '')
  const [viewport, setViewport] = useState<Viewport>('mobile')
  const [key, setKey] = useState(0) // used to force iframe reload

  const embedUrl = selectedKey ? `/embed/scheduler?key=${selectedKey}` : null

  if (widgets.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        No widget instances found. Create one in the{' '}
        <a href="/admin/scheduler/widgets" className="text-red-600 hover:underline">Widgets</a> tab first.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Widget selector */}
        {activeWidgets.length > 1 && (
          <select
            value={selectedKey}
            onChange={e => { setSelectedKey(e.target.value); setKey(k => k + 1) }}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {activeWidgets.map(w => (
              <option key={w.id} value={w.api_key}>{w.display_name}</option>
            ))}
          </select>
        )}

        {/* Viewport switcher */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['mobile', 'tablet', 'desktop'] as Viewport[]).map(v => (
            <button
              key={v}
              onClick={() => setViewport(v)}
              title={v.charAt(0).toUpperCase() + v.slice(1)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                viewport === v
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-500 hover:text-gray-800'
              }`}
            >
              {VIEWPORT_ICONS[v]}
              <span className="capitalize hidden sm:inline">{v}</span>
            </button>
          ))}
        </div>

        {/* Reload */}
        <button
          onClick={() => setKey(k => k + 1)}
          title="Reload preview"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-500 hover:text-gray-800 hover:border-gray-300 transition-colors bg-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          <span className="hidden sm:inline">Reload</span>
        </button>

        {/* Start over */}
        <button
          onClick={() => {
            try {
              localStorage.removeItem('castle_scheduler_flow_v1')
              sessionStorage.removeItem('castle_scheduler_session_id')
            } catch { /* ignore */ }
            setKey(k => k + 1)
          }}
          title="Start over (clears saved flow state)"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-500 hover:text-gray-800 hover:border-gray-300 transition-colors bg-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          <span className="hidden sm:inline">Start over</span>
        </button>

        {/* Open in new tab */}
        {embedUrl && (
          <a
            href={embedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-500 hover:text-gray-800 hover:border-gray-300 transition-colors bg-white ml-auto"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            <span className="hidden sm:inline">Open in tab</span>
          </a>
        )}
      </div>

      {/* Preview frame */}
      {embedUrl ? (
        <div className="flex-1 flex justify-center bg-gray-100 rounded-xl border border-gray-200 p-4 overflow-auto min-h-[600px]">
          <div
            style={{ width: VIEWPORT_WIDTHS[viewport], transition: 'width 0.2s ease' }}
            className="relative bg-white rounded-xl shadow-lg overflow-hidden flex flex-col"
          >
            {/* Browser chrome hint */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <span className="mx-auto text-xs text-gray-400 font-mono truncate max-w-[200px]">
                {embedUrl}
              </span>
            </div>
            <iframe
              key={key}
              src={embedUrl}
              className="flex-1 w-full border-none"
              style={{ minHeight: '640px' }}
              title="Scheduler preview"
            />
          </div>
        </div>
      ) : (
        <div className="text-center py-16 text-gray-400">No active widget selected.</div>
      )}
    </div>
  )
}
