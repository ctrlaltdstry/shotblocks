import type { CSSProperties } from 'react';
import { useStore, type ToolId } from '../store';
import { send } from '../lib/host';

interface ToolDef {
  id: ToolId;
  title: string;
  iconClass: string;
  iconStyle: CSSProperties;
}

const TOOLS: ToolDef[] = [
  { id: 'select', title: 'Select', iconClass: 'icon--select', iconStyle: { '--icon-w': '14px', '--icon-h': '14px' } as CSSProperties },
  { id: 'razor',  title: 'Razor',  iconClass: 'icon--razor',  iconStyle: { '--icon-w': '14px', '--icon-h': '14px', '--icon-rot': '45deg' } as CSSProperties },
  { id: 'pen',    title: 'Pen',    iconClass: 'icon--pen',    iconStyle: { '--icon-w': '14px', '--icon-h': '14px' } as CSSProperties },
  { id: 'range',  title: 'Range',  iconClass: 'icon--range',  iconStyle: { '--icon-w': '15px', '--icon-h': '12px' } as CSSProperties },
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
      {TOOLS.map((t) => (
        <div
          key={t.id}
          className={'rail__tool' + (activeTool === t.id ? ' is-active' : '')}
          title={t.title}
          data-tool={t.id}
          style={t.iconStyle}
          onClick={() => pick(t.id)}
        >
          <span className={'icon ' + t.iconClass} aria-label={t.title} />
        </div>
      ))}
    </div>
  );
}
