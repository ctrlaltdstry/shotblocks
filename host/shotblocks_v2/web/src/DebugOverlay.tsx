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
  return (
    <div style={{
      position: 'fixed', right: 6, bottom: 24, width: 520, maxHeight: '35vh',
      overflow: 'auto', padding: '6px 8px', background: 'rgba(0,0,0,0.85)',
      color: '#cfe', font: '11px/1.35 ui-monospace,Consolas,monospace',
      border: '1px solid #333', borderRadius: 4, zIndex: 9999, whiteSpace: 'pre-wrap',
      pointerEvents: 'auto',
    }}>
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}
