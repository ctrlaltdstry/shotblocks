import type { CSSProperties } from 'react';
import { useStore, type ToolId } from '../store';
import { send } from '../lib/host';

interface ToolDef {
  id: ToolId;
  title: string;
  iconClass: string;
  iconStyle: CSSProperties;
}

// title = "<Name> (<Key>)" — the keys mirror useKeyboard.ts's tool
// shortcuts (V/B/P/H/Z/S). Keep both in sync.
const TOOLS: ToolDef[] = [
  { id: 'select', title: 'Select (V)', iconClass: 'icon--select', iconStyle: { '--icon-w': '14px', '--icon-h': '14px' } as CSSProperties },
  { id: 'razor',  title: 'Razor (B)',  iconClass: 'icon--razor',  iconStyle: { '--icon-w': '14px', '--icon-h': '14px', '--icon-rot': '45deg' } as CSSProperties },
  { id: 'pen',    title: 'Pen (P)',    iconClass: 'icon--pen',    iconStyle: { '--icon-w': '14px', '--icon-h': '14px' } as CSSProperties },
  { id: 'hand',   title: 'Hand (H)',   iconClass: 'icon--hand',   iconStyle: { '--icon-w': '16px', '--icon-h': '16px' } as CSSProperties },
  { id: 'zoom',   title: 'Zoom (Z)',   iconClass: 'icon--zoom',   iconStyle: { '--icon-w': '16px', '--icon-h': '16px' } as CSSProperties },
  { id: 'slip',   title: 'Slip (S)',   iconClass: 'icon--slip',   iconStyle: { '--icon-w': '15px', '--icon-h': '12px' } as CSSProperties },
];

/** Tool palette in the left rail. Click sets the active tool locally
 *  and informs C++ (which records but doesn't yet drive any behavior). */
export function ToolPalette() {
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);

  function pick(id: ToolId) {
    setActiveTool(id);
    send({ kind: 'tool', id }).catch(() => {});
  }

  return (
    <div className="rail__tools">
      <div className="rail__tools-inner">
        {TOOLS.map((t) => (
          <div
            key={t.id}
            className={'rail__tool' + (activeTool === t.id ? ' is-active' : '')}
            data-tooltip={t.title}
            data-tool={t.id}
            style={t.iconStyle}
            onClick={() => pick(t.id)}
          >
            <span className={'icon ' + t.iconClass} aria-label={t.title} />
          </div>
        ))}
      </div>
    </div>
  );
}
