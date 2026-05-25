import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import sectionChevronUrl from '../icons/inspector-section-chevron.svg';
import dropdownChevronUrl from '../icons/inspector-dropdown-chevron.svg';
import folderUrl from '../icons/inspector-folder.svg';

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
  const currentLabel = RENDER_MODE_OPTIONS.find((o) => o.value === renderMode)?.label
    ?? 'Individual shots';
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
        </InspectorSection>
      </div>
    </div>
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
