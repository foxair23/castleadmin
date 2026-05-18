'use client'

import { useState, useTransition } from 'react'
import { addCity, toggleCity, deleteCity } from './actions'

interface City {
  id: string
  city: string
  state: string
  is_active: boolean
}

export default function ServiceAreaClient({ initialCities }: { initialCities: City[] }) {
  const [cities, setCities] = useState(initialCities)
  const [isPending, startTransition] = useTransition()
  const [newCity, setNewCity] = useState('')
  const [newState, setNewState] = useState('CA')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  function handleAdd() {
    if (!newCity.trim()) return
    setError('')
    startTransition(async () => {
      try {
        await addCity(newCity, newState)
        setCities(prev => [...prev, { id: Math.random().toString(), city: newCity.trim(), state: newState, is_active: true }].sort((a, b) => a.city.localeCompare(b.city)))
        setNewCity('')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to add city')
      }
    })
  }

  function handleToggle(id: string, current: boolean) {
    setError('')
    startTransition(async () => {
      try {
        await toggleCity(id, !current)
        setCities(prev => prev.map(c => c.id === id ? { ...c, is_active: !current } : c))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update city')
      }
    })
  }

  function handleDelete(id: string, name: string) {
    if (!confirm(`Remove ${name} from the service area?`)) return
    setError('')
    startTransition(async () => {
      try {
        await deleteCity(id)
        setCities(prev => prev.filter(c => c.id !== id))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete city')
      }
    })
  }

  const filtered = cities.filter(c =>
    c.city.toLowerCase().includes(search.toLowerCase()) ||
    c.state.toLowerCase().includes(search.toLowerCase())
  )

  const active = filtered.filter(c => c.is_active)
  const inactive = filtered.filter(c => !c.is_active)

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Service Area</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      {/* Add city */}
      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Add city</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={newCity}
            onChange={e => setNewCity(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="City name"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
          />
          <input
            type="text"
            value={newState}
            onChange={e => setNewState(e.target.value.toUpperCase().slice(0, 2))}
            maxLength={2}
            className="w-16 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 text-center"
          />
          <button
            onClick={handleAdd}
            disabled={isPending || !newCity.trim()}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search cities…"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-red-500"
      />

      <p className="text-xs text-gray-400 mb-3">
        {active.length} active · {inactive.length} inactive · {cities.length} total
      </p>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">No cities found.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {filtered.map(city => (
                <tr key={city.id} className={city.is_active ? '' : 'opacity-50'}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-gray-900">{city.city}</span>
                    <span className="text-gray-400 ml-1">{city.state}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-3">
                      <button
                        onClick={() => handleToggle(city.id, city.is_active)}
                        disabled={isPending}
                        className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40"
                      >
                        {city.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDelete(city.id, city.city)}
                        disabled={isPending}
                        className="text-xs text-red-400 hover:text-red-600 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
