import { useEffect, useRef } from 'react';
import { useStore, type LevelInterp } from '../store';
import { rangeToSelectionOrAll } from '../useKeyboard';

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
      checked?: boolean;
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
  const onLevelKf = menu.targetLevelKf != null;
  const onClip = menu.targetClipId != null;
  const onTrackHeader = menu.targetTrackId != null;
  const onRuler = menu.targetRulerMarker != null;
  const trackId = menu.targetTrackId;

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

  let items: Item[];
  if (onLevelKf) {
    // Pen-tool volume keyframe menu — acts on the level-keyframe
    // SELECTION (the right-clicked node was folded into it before the
    // menu opened). Delete removes all selected; an interp mode
    // applies to all selected.
    const { clipId, index } = menu.targetLevelKf!;
    const lkSel = state.levelKfSelection;
    const indices = lkSel && lkSel.clipId === clipId && lkSel.indices.length
      ? lkSel.indices : [index];
    const clip = [...state.videoTracks, ...state.audioTracks]
      .flatMap((t) => t.clips).find((c) => c.id === clipId);
    const node = clip?.levelKeyframes?.[index];
    const cur = node?.interp ?? 'linear';
    const multi = indices.length > 1;
    const interpItem = (label: string, mode: LevelInterp): Item => ({
      kind: 'item',
      label,
      checked: !multi && cur === mode,
      onPick: () => run(() => state.setLevelKeyframesInterp(clipId, indices, mode)),
    });
    items = [
      {
        kind: 'item',
        label: multi ? `Delete ${indices.length} Keyframes` : 'Delete Keyframe',
        onPick: () => run(() => {
          state.removeLevelKeyframes(clipId, indices);
          state.setLevelKfSelection(null);
        }),
      },
      { kind: 'separator' },
      interpItem('Linear', 'linear'),
      interpItem('Hold', 'hold'),
      interpItem('Ease In', 'ease-in'),
      interpItem('Ease Out', 'ease-out'),
      interpItem('Ease In-Out', 'ease-in-out'),
    ];
    if (!multi && cur === 'custom') {
      items.push({ kind: 'item', label: 'Custom', checked: true, onPick: close });
    }
  } else if (onRuler) {
    const hitFrame = menu.targetRulerMarker!.frame;
    const hasMarkers = state.markers.length > 0;
    if (hitFrame != null) {
      items = [
        {
          kind: 'item',
          label: 'Delete Marker',
          onPick: () => run(() => state.removeMarker(hitFrame)),
        },
      ];
    } else {
      items = [
        {
          kind: 'item',
          label: 'Delete All Markers',
          disabled: !hasMarkers,
          onPick: () => run(() => state.clearAllMarkers()),
        },
      ];
    }
  } else if (onTrackHeader) {
    const side: 'video' | 'audio' | null = trackId
      ? (trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null)
      : null;
    const sideTracks = side === 'video' ? state.videoTracks
                     : side === 'audio' ? state.audioTracks
                     : [];
    // "Delete Empty Tracks" is meaningful only if removing empties
    // would actually change the layout. If every clip on this side
    // already lives on contiguous tracks starting from V1/A1, there's
    // nothing to clean — grey the item out.
    const occupiedCount = sideTracks.filter((t) => t.clips.length > 0).length;
    const totalCount = sideTracks.length;
    // If there are no clips at all, the cleanup would just leave a
    // single empty V1/A1 — no change unless we have more than 1 track
    // to drop. If there ARE clips, a cleanup helps only if there are
    // more tracks than occupied ones (i.e. some are empty).
    const hasEmpty = occupiedCount === 0
      ? totalCount > 1
      : occupiedCount < totalCount;
    items = [
      {
        kind: 'item',
        label: 'Delete Track',
        onPick: () => run(() => {
          if (trackId) state.deleteTrack(trackId);
        }),
      },
      {
        kind: 'item',
        label: 'Delete Empty Tracks',
        disabled: !hasEmpty,
        onPick: () => run(() => {
          if (side) state.deleteEmptyTracks(side);
        }),
      },
    ];
  } else if (!onClip) {
    items = [
      {
        kind: 'item',
        label: 'Paste',
        hint: 'Ctrl+V',
        disabled: !clipboardHasItems,
        onPick: () => run(() => { state.pasteClips(); }),
      },
    ];
  } else {
    // Rename targets the right-clicked clip's source camera (OM rename).
    // Only meaningful for a video clip whose camera is alive — audio has
    // no camera, an orphan's camera is gone. Enters the same inline editor
    // the title double-click uses, via renamingClipId.
    const rcId = menu.targetClipId!;
    const rcClip = [...state.videoTracks].flatMap((t) => t.clips).find((c) => c.id === rcId);
    const canRenameClip = !!rcClip && rcClip.objectId > 0 && !state.orphanObjectIds.has(rcClip.objectId);
    items = [
        {
          kind: 'item',
          label: 'Rename',
          disabled: !canRenameClip,
          onPick: () => run(() => { state.setRenamingClipId(rcId); }),
        },
        { kind: 'separator' },
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
            // Locked clips (and clips on a locked track) are never removed.
            const filterTrack = <T extends { id: number; locked?: boolean; clips: { id: number; locked?: boolean; state?: string }[] }>(t: T): T =>
              t.locked ? t : {
                ...t,
                clips: t.clips.filter((c) => !ids.has(c.id) || !!c.locked || c.state === 'locked'),
              };
            useStore.setState({
              videoTracks: sNow.videoTracks.map(filterTrack),
              audioTracks: sNow.audioTracks.map(filterTrack),
              selectedClipIds: new Set<number>(),
            });
          }),
        },
        {
          kind: 'item',
          label: 'Set Range to Selection',
          hint: 'Ctrl+/',
          disabled: !hasSelection,
          onPick: () => run(() => { rangeToSelectionOrAll(useStore.getState()); }),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: lockLabel,
          hint: 'Ctrl+L',
          disabled: !hasSelection,
          onPick: () => run(() => { state.toggleLockSelection(sel); }),
        },
      ];
  }

  // Clamp position so the menu stays on-screen.
  const visibleItems = items.filter((i) => i.kind === 'item').length;
  const separators = items.filter((i) => i.kind === 'separator').length;
  const menuH = visibleItems * ITEM_HEIGHT + separators * 9 + MENU_VPADDING * 2;
  const menuW = 210;
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
            <span className="context-menu__check">{it.checked ? '✓' : ''}</span>
            <span className="context-menu__label">{it.label}</span>
            {it.hint && <span className="context-menu__hint">{it.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
