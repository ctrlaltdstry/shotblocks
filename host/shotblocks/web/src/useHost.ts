import { useEffect } from 'react';
import * as host from './lib/host';
import { useStore } from './store';

/** Initialize the C++ bridge and route inbound messages into the store. */
export function useHost(): void {
  useEffect(() => {
    host.init();
    const unsub = host.onMessage((msg) => {
      switch (msg.kind) {
        case 'tick':
          useStore.getState().setTick(msg.frame, msg.fps, msg.playing);
          break;
        case 'doc-info':
          useStore.getState().setDocInfo(msg.fps, msg.docFrames, msg.playRangeIn, msg.playRangeOut);
          break;
        case 'loop-state':
          // C4D's native loop button changed — mirror into the store
          // only. Do NOT send set-loop back; C++ already owns this state
          // and re-sending would ping-pong with the Timer poll.
          useStore.getState().setLoopEnabled(msg.enabled);
          break;
        case 'cameras':
          useStore.getState().setCameraStatuses(msg.items);
          break;
        case 'render-settings-drift':
          useStore.getState().setRenderSettingsStale(msg.stale);
          break;
        // om-drop handled in round 5
      }
    });
    return unsub;
  }, []);
}
