import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  searchAddresses,
  type GeocodeResult,
} from '../lib/geocode'

type Props = {
  value: string
  onChange: (value: string) => void
  onSelect: (result: GeocodeResult) => void
  disabled?: boolean
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  disabled,
}: Props) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    const q = value.trim()
    if (q.length < 3) {
      setSuggestions([])
      setOpen(false)
      setSearching(false)
      return
    }

    if (/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(q)) {
      setSuggestions([])
      setOpen(false)
      return
    }

    const timer = window.setTimeout(async () => {
      const id = ++requestId.current
      setSearching(true)
      try {
        const results = await searchAddresses(q)
        if (id !== requestId.current) return
        setSuggestions(results)
        setOpen(results.length > 0)
        setActiveIndex(-1)
      } catch {
        if (id !== requestId.current) return
        setSuggestions([])
        setOpen(false)
      } finally {
        if (id === requestId.current) setSearching(false)
      }
    }, 280)

    return () => window.clearTimeout(timer)
  }, [value])

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [])

  function pick(result: GeocodeResult) {
    onChange(result.label)
    onSelect(result)
    setSuggestions([])
    setOpen(false)
    setActiveIndex(-1)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || !suggestions.length) {
      if (e.key === 'Escape') setOpen(false)
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      pick(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  return (
    <div className="autocomplete" ref={rootRef}>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (suggestions.length) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        placeholder="Address or click the map"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
        }
      />
      {searching && <span className="autocomplete-status">Searching…</span>}
      {open && suggestions.length > 0 && (
        <ul className="autocomplete-list" id={listId} role="listbox">
          {suggestions.map((item, index) => (
            <li key={`${item.label}-${index}`} role="presentation">
              <button
                type="button"
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={
                  index === activeIndex
                    ? 'autocomplete-option is-active'
                    : 'autocomplete-option'
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
