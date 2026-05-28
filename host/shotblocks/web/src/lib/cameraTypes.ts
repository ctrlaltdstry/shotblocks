import { send } from './host';
import { useStore, preferredDefaultCameraType } from '../store';

interface CameraType { id: number; label: string }

/** Reconcile the store's defaultCameraType against the live available
 *  list. If the user has made an explicit choice (cameraTypeExplicit),
 *  only correct it when that choice is no longer installed. Otherwise
 *  auto-prefer Redshift (the common case), else Standard. */
export function resolveDefaultCameraType(types: CameraType[]): void {
  if (types.length === 0) return;
  const s = useStore.getState();
  if (s.cameraTypeExplicit) {
    // Keep the user's pick unless its plugin vanished (e.g. Redshift
    // uninstalled since save) — then fall back to the preferred default.
    if (!types.some((t) => t.id === s.defaultCameraType)) {
      useStore.setState({ defaultCameraType: preferredDefaultCameraType(types) });
    }
    return;
  }
  // No explicit choice yet — set the auto-preferred default WITHOUT
  // flipping cameraTypeExplicit (setState, not the setter), so a later
  // genuine user pick still reads as explicit.
  useStore.setState({ defaultCameraType: preferredDefaultCameraType(types) });
}

/** Fetch the installed camera types from C++ and resolve the default.
 *  Idempotent — skips the fetch if the list is already populated. */
export async function ensureCameraTypes(): Promise<void> {
  if (useStore.getState().availableCameraTypes.length > 0) return;
  try {
    const ack = await send({ kind: 'get-camera-types' }) as {
      ok?: boolean;
      types?: CameraType[];
    };
    if (ack && ack.ok && Array.isArray(ack.types)) {
      useStore.getState().setAvailableCameraTypes(ack.types);
      resolveDefaultCameraType(ack.types);
    }
  } catch {
    // Non-fatal — a future Settings open retries.
  }
}
