import { useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface StimulusMarker { eventId: string; timestamp: number; label: string; edge: string; modality: string }
let markers: StimulusMarker[] = [];
let cleanup: UnlistenFn | undefined;
let generation = 0;
const subscribers = new Set<() => void>();
const snapshot = () => markers;
function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    const current = ++generation;
    void listen<StimulusMarker>('matlab://event', event => {
      markers = [...markers.filter(x => x.eventId !== event.payload.eventId), event.payload].slice(-128);
      for (const subscriber of subscribers) subscriber();
    }).then(unlisten => { if (current !== generation) unlisten(); else cleanup = unlisten; }).catch(() => undefined);
  }
  return () => { subscribers.delete(callback); if (subscribers.size === 0) { generation++; cleanup?.(); cleanup = undefined; } };
}
export function useStimulusMarkers() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
