import { useState, type ReactNode } from 'react';
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
export function Inspector() {
  return (
    <div className="inspector">
      <div className="inspector__body">
        {/* Render sections fill in starting Commit 8. Two placeholder
            sections present here just to demonstrate the pattern; they
            get replaced with real content as we go. */}
        <InspectorSection title="Render Scope" />
        <InspectorSection title="Output" />
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
      {expanded && (
        <div className="inspector-section__body">
          {children}
        </div>
      )}
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
 *  Click handler is the caller's responsibility (v1 just shows the
 *  static value; opening the actual menu lands per-field). */
export function InspectorDropdown({
  value,
  onClick,
}: {
  value: string;
  onClick?: () => void;
}) {
  return (
    <div className="inspector-dropdown" onClick={onClick}>
      <span className="inspector-dropdown__value">{value}</span>
      <img
        className="inspector-dropdown__chevron"
        src={dropdownChevronUrl}
        alt=""
      />
    </div>
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
