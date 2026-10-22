'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Loader2, AlertCircle, RefreshCw, Phone, Hash } from 'lucide-react';

interface AllowListData {
  numbers: string[];
  lids: string[];
}

type TabId = 'numbers' | 'lids';

export function WhatsAppAllowListPanel() {
  const [data, setData] = useState<AllowListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<TabId>('numbers');

  const [numberInput, setNumberInput] = useState('');
  const [lidInput, setLidInput] = useState('');
  const [addingNumber, setAddingNumber] = useState(false);
  const [addingLid, setAddingLid] = useState(false);
  const [addError, setAddError] = useState('');
  const [removingItem, setRemovingItem] = useState<string | null>(null);

  const fetchAllowList = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bridges/whatsapp/allowed');
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
      const json = await res.json() as AllowListData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load allow list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllowList();
  }, [fetchAllowList]);

  const handleAddNumber = async () => {
    const trimmed = numberInput.trim();
    if (!trimmed) return;
    setAddError('');
    setAddingNumber(true);
    try {
      const res = await fetch('/api/bridges/whatsapp/allowed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: trimmed }),
      });
      const json = await res.json() as { error?: string; allowedNumbers?: string[] };
      if (json.error) throw new Error(json.error);
      setNumberInput('');
      await fetchAllowList();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add number');
    } finally {
      setAddingNumber(false);
    }
  };

  const handleAddLid = async () => {
    const trimmed = lidInput.trim();
    if (!trimmed) return;
    setAddError('');
    setAddingLid(true);
    try {
      const res = await fetch('/api/bridges/whatsapp/allowed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lid: trimmed }),
      });
      const json = await res.json() as { error?: string; allowedLids?: string[] };
      if (json.error) throw new Error(json.error);
      setLidInput('');
      await fetchAllowList();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add LID');
    } finally {
      setAddingLid(false);
    }
  };

  const handleRemove = async (type: 'number' | 'lid', value: string) => {
    setRemovingItem(value);
    try {
      const body = type === 'number' ? { number: value } : { lid: value };
      const res = await fetch('/api/bridges/whatsapp/allowed', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { error?: string };
      if (json.error) throw new Error(json.error);
      await fetchAllowList();
    } catch {
      // Non-fatal — list will refresh anyway
    } finally {
      setRemovingItem(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <Loader2 className="w-6 h-6 text-white/30 animate-spin mb-3" />
        <p className="text-sm text-white/40">Loading allow list...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 px-6">
        <div className="w-full max-w-sm">
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-5">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">Could not load allow list</p>
              <p className="text-xs text-red-400/70 mt-0.5">{error}</p>
            </div>
          </div>
          <button
            onClick={fetchAllowList}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
              border border-white/20 text-white/70 hover:text-white hover:bg-white/10
              text-sm transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const numbers = data?.numbers ?? [];
  const lids = data?.lids ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 flex-shrink-0">
        <button
          onClick={() => { setActiveTab('numbers'); setAddError(''); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'numbers'
              ? 'bg-white/10 text-white'
              : 'text-white/40 hover:text-white/70 hover:bg-white/5'
          }`}
        >
          <Phone className="w-3.5 h-3.5" />
          Phone Numbers
          {numbers.length > 0 && (
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300 text-[10px] font-bold">
              {numbers.length}
            </span>
          )}
        </button>
        <button
          onClick={() => { setActiveTab('lids'); setAddError(''); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'lids'
              ? 'bg-white/10 text-white'
              : 'text-white/40 hover:text-white/70 hover:bg-white/5'
          }`}
        >
          <Hash className="w-3.5 h-3.5" />
          LIDs
          {lids.length > 0 && (
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300 text-[10px] font-bold">
              {lids.length}
            </span>
          )}
        </button>
        <div className="flex-1" />
        <button
          onClick={fetchAllowList}
          className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-all"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="w-full h-px bg-white/[0.06] mt-3 flex-shrink-0" />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {activeTab === 'numbers' && (
          <NumbersTab
            numbers={numbers}
            removingItem={removingItem}
            onRemove={(n) => handleRemove('number', n)}
            inputValue={numberInput}
            onInputChange={setNumberInput}
            onAdd={handleAddNumber}
            adding={addingNumber}
            addError={addError}
          />
        )}
        {activeTab === 'lids' && (
          <LidsTab
            lids={lids}
            removingItem={removingItem}
            onRemove={(l) => handleRemove('lid', l)}
            inputValue={lidInput}
            onInputChange={setLidInput}
            onAdd={handleAddLid}
            adding={addingLid}
            addError={addError}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface NumbersTabProps {
  numbers: string[];
  removingItem: string | null;
  onRemove: (n: string) => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
  addError: string;
}

function NumbersTab({
  numbers,
  removingItem,
  onRemove,
  inputValue,
  onInputChange,
  onAdd,
  adding,
  addError,
}: NumbersTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-white/40 leading-relaxed">
        Only messages from these numbers are forwarded to your agents.
        Use E.164 format — e.g. <span className="font-mono text-white/60">+447700900000</span>.
      </p>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
          placeholder="+447700900000"
          className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm
            text-white placeholder:text-white/25 focus:outline-none focus:border-green-500/40
            focus:bg-white/8 transition-all font-mono"
        />
        <button
          onClick={onAdd}
          disabled={adding || !inputValue.trim()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-green-500/20
            border border-green-500/30 text-green-300 text-sm font-medium
            hover:bg-green-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add
        </button>
      </div>

      {addError && (
        <p className="text-xs text-red-400 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {addError}
        </p>
      )}

      {/* List */}
      {numbers.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-center">
          <Phone className="w-8 h-8 text-white/15 mb-3" />
          <p className="text-sm text-white/30">No numbers on the allow list</p>
          <p className="text-xs text-white/20 mt-1">Add a number above to get started</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {numbers.map((n) => (
            <li
              key={n}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03]
                border border-white/[0.06] group hover:bg-white/[0.06] transition-all"
            >
              <Phone className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
              <span className="flex-1 font-mono text-sm text-white/80">{n}</span>
              <button
                onClick={() => onRemove(n)}
                disabled={removingItem === n}
                className="p-1 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10
                  opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30"
                title="Remove"
              >
                {removingItem === n
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />
                }
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface LidsTabProps {
  lids: string[];
  removingItem: string | null;
  onRemove: (l: string) => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
  addError: string;
}

function LidsTab({
  lids,
  removingItem,
  onRemove,
  inputValue,
  onInputChange,
  onAdd,
  adding,
  addError,
}: LidsTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-white/40 leading-relaxed">
        WhatsApp LIDs identify linked devices. Add a LID when a contact's phone number alone isn't enough
        to uniquely identify their device.
      </p>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
          placeholder="lid:abc123"
          className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm
            text-white placeholder:text-white/25 focus:outline-none focus:border-green-500/40
            focus:bg-white/8 transition-all font-mono"
        />
        <button
          onClick={onAdd}
          disabled={adding || !inputValue.trim()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-green-500/20
            border border-green-500/30 text-green-300 text-sm font-medium
            hover:bg-green-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add
        </button>
      </div>

      {addError && (
        <p className="text-xs text-red-400 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {addError}
        </p>
      )}

      {/* List */}
      {lids.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-center">
          <Hash className="w-8 h-8 text-white/15 mb-3" />
          <p className="text-sm text-white/30">No LIDs on the allow list</p>
          <p className="text-xs text-white/20 mt-1">Add a LID above to get started</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lids.map((l) => (
            <li
              key={l}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03]
                border border-white/[0.06] group hover:bg-white/[0.06] transition-all"
            >
              <Hash className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
              <span className="flex-1 font-mono text-sm text-white/80 break-all">{l}</span>
              <button
                onClick={() => onRemove(l)}
                disabled={removingItem === l}
                className="p-1 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10
                  opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30"
                title="Remove"
              >
                {removingItem === l
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />
                }
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
