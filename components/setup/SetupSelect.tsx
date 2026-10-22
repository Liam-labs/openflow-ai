'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SetupSelectOption {
  value: string;
  label: string;
}

interface SetupSelectProps {
  id: string;
  value: string;
  options: SetupSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Dark-themed dropdown for the setup wizard. The browser's own select popup ignores
 * the page theme (grey on grey on Windows), so this draws the list itself.
 */
export function SetupSelect({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  invalid,
  describedBy,
}: SetupSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(options[active].value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-describedby={describedBy}
        aria-required="true"
        disabled={disabled}
        className={`glass-input text-left pr-10 cursor-pointer disabled:cursor-not-allowed${invalid ? ' error' : ''}`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? '' : 'text-white/35'}>{selected ? selected.label : placeholder}</span>
      </button>
      <ChevronDown
        aria-hidden="true"
        className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1.5 py-1 rounded-xl overflow-hidden"
          style={{
            background: '#101a33',
            border: '1px solid rgba(96, 165, 250, 0.3)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
          }}
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 text-sm cursor-pointer ${
                  i === active ? 'bg-blue-500/20 text-white' : 'text-white/80'
                }`}
              >
                <span>{o.label}</span>
                {isSelected && <Check aria-hidden="true" className="w-4 h-4 text-[#60a5fa]" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
