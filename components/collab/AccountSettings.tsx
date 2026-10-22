'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, ArrowUp, ArrowDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { effectiveSidebarSections, validateProfilePatch, type AccountProfile, type AccountPatch, type SidebarSection } from '@/lib/account-profile';

export interface AccountState { profile: AccountProfile; sidebar: { sections: SidebarSection[]; collapsedGroups: Record<string, true> }; }
export function useAccountSettings() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    try {
      const response = await fetch('/api/account'); const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load your account.');
      if (!pending.current) { setAccount(data); setError(''); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load your account.'); }
  }, []);
  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); window.addEventListener('devflow:account-changed', refresh); return () => { window.removeEventListener('focus', refresh); window.removeEventListener('devflow:account-changed', refresh); }; }, [refresh]);
  const save = async (patch: AccountPatch) => {
    pending.current = true;
    try {
      const response = await fetch('/api/account', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not save your changes.');
      setAccount(data); setError('');
    } finally { pending.current = false; window.dispatchEvent(new Event('devflow:account-changed')); }
  };
  return { account, error, refresh, save };
}
export const SECTION_NAMES: Record<string, string> = { commander: 'Commander', pinned: 'Pinned', groups: 'Groups', archived: 'Archived', 'channel-tools': 'Channel tools', roles: 'Roles' };
const button = 'rounded-lg px-3 py-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-35';
export function SettingsDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button, textarea')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]') || []);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className="fixed inset-0 z-[100] bg-black/65 flex items-center justify-center p-3" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border border-white/15 bg-[#101c2d] p-5 text-white shadow-2xl">
      <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">{title}</h2><button className={button} aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>{children}
    </div>
  </div>, document.body);
}
export function AccountSettings({ account, mode, onSave, onClose }: { account: AccountState; mode: 'account' | 'sidebar'; onSave: (patch: AccountPatch) => Promise<void>; onClose: () => void }) {
  const [profile, setProfile] = useState(account.profile);
  const [sections, setSections] = useState(account.sidebar.sections);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const submit = async () => {
    setSaved(false); setError('');
    if (mode === 'account') { const check = validateProfilePatch(profile); if (!check.ok) { setError(check.errors.map(e => e.message).join(' ')); return; } }
    setBusy(true);
    try { await onSave(mode === 'account' ? { profile } : { sidebar: { sections } }); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  const move = (index: number, delta: number) => { const next = [...sections]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; setSections(next); setSaved(false); };
  return <SettingsDialog title={mode === 'account' ? 'Your account' : 'Customise sidebar'} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset disabled={busy} className="space-y-4">
      {mode === 'account' ? <>
        <label className="block text-sm">Name<input required value={profile.displayName} onChange={e => { setProfile({ ...profile, displayName: e.target.value }); setSaved(false); }} className="block mt-1 w-full rounded-lg bg-black/25 border border-white/20 p-2" /></label>
        <label className="block text-sm">Email <span className="text-white/50">(optional)</span><input type="email" value={profile.email} onChange={e => { setProfile({ ...profile, email: e.target.value }); setSaved(false); }} className="block mt-1 w-full rounded-lg bg-black/25 border border-white/20 p-2" /></label>
        <label className="block text-sm">About you<textarea rows={8} value={profile.about} onChange={e => { setProfile({ ...profile, about: e.target.value }); setSaved(false); }} className="block mt-1 w-full rounded-lg bg-black/25 border border-white/20 p-2" /><span className="text-xs text-white/50">Things your agents should know. {Array.from(profile.about).length.toLocaleString()} / 4,000 characters</span></label>
      </> : <>
        <p className="text-sm text-white/60">Choose what appears and in which order. This layout follows you across devices.</p>
        {sections.map((section, index) => <div key={section.id} className="flex items-center gap-2 border-b border-white/10 pb-2">
          <label className="flex flex-1 items-center gap-3 text-sm"><input type="checkbox" role="switch" checked={section.visible} onChange={e => { setSections(sections.map(s => s.id === section.id ? { ...s, visible: e.target.checked } : s)); setSaved(false); }} />{SECTION_NAMES[section.id]}</label>
          <button type="button" className={button} disabled={!index} aria-label={`Move ${SECTION_NAMES[section.id]} up`} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
          <button type="button" className={button} disabled={index === sections.length - 1} aria-label={`Move ${SECTION_NAMES[section.id]} down`} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
        </div>)}
        <button type="button" className={button} onClick={() => { setSections(effectiveSidebarSections(null)); setSaved(false); }}>Reset to default</button>
      </>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {saved && <p role="status" className="text-sm text-emerald-300">{mode === 'account' ? 'Saved. Your agents will see this the next time they start.' : 'Sidebar saved.'}</p>}
      <div className="flex justify-end"><button disabled={busy} className={`${button} bg-blue-500/25 text-blue-100`} type="submit">{busy ? 'Saving…' : 'Save'}</button></div>
    </fieldset></form>
  </SettingsDialog>;
}
