// Which panels are collapsed while reading: the left sidebar, the note list and the connections
// panel. Remembered per browser, so a low-distraction layout stays as you left it.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Icon } from './icons';
import { cx } from './util';

export type Panel = 'nav' | 'list' | 'links';
export type Hidden = Record<Panel, boolean>;

const KEY = 'exo.hiddenPanels';
const NONE: Hidden = { nav: false, list: false, links: false };

function load(): Hidden {
  try {
    return { ...NONE, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return NONE;
  }
}

export function useHiddenPanels() {
  const [hidden, setHidden] = useState<Hidden>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(hidden));
    } catch {
      /* private window: just not remembered */
    }
  }, [hidden]);
  const toggle = useCallback((p: Panel) => setHidden((h) => ({ ...h, [p]: !h[p] })), []);
  // Focus: hide everything; if everything is already hidden, bring it all back.
  const focus = useCallback(() => setHidden((h) => (h.nav && h.list && h.links ? NONE : { nav: true, list: true, links: true })), []);

  // ⌘\ (Ctrl+\ elsewhere) toggles focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [focus]);

  return { hidden, toggle, focus };
}

export const PanelsContext = createContext<ReturnType<typeof useHiddenPanels>>({ hidden: NONE, toggle: () => {}, focus: () => {} });

const LABELS: Record<Panel, string> = { nav: 'sidebar', list: 'note list', links: 'connections' };

/** Small, faint toggles in the reader's top corner. */
export function PanelToggles({ hasNote }: { hasNote: boolean }) {
  const { hidden, toggle, focus } = useContext(PanelsContext);
  const all = hidden.nav && hidden.list && hidden.links;
  const btn = (p: Panel, icon: string, extra?: string) => (
    <button
      type="button"
      className={cx('icon-btn', 'panel-toggle', extra, !hidden[p] && 'on')}
      onClick={() => toggle(p)}
      aria-pressed={!hidden[p]}
      title={`${hidden[p] ? 'Show' : 'Hide'} the ${LABELS[p]}`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
  return (
    <div className={cx('panel-toggles', all && 'focused')}>
      {btn('nav', 'panelNav', 'wide-only')}
      {hasNote && btn('list', 'panelList', 'wide-only')}
      {hasNote && btn('links', 'panelLinks')}
      <button type="button" className={cx('icon-btn', 'panel-toggle', all && 'on')} onClick={focus} title={all ? 'Show all panels (⌘\\)' : 'Focus: hide all panels (⌘\\)'}>
        <Icon name={all ? 'unfocus' : 'focus'} size={15} />
      </button>
    </div>
  );
}
