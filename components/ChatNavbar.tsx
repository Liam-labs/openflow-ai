'use client';

// The channel header, built to the Midnight Glass chat-navbar handoff (kit v1.1.0: css/navbar.css, docs/CHAT-NAVBAR.md).
// The bar responds to the width of its host (.nb-host, a container), not the window.
import Link from 'next/link';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModelEmblem } from './ModelEmblem';
import { NbIcon, type NbIconName } from './nb-icons';

export type NavView = 'chat' | 'sprints' | 'teams' | 'ideas';

const TABS: ReadonlyArray<{ view: NavView; label: string; icon: NbIconName }> = [
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'sprints', label: 'Sprints', icon: 'sprint' },
  { view: 'teams', label: 'Teams', icon: 'teams' },
  { view: 'ideas', label: 'Ideas', icon: 'idea' },
];

export interface NavMember {
  id: string;
  name: string;
  initial: string;
  /** Model id, for the emblem; absent for people. */
  model?: string | null;
  state: 'ready' | 'working' | 'offline';
  /** Second line in tooltips and the filter menu, e.g. "Remote" or "Local". */
  where: string;
}

export interface ChatNavbarProps {
  channelName: string;
  view: NavView;
  onView: (view: NavView) => void;
  /** Phone layout: the channel list and Team panel are slide-over drawers. */
  isMobile: boolean;
  /** 'page' links to Operations; 'modal' shows a close button. */
  mode: 'page' | 'modal';
  onClose?: () => void;
  onOpenChannels: () => void;
  onOpenTeam: () => void;
  onChannelSettings: () => void;
  onChatSettings: () => void;
  chatSettingsOpen: boolean;
  members: NavMember[];
  hiddenIds: ReadonlySet<string>;
  onToggleMember: (id: string) => void;
  onShowAllMembers: () => void;
  search: {
    open: boolean;
    onToggle: () => void;
    query: string;
    onQuery: (value: string) => void;
    resultCount: number;
    resultIndex: number;
    onStep: (direction: 'next' | 'prev') => void;
    onClose: () => void;
  };
  pins: { count: number; open: boolean; onToggle: () => void };
  mentionsOnly: boolean;
  onToggleMentions: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
  docOpen: boolean;
  onDoc: () => void;
  spellcheckOn: boolean;
  onToggleSpellcheck: () => void;
  computerUse: { running: number; stopping: boolean; onStop: () => void };
  /** The Riley voice pill (Commander channel only). */
  voice?: React.ReactNode;
}

type MenuState = { kind: 'who' | 'burger'; top: number; right: number } | null;

function Member({ member, hidden }: { member: NavMember; hidden: boolean }) {
  const emblem = member.state === 'working' ? 'thinking' : 'idle';
  const pip = member.state === 'ready' ? 'online' : member.state;
  return (
    <span className={`mg-agent mg-agent--${member.state}`} style={{ display: 'contents' }}>
      <span
        className={`mg-agent__av nb-av${hidden ? ' is-hidden' : ''}`}
        data-tip={`${member.name}\n${member.where}`}
        tabIndex={0}
        aria-label={`${member.name}, ${member.where}${hidden ? ', messages hidden' : ''}`}
      >
        <ModelEmblem model={member.model} state={emblem} size={20} fallback={<span className="nb-ini" aria-hidden="true">{member.initial}</span>} />
        <span className={`mg-pip mg-pip--${pip}`} />
      </span>
    </span>
  );
}

export function ChatNavbar(p: ChatNavbarProps) {
  const chat = p.view === 'chat';
  const [menu, setMenu] = useState<MenuState>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // The sliding highlight is positioned straight on the element: it follows layout, not React state.
  const placeIndicator = useCallback(() => {
    const on = tabsRef.current?.querySelector<HTMLElement>('.nb-tab.is-on');
    const indicator = indicatorRef.current;
    if (!on || !indicator || !on.offsetWidth) return;
    indicator.style.width = `${on.offsetWidth}px`;
    indicator.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  }, []);
  useLayoutEffect(placeIndicator, [p.view, placeIndicator]);
  useEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(placeIndicator);
    observer.observe(nav);
    // No slide on first paint: enable the transition one frame later.
    const frame = requestAnimationFrame(() => { if (indicatorRef.current) indicatorRef.current.style.transition = ''; });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [placeIndicator]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (menuRef.current?.contains(target) || target?.closest('[data-a=who],[data-a=burger]')) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu, closeMenu]);

  const openMenu = (kind: 'who' | 'burger', button: HTMLElement) => {
    if (menu?.kind === kind) { setMenu(null); return; }
    const rect = button.getBoundingClientRect();
    setMenu({ kind, top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
  };

  const onTabKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const current = TABS.findIndex(t => t.view === p.view);
    const next = TABS[(current + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    event.preventDefault();
    p.onView(next.view);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('.nb-tab.is-on')?.focus());
  };

  const shown = p.members.slice(0, 5);
  const extra = p.members.length - shown.length;
  const hiddenCount = p.members.filter(m => p.hiddenIds.has(m.id)).length;
  const cu = p.computerUse.running > 0;
  const stopTip = `Stop Computer Use${p.computerUse.running > 1 ? ` (${p.computerUse.running} running)` : ''}`;
  const searching = p.search.open && chat;

  const item = (key: string, icon: NbIconName, text: string, run: () => void, opts: { on?: boolean; disabled?: boolean; danger?: boolean } = {}) => (
    <button
      key={key}
      type="button"
      className={`mg-mi${opts.on ? ' is-active' : ''}${opts.danger ? ' mg-mi--danger' : ''}`}
      role="menuitem"
      disabled={opts.disabled}
      onClick={() => { closeMenu(); run(); }}
    >
      <span className="mg-ti"><NbIcon name={icon} size={14} /></span>
      <span className="mg-tx">{text}</span>
    </button>
  );

  const whoMenu = (
    <>
      <div className="mg-label">Show messages from</div>
      {p.members.map(m => {
        const off = p.hiddenIds.has(m.id);
        return (
          <button key={m.id} type="button" className="mg-mi" role="menuitemcheckbox" aria-checked={!off} onClick={() => p.onToggleMember(m.id)}>
            <span className="em">
              <ModelEmblem model={m.model} size={15} fallback={<span className="nb-ini" aria-hidden="true">{m.initial}</span>} />
            </span>
            <span className="mg-tx">{m.name}<small>{m.where}</small></span>
            <span className={`mg-switch${off ? '' : ' mg-switch--on'}`} />
          </button>
        );
      })}
      <hr />
      <button type="button" className="link" onClick={p.onShowAllMembers}>Show all</button>
    </>
  );

  const burgerMenu = (
    <>
      <div className="mg-label">View</div>
      {TABS.map(t => item(`v-${t.view}`, t.icon, t.label, () => p.onView(t.view), { on: p.view === t.view }))}
      <hr />
      <button type="button" className="mg-mi" role="menuitem" disabled={!chat} onClick={() => setMenu(m => (m ? { ...m, kind: 'who' } : m))}>
        <span className="mg-ti"><NbIcon name="people" size={14} /></span><span className="mg-tx">Participants</span>
      </button>
      {item('channel', 'gear', 'Channel settings', p.onChannelSettings)}
      {item('cfg', 'sliders', 'Chat settings', p.onChatSettings)}
      {item('search', 'search', 'Search', p.search.onToggle, { disabled: !chat, on: searching })}
      {item('sound', p.soundOn ? 'vol' : 'mute', p.soundOn ? 'Sound on' : 'Sound muted', p.onToggleSound)}
      {item('doc', 'doc', 'Project docs', p.onDoc, { on: p.docOpen })}
      {item('spell', 'spell', p.spellcheckOn ? 'Spell check on' : 'Spell check off', p.onToggleSpellcheck)}
      {p.mode === 'page' && (
        <>
          <hr />
          <Link href="/operations" className="mg-mi" role="menuitem" onClick={closeMenu}>
            <span className="mg-ti"><NbIcon name="ops" size={14} /></span>
            <span className="mg-tx">Operations</span>
          </Link>
        </>
      )}
      {cu && <><hr />{item('stop', 'stop', 'Stop Computer Use', p.computerUse.onStop, { danger: true, disabled: p.computerUse.stopping })}</>}
    </>
  );

  return (
    <div className="nb-host mg-scope">
      <header className={`nb t-${p.view}${cu ? ' cu' : ''}${searching ? ' sr' : ''}${p.isMobile ? ' is-phone' : ''}`} role="banner">
        <div className="nb-l">
          <button type="button" className="nb-ib nb-panel" data-tip="Channels" aria-label="Open channel list" onClick={p.onOpenChannels}><NbIcon name="panel" /></button>
          <div className="nb-chan"><span className="nb-hash"><NbIcon name="hash" /></span><b title={p.channelName}>{p.channelName}</b></div>
          <button type="button" className="nb-ib nb-ib--sm nb-cogbtn" data-tip="Channel settings" aria-label="Channel settings" onClick={p.onChannelSettings}><NbIcon name="gear" size={15} /></button>
          {p.voice}
          {p.members.length > 0 && <span className="nb-sep nb-sep--st" />}
          {p.members.length > 0 && (
            <div className="nb-stack" role="group" aria-label="Participants">
              {shown.map(m => <Member key={m.id} member={m} hidden={p.hiddenIds.has(m.id)} />)}
              {extra > 0 && <span className="nb-plus" data-tip={`${extra} more`}>+{extra}</span>}
            </div>
          )}
        </div>

        <nav className="nb-tabs" role="tablist" aria-label="Views" ref={tabsRef} onKeyDown={onTabKey}>
          <span className="nb-ind" aria-hidden="true" ref={indicatorRef} style={{ transition: 'none' }} />
          {TABS.map(t => (
            <button
              key={t.view}
              type="button"
              role="tab"
              className={`nb-tab${p.view === t.view ? ' is-on' : ''}`}
              aria-selected={p.view === t.view}
              aria-label={t.label}
              tabIndex={p.view === t.view ? 0 : -1}
              onClick={() => p.onView(t.view)}
            >
              <NbIcon name={t.icon} size={15} /><span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="nb-r">
          <div className="nbsearch">
            <NbIcon name="search" size={14} />
            <input
              type="text"
              value={p.search.query}
              onChange={e => p.search.onQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && p.search.query.trim() && p.search.resultCount > 0) { e.preventDefault(); p.search.onStep(e.shiftKey ? 'prev' : 'next'); }
                if (e.key === 'Escape') p.search.onClose();
              }}
              placeholder="Search this channel"
              aria-label="Search messages"
              autoFocus={searching}
            />
            {p.search.query && p.search.resultCount > 0 && (
              <>
                <span className="nb-sc">{p.search.resultIndex + 1}/{p.search.resultCount}</span>
                <button type="button" className="nb-ib" aria-label="Previous result" onClick={() => p.search.onStep('prev')}><NbIcon name="up" size={13} /></button>
                <button type="button" className="nb-ib" aria-label="Next result" onClick={() => p.search.onStep('next')}><NbIcon name="down" size={13} /></button>
              </>
            )}
            {p.search.query && p.search.resultCount === 0 && <span className="nb-sc nb-sc--none">No results</span>}
            <button type="button" className="nb-ib" aria-label="Close search" onClick={p.search.onClose}><NbIcon name="close" size={13} /></button>
          </div>

          <button type="button" className="nb-stop" data-a="stopcu" data-tip={stopTip} aria-label={stopTip} disabled={p.computerUse.stopping} onClick={p.computerUse.onStop}>
            <i /><NbIcon name="stop" size={13} /><span className="t">Stop Computer Use</span><span className="s">Stop</span>
          </button>

          <div className="nb-cap">
            <div className="nb-grp nb-grp--chat">
              <button type="button" className={`nb-ib${searching ? ' is-on' : ''}`} data-a="search" data-tip="Search  Ctrl F" aria-label="Search" onClick={p.search.onToggle}><NbIcon name="search" /></button>
              <div className="nb-grp nb-grp--pin" hidden={p.pins.count === 0}>
                <button type="button" className={`nb-ib${p.pins.open ? ' is-on' : ''}`} data-a="pins" data-tip="Pinned messages" aria-label={`Pinned messages, ${p.pins.count}`} onClick={p.pins.onToggle}>
                  <NbIcon name="pin" /><em>{p.pins.count}</em>
                </button>
              </div>
              <button
                type="button"
                className={`nb-ib${p.mentionsOnly ? ' is-on' : ''}`}
                data-a="at"
                data-tip={p.mentionsOnly ? 'Only messages to me (on)' : 'Only messages to me'}
                aria-label="Only messages to me"
                aria-pressed={p.mentionsOnly}
                onClick={p.onToggleMentions}
              ><NbIcon name="at" /></button>
              <button
                type="button"
                className={`nb-ib${hiddenCount > 0 || menu?.kind === 'who' ? ' is-on' : ''}`}
                data-a="who"
                data-tip="Show or hide agents"
                aria-label="Participants filter"
                aria-haspopup="menu"
                onClick={e => openMenu('who', e.currentTarget)}
              ><NbIcon name="people" /><em className="blue" hidden={hiddenCount === 0}>{hiddenCount}</em></button>
            </div>
            <span className="nb-sep" />
            <button
              type="button"
              className={`nb-ib nb-ib--mute${p.soundOn ? '' : ' is-on'}`}
              data-a="mute"
              data-tip={p.soundOn ? 'Sound on' : 'Sound muted'}
              aria-label={p.soundOn ? 'Mute notifications' : 'Unmute notifications'}
              aria-pressed={!p.soundOn}
              onClick={p.onToggleSound}
            ><NbIcon name={p.soundOn ? 'vol' : 'mute'} /></button>
            <button type="button" className={`nb-ib${p.docOpen ? ' is-on' : ''}`} data-a="doc" data-tip="PROJECT.md" aria-label="Project docs" onClick={p.onDoc}><NbIcon name="doc" /></button>
            <span className="nb-sep" />
            <button type="button" className={`nb-ib${p.chatSettingsOpen ? ' is-on' : ''}`} data-a="cfg" data-tip="Chat settings" aria-label="Chat settings" onClick={p.onChatSettings}><NbIcon name="sliders" /></button>
          </div>

          <button type="button" className="nb-ib nb-people" data-a="team" data-tip="Team" aria-label="Open team panel" onClick={p.onOpenTeam}><NbIcon name="teams" /></button>
          <button type="button" className="nb-ib nb-burger" data-a="burger" aria-label="Menu" aria-haspopup="menu" aria-expanded={menu?.kind === 'burger'} onClick={e => openMenu('burger', e.currentTarget)}><NbIcon name="menu" size={18} /></button>
          {p.mode === 'page' ? (
            <Link href="/operations" className="nb-ops" data-tip="Operations hub: systems, services and health" aria-label="Operations hub"><NbIcon name="ops" size={15} /><span>Operations</span></Link>
          ) : (
            <button type="button" className="nb-ib" data-tip="Close" aria-label="Close" onClick={p.onClose}><NbIcon name="close" size={16} /></button>
          )}
        </div>
      </header>
      {menu && typeof document !== 'undefined' && createPortal(
        <div ref={menuRef} className="mg-scope fm" role="menu" style={{ top: menu.top, right: menu.right }}>
          {menu.kind === 'who' ? whoMenu : burgerMenu}
        </div>,
        document.body,
      )}
    </div>
  );
}
