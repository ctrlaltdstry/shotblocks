import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/** Right-click context menu. Rendered only when state.contextMenu is
 *  non-null. Closes on outside-click, Escape, or after any item is
 *  invoked. Items act on the current selection (right-clicking an
 *  unselected clip already replaced the selection before the menu
 *  opened — see ShotBlock.onContextMenu). Empty-area menus only
 *  show Paste.
 *
 *  Position is clamped to stay inside the viewport so a menu opened
 *  near the bottom-right edge doesn't get cut off.
 */
const ITEM_HEIGHT = 24;
const MENU_VPADDING = 8;

type Item =
  | { kind: 'separator' }
  | {
      kind: 'item';
      label: string;
      hint?: string;
      disabled?: boolean;
      onPick: () => void;
    };

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const setContextMenu = useStore((s) => s.setContextMenu);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(ev: PointerEvent) {
      if (ref.current && ref.current.contains(ev.target as Node)) return;
      setContextMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setContextMenu(null);
    }
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, setContextMenu]);

  if (!menu) return null;

  const state = useStore.getState();
  const sel = state.selectedClipIds;
  const hasSelection = sel.size > 0;
  const clipboardHasItems = state.clipboard.length > 0;
  const onEmptyArea = menu.targetClipId == null;

  // Determine lock-toggle label: "Unlock" if any selected clip is
  // already locked, else "Lock". Mirrors toggleLockSelection's flip
  // rule (lock-if-any-unlocked = label says "Lock" in that case).
  let anyLocked = false;
  for (const t of [...state.videoTracks, ...state.audioTracks]) {
    for (const c of t.clips) {
      if (sel.has(c.id) && c.locked) { anyLocked = true; break; }
    }
    if (anyLocked) break;
  }
  const lockLabel = anyLocked ? 'Unlock' : 'Lock';

  function close() { setContextMenu(null); }
  function run(fn: () => void) { fn(); close(); }

  const items: Item[] = onEmptyArea
    ? [
        {
          kind: 'item',
          label: 'Paste',
          hint: 'Ctrl+V',
          disabled: !clipboardHasItems,
          onPick: () => run(() => { state.pasteClips(); }),
        },
      ]
    : [
        {
          kind: 'item',
          label: 'Cut',
          hint: 'Ctrl+X',
          disabled: !hasSelection,
          onPick: () => run(() => { state.cutClips(sel); }),
        },
        {
          kind: 'item',
          label: 'Copy',
          hint: 'Ctrl+C',
          disabled: !hasSelection,
          onPick: () => run(() => { state.copyClips(sel); }),
        },
        {
          kind: 'item',
          label: 'Paste',
          hint: 'Ctrl+V',
          disabled: !clipboardHasItems,
          onPick: () => run(() => { state.pasteClips(); }),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Delete',
          hint: 'Del',
          disabled: !hasSelection,
          onPick: () => run(() => {
            // Inline delete — same path as useKeyboard's deleteSelection.
            const sNow = useStore.getState();
            const ids = sNow.selectedClipIds;
            const filterTrack = <T extends { id: number; clips: { id: number }[] }>(t: T) => ({
              ...t,
              clips: t.clips.filter((c) => !ids.has(c.id)),
            });
            useStore.setState({
              videoTracks: sNow.videoTracks.map(filterTrack).filter((t) => t.id === 1 || t.clips.length > 0),
              audioTracks: sNow.audioTracks.map(filterTrack).filter((t) => t.id === 1 || t.clips.length > 0),
              selectedClipIds: new Set<number>(),
            });
          }),
        },
        {
          kind: 'item',
          label: 'Split at Playhead',
          disabled: !hasSelection,
          onPick: () => run(() => { state.splitSelectionAtPlayhead(sel); }),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: lockLabel,
          disabled: !hasSelection,
          onPick: () => run(() => { state.toggleLockSelection(sel); }),
        },
      ];

  // Clamp position so the menu stays on-screen.
  const visibleItems = items.filter((i) => i.kind === 'item').length;
  const separators = items.filter((i) => i.kind === 'separator').length;
  const menuH = visibleItems * ITEM_HEIGHT + separators * 9 + MENU_VPADDING * 2;
  const menuW = 180;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(menu.x, vw - menuW - 4);
  const top = Math.min(menu.y, vh - menuH - 4);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: left + 'px', top: top + 'px', width: menuW + 'px' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') {
          return <div key={'sep-' + i} className="context-menu__separator" />;
        }
        return (
          <div
            key={it.label + i}
            className={'context-menu__item' + (it.disabled ? ' is-disabled' : '')}
            onPointerDown={(e) => {
              // Use pointerdown (not click) so the outside-pointerdown
              // listener doesn't fire first and close the menu before
              // our click reaches us.
              if (it.disabled) return;
              e.preventDefault();
              e.stopPropagation();
              it.onPick();
            }}
          >
            <span className="context-menu__label">{it.label}</span>
            {it.hint && <span className="context-menu__hint">{it.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
