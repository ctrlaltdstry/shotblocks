import { useEffect, useState } from 'react';

type HostMessage =
  | { kind: 'hello'; port: number }
  | { kind: 'tick'; frame: number; fps: number; playing: boolean }
  | { kind: 'doc-info'; fps: number; docFrames: number; playRangeIn: number; playRangeOut: number }
  | { kind: 'om-drop'; viewportX: number; viewportY: number; items: Array<{ type: number; name: string }> };

function App() {
  const [frame, setFrame] = useState(0);
  const [fps, setFps] = useState(30);
  const [docFrames, setDocFrames] = useState(0);
  const [hostPort, setHostPort] = useState<number | null>(null);

  useEffect(() => {
    const webview = (window as { chrome?: { webview?: { addEventListener?: (event: string, handler: (ev: MessageEvent<string>) => void) => void } } }).chrome?.webview;
    if (!webview?.addEventListener) {
      return;
    }
    const onMessage = (ev: MessageEvent<string>) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: HostMessage;
      try { msg = JSON.parse(raw); }
      catch { return; }
      switch (msg.kind) {
        case 'hello':
          setHostPort(msg.port);
          break;
        case 'tick':
          setFrame(msg.frame);
          setFps(msg.fps);
          break;
        case 'doc-info':
          setDocFrames(msg.docFrames);
          setFps(msg.fps);
          break;
      }
    };
    webview.addEventListener('message', onMessage);
  }, []);

  return (
    <div style={{
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#cfe',
      background: '#1a1a1a',
      padding: 24,
      minHeight: '100vh',
      boxSizing: 'border-box',
    }}>
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Shotblocks v2 — React</h1>
      <p style={{ marginTop: 16, fontSize: 13, opacity: 0.7 }}>
        Bridge smoke test. If this renders and the frame counter ticks, the React app is loaded inside the HtmlViewer and the C++ bridge is reaching us.
      </p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13, marginTop: 16 }}>
        <dt style={{ opacity: 0.5 }}>Host port:</dt>
        <dd style={{ margin: 0 }}>{hostPort ?? '— (waiting for hello)'}</dd>
        <dt style={{ opacity: 0.5 }}>Frame:</dt>
        <dd style={{ margin: 0 }}>{frame}</dd>
        <dt style={{ opacity: 0.5 }}>FPS:</dt>
        <dd style={{ margin: 0 }}>{fps}</dd>
        <dt style={{ opacity: 0.5 }}>Doc frames:</dt>
        <dd style={{ margin: 0 }}>{docFrames || '— (waiting for doc-info)'}</dd>
      </dl>
    </div>
  );
}

export default App;
