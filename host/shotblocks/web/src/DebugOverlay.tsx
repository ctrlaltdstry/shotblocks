import { useEffect, useState } from 'react';

/** On-page log overlay. WebView2 inside C4D doesn't expose F12 easily,
 *  so console.log/warn/error get mirrored here. Toggle with backtick. */
export function DebugOverlay() {
  const [lines, setLines] = useState<string[]>([]);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    function append(level: string, args: unknown[]) {
      const ts = new Date().toISOString().slice(11, 19);
      const text = args.map((a) => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(' ');
      setLines((prev) => [...prev.slice(-100), `[${ts}] ${level} ${text}`]);
    }
    console.log   = (...a) => { try { append('log',  a); } catch { /* noop */ } orig.log(...a); };
    console.warn  = (...a) => { try { append('warn', a); } catch { /* noop */ } orig.warn(...a); };
    console.error = (...a) => { try { append('error', a); } catch { /* noop */ } orig.error(...a); };
    function onKey(ev: KeyboardEvent) { if (ev.key === '`') setVisible((v) => !v); }
    window.addEventListener('keydown', onKey);
    return () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!visible) return null;

  async function copyAll() {
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // WebView2 may block the clipboard API depending on permissions —
      // fall back to a textarea + execCommand which works inside file://.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
  }

  return (
    <div style={{
      // Constrained to the Inspector column (right: 0, width = inspector
      // width 300 - 12px padding either side). Sits above the help
      // button's 28x28 footprint (10px gap + 28 = 38, plus a little).
      position: 'fixed', right: 6, bottom: 48, width: 288, maxHeight: '35vh',
      padding: '6px 8px', background: 'rgba(0,0,0,0.85)',
      color: '#cfe', font: '11px/1.35 ui-monospace,Consolas,monospace',
      border: '1px solid #333', borderRadius: 4, zIndex: 9999, whiteSpace: 'pre-wrap',
      pointerEvents: 'auto',
      // Global index.css applies user-select:none; override here so the
      // user can highlight + copy log lines normally.
      userSelect: 'text',
      WebkitUserSelect: 'text',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333', paddingBottom: 4 }}>
        <span style={{ color: '#9af' }}>debug log ({lines.length})</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {/* Buttons blur on mousedown so they don't retain
              keyboard focus after click — otherwise Backspace fires
              with target=BUTTON and the click-target's default
              behavior eats our shortcut. */}
          <button onMouseDown={(e) => e.preventDefault()} onClick={copyAll}
            style={{ background: '#222', color: '#cfe', border: '1px solid #444', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', font: 'inherit' }}>
            Copy
          </button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => setLines([])}
            style={{ background: '#222', color: '#cfe', border: '1px solid #444', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', font: 'inherit' }}>
            Clear
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
