import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { send } from '../lib/host';
import sectionChevronUrl from '../icons/inspector-section-chevron.svg';
import dropdownChevronUrl from '../icons/inspector-dropdown-chevron.svg';
import folderUrl from '../icons/inspector-folder.svg';
import helpButtonUrl from '../icons/help-button.svg';

/** Right-side Inspector panel — always visible at the fixed width
 *  defined in Figma node 365:668. Hosts render settings now; the
 *  Render / Motion tab strip designed in Figma is intentionally
 *  omitted in v1 since there's only one tab to show. Tabs come back
 *  when v2 motion layers ship.
 *
 *  Each section is a dark rounded card with a clickable title bar
 *  and a body of rows. Collapse state lives in-component (not
 *  persisted between sessions in v1).
 */
const RENDER_MODE_OPTIONS = [
  { value: 'individual-shots' as const, label: 'Individual shots' },
  { value: 'whole-sequence'   as const, label: 'Whole sequence' },
];

export function Inspector() {
  const renderMode = useStore((s) => s.renderMode);
  const setRenderMode = useStore((s) => s.setRenderMode);
  const renderSettingsStale = useStore((s) => s.renderSettingsStale);
  // Subscribe to videoTracks so the Add-to-Queue button enable/disable
  // reacts as clips come and go.
  const videoTracks = useStore((s) => s.videoTracks);
  const currentLabel = RENDER_MODE_OPTIONS.find((o) => o.value === renderMode)?.label
    ?? 'Individual shots';

  // Add-to-Queue is disabled when there's nothing to send. Whole-
  // sequence still queues an empty doc as a single entry — that's a
  // valid C4D-side workflow — so we only block when there are zero
  // video clips at all. Individual-shots additionally needs at least
  // one clip with a live camera link; otherwise C++ would return
  // "All shots are orphan" and the click would be a no-op.
  const totalClips = videoTracks.reduce((n, t) => n + t.clips.length, 0);
  const linkedClips = videoTracks.reduce(
    (n, t) => n + t.clips.filter((c) => !!c.objectId).length, 0);
  const addDisabled = renderMode === 'individual-shots' ? linkedClips === 0 : totalClips === 0;
  const addTooltip = addDisabled
    ? (renderMode === 'individual-shots'
        ? (totalClips === 0 ? 'No shots to render' : 'All shots are orphan')
        : 'Nothing on the timeline to render')
    : undefined;

  // Status line text shown below the Add-to-Queue button. Auto-clears
  // 5s after each click. Local state — not part of the store.
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'ok' | 'err'>('ok');
  // Brief pulse on the Add-to-Queue button after a successful add —
  // visual receipt that the click actually did something (the Render
  // Queue window opens behind C4D's main window in some layouts, so a
  // local-button cue is useful). Toggled by onAddToQueue.
  const [pulsing, setPulsing] = useState(false);

  async function onAddToQueue() {
    if (addDisabled) return;
    type Ack = { ok?: boolean; status?: string };
    let ack: Ack;
    if (renderMode === 'individual-shots') {
      // Walk videoTracks in document order (V1 first, then V2, ...) and
      // collect every clip with an objectId > 0. objectId === 0 means
      // the clip has no source camera link (orphan / never-linked) — no
      // point sending it; C++ would skip it anyway.
      const tracks = useStore.getState().videoTracks;
      const cameraNames = useStore.getState().cameraNames;
      const shots: { clipId: number; name: string; inFrame: number; outFrame: number; objectId: number }[] = [];
      for (const t of tracks) {
        for (const c of t.clips) {
          if (!c.objectId) continue;
          shots.push({
            clipId: c.id,
            // Live OM name wins over the persisted sourceName so
            // renames flow through; the persisted name is the fallback
            // when the camera was deleted out from under us.
            name: cameraNames.get(c.objectId) || c.sourceName || '',
            inFrame: c.inFrame,
            outFrame: c.outFrame,
            objectId: c.objectId,
          });
        }
      }
      ack = await send({ kind: 'add-to-queue', mode: 'individual-shots', shots }) as Ack;
    } else {
      ack = await send({ kind: 'add-to-queue', mode: 'whole-sequence' }) as Ack;
    }
    const text = (ack && ack.status) || (ack && ack.ok ? 'Added to Render Queue' : 'Add to Queue failed');
    setStatus(text);
    setStatusKind(ack && ack.ok ? 'ok' : 'err');
    if (ack && ack.ok) {
      // Retrigger the animation cleanly: clear then set on the next
      // frame so React applies the class removal before re-adding it
      // (otherwise repeated successful clicks would only animate
      // once).
      setPulsing(false);
      requestAnimationFrame(() => setPulsing(true));
      window.setTimeout(() => setPulsing(false), 700);
    }
    // Auto-clear after 5s. A subsequent click resets the timer (the
    // setStatus on this run is the new "latest" message; the previous
    // setTimeout still fires but harmlessly clears an already-cleared
    // status).
    window.setTimeout(() => setStatus(null), 5000);
  }

  async function onSyncRenderSettings() {
    if (!renderSettingsStale) return;
    await send({ kind: 'sync-render-settings' });
    // C++ pushes render-settings-drift{stale:false} after the sync;
    // the button greys back out on its own through the store. No
    // status line — sync is silent on success.
  }

  return (
    <div className="inspector">
      <div className="inspector__body">
        <InspectorSection title="Render">
          <InspectorRow label="Render mode">
            <InspectorDropdown
              value={currentLabel}
              options={RENDER_MODE_OPTIONS}
              onSelect={(v) => setRenderMode(v as 'whole-sequence' | 'individual-shots')}
            />
          </InspectorRow>
          <div className="inspector-section__action">
            {/* Whole-sequence renders go through C4D's Render to Picture
                Viewer (Plan 4.1 makes native paths switch cameras), so
                the queue + settings buttons only apply to Individual
                shots. */}
            {renderMode === 'individual-shots' && (
              <div className="inspector-section__button-row">
                <InspectorButton
                  onClick={onAddToQueue}
                  disabled={addDisabled}
                  title={addTooltip}
                  pulsing={pulsing}
                >
                  Add to Queue
                </InspectorButton>
                <InspectorButton
                  onClick={onSyncRenderSettings}
                  disabled={!renderSettingsStale}
                  variant={renderSettingsStale ? 'primary' : 'ghost'}
                >
                  <span className="inspector-button__icon inspector-button__icon--sync" />
                  Settings
                </InspectorButton>
              </div>
            )}
            {status && (
              <div className={'inspector-section__status is-' + statusKind}>
                {status}
              </div>
            )}
          </div>
        </InspectorSection>
      </div>
      <HelpButton />
    </div>
  );
}

/** Help button — Figma node 400:1958. 24x24 circle pinned bottom-right
 *  of the Inspector panel, 10px from each edge. Pre-composed SVG (circle
 *  + border + drop shadow + glyph all baked in) — rendered as <img>, not
 *  a mask. Hover brightens via CSS filter since the SVG fill is hard-
 *  coded. Click asks C++ to open the bundled user manual
 *  (docs/index.html) in the OS default browser. */
function HelpButton() {
  return (
    <button
      type="button"
      className="inspector-help-button"
      data-tooltip="Open user manual"
      data-tooltip-pos="above"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { void send({ kind: 'open-manual' }); }}
    >
      <img src={helpButtonUrl} alt="Help" />
    </button>
  );
}

/** Collapsible section card — Figma node 375:1176 / 376:1254.
 *  Title bar always visible (clickable to toggle); body shows when
 *  expanded. Reused for every inspector section. */
export function InspectorSection({
  title,
  defaultExpanded = true,
  children,
}: {
  title: string;
  defaultExpanded?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className={'inspector-section' + (expanded ? '' : ' is-collapsed')}>
      <div
        className="inspector-section__header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="inspector-section__title">{title}</span>
        <img
          className="inspector-section__chevron"
          src={sectionChevronUrl}
          alt=""
        />
      </div>
      {/* Collapse wrapper — animates via grid-template-rows 0fr → 1fr.
          Body is ALWAYS in the DOM so the transition has something
          to animate against; the wrapper clips it via overflow-hidden
          when collapsed. */}
      <div className="inspector-section__collapse">
        <div className="inspector-section__collapse-inner">
          <div className="inspector-section__body">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A labeled row inside a section — Figma row pattern from nodes
 *  376:1213, 376:1246, 376:1222, 376:1281. Label on the left, the
 *  passed control on the right. */
export function InspectorRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="inspector-row">
      <span className="inspector-row__label">{label}</span>
      <div className="inspector-row__control">{children}</div>
    </div>
  );
}

/** Dropdown control — Figma node 376:1216. A grey-24 pill with the
 *  current value centered and a small chevron-down on the right.
 *
 *  Two usage shapes:
 *  - With `options` + `onSelect` → a real picker. Clicking the pill
 *    opens a small floating menu directly below it; clicking an
 *    option fires onSelect with that option's `value`. The menu
 *    dismisses on outside-click or Escape.
 *  - With only `onClick` → caller wires the click manually. Used for
 *    static "display value" rows where the menu lives elsewhere. */
export function InspectorDropdown<T extends string>({
  value,
  options,
  onSelect,
  onClick,
}: {
  value: string;
  options?: { value: T; label: string }[];
  onSelect?: (value: T) => void;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Recompute the menu's position whenever it opens — relative to the
  // pill's current viewport rect. We re-measure on resize too so a
  // dialog resize while open doesn't strand the menu.
  useEffect(() => {
    if (!open) return;
    function place() {
      const el = pillRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.bottom + 2, width: r.width });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // Close on outside-click + Escape. Outside includes anywhere that
  // isn't the pill or the menu itself.
  useEffect(() => {
    if (!open) return;
    function onDown(ev: PointerEvent) {
      const t = ev.target as Node;
      if (pillRef.current && pillRef.current.contains(t)) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function onPillClick() {
    if (options && options.length > 0) {
      setOpen((v) => !v);
    } else if (onClick) {
      onClick();
    }
  }

  return (
    <>
      <div className="inspector-dropdown" onClick={onPillClick} ref={pillRef}>
        <span className="inspector-dropdown__value">{value}</span>
        <img
          className="inspector-dropdown__chevron"
          src={dropdownChevronUrl}
          alt=""
        />
      </div>
      {/* Menu lives in a portal at document.body so it escapes the
          inspector / section card's `overflow: hidden` clipping. */}
      {open && options && rect && createPortal(
        <div
          ref={menuRef}
          className="inspector-dropdown__menu"
          style={{
            left: rect.left + 'px',
            top: rect.top + 'px',
            width: rect.width + 'px',
          }}
        >
          {options.map((opt) => (
            <div
              key={opt.value}
              className={
                'inspector-dropdown__menu-item'
                + (opt.label === value ? ' is-selected' : '')
              }
              onPointerDown={(e) => {
                // Use pointerdown so the outside-pointerdown listener
                // doesn't fire first and close the menu before our
                // click reaches us.
                e.preventDefault();
                e.stopPropagation();
                onSelect?.(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Toggle switch — Figma node 376:1249. Primary-highlight blue when
 *  on with the handle slid right; grey-24 when off with the handle
 *  on the left. */
export function InspectorToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={'inspector-toggle' + (on ? ' is-on' : '')}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <div className="inspector-toggle__handle" />
    </div>
  );
}

/** Button — Figma node 357:741. Grey-24 fill, 4px radius, white text.
 *  Hovers slightly lighter; pressed flashes primary-highlight blue.
 *  Disabled state is grey-24 at reduced opacity, no hover/press. */
export function InspectorButton({
  children,
  onClick,
  disabled = false,
  variant = 'default',
  title,
  pulsing = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** 'default' = grey-24 fill (the Add-to-Queue style).
   *  'primary' = Maxon-blue fill, used when a button is the active
   *    next step (e.g. Sync Render Settings while drift is detected).
   *  'ghost'   = transparent fill with dim text, used for the
   *    deactivated/idle state of a button that should still be
   *    visible (e.g. Sync Render Settings while in sync). */
  variant?: 'default' | 'primary' | 'ghost';
  /** Native browser tooltip — set when the button is disabled to
   *  explain why (e.g. "No shots to render"). */
  title?: string;
  /** Triggers a one-shot CSS pulse animation for visual receipt of
   *  a successful click. Caller is responsible for toggling false
   *  again after the animation runs. */
  pulsing?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        'inspector-button'
        + (disabled ? ' is-disabled' : '')
        + (variant !== 'default' ? ' is-' + variant : '')
        + (pulsing ? ' is-pulsing' : '')
      }
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

/** File-path input — Figma node 376:1284. A grey-12 input-shaped
 *  control with text on the left and a trailing folder icon. Click
 *  the icon to open the OS folder picker (callback is the caller's). */
export function InspectorPathField({
  value,
  onPickFolder,
}: {
  value: string;
  onPickFolder?: () => void;
}) {
  return (
    <div className="inspector-pathfield">
      <span className="inspector-pathfield__value">{value}</span>
      <img
        className="inspector-pathfield__icon"
        src={folderUrl}
        alt=""
        onClick={(ev) => {
          ev.stopPropagation();
          onPickFolder?.();
        }}
      />
    </div>
  );
}
