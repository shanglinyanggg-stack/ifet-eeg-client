import type {
  SleepMusicCategory,
  SleepMusicCover,
  SleepMusicTrack
} from './settings';

export async function pickAudioTracks(): Promise<SleepMusicTrack[]> {
  if (isTauriRuntime()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({
        multiple: true,
        directory: false,
        filters: [{
          name: 'Audio',
          extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg']
        }]
      });
      const paths = Array.isArray(result) ? result : result ? [result] : [];
      return paths.map(trackFromPath);
    } catch {
      return [];
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.flac';
    input.multiple = true;
    input.style.display = 'none';
    const finish = () => {
      const tracks = Array.from(input.files ?? []).map((file) => ({
        id: createTrackId(`${file.name}:${file.size}:${file.lastModified}`),
        name: stripExtension(file.name),
        path: URL.createObjectURL(file)
      }));
      input.remove();
      resolve(tracks);
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export function mergeAudioTracks(
  existingTracks: SleepMusicTrack[],
  pickedTracks: SleepMusicTrack[],
  limit = 120
): SleepMusicTrack[] {
  const tracks = new Map(existingTracks.map((track) => [track.path, track]));
  for (const track of pickedTracks) tracks.set(track.path, track);
  return Array.from(tracks.values()).slice(0, limit);
}

export function revokeAudioTrack(track: SleepMusicTrack | undefined): void {
  if (track?.path.startsWith('blob:')) URL.revokeObjectURL(track.path);
}

function trackFromPath(path: string): SleepMusicTrack {
  const normalized = path.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1) || 'Sleep music';
  return {
    id: createTrackId(path),
    name: stripExtension(fileName),
    path,
    category: classifyTrackCategory(fileName),
    cover: resolveTrackCover(fileName),
    source: 'local'
  };
}

export function classifyTrackCategory(name: string): SleepMusicCategory {
  const normalized = name.toLowerCase();
  if (/alpha|beta|delta|theta|brain|binaural|脑波|脑电|双耳/.test(normalized)) return 'brainwave';
  if (/rain|storm|noise|white|pink|brown|雨|白噪|粉噪|棕噪/.test(normalized)) return 'white-noise';
  if (/meditat|breath|yoga|zen|mindful|冥想|呼吸|正念/.test(normalized)) return 'meditation';
  if (/ocean|wave|forest|bird|river|wind|sea|nature|海|潮|森林|鸟|溪|风|自然/.test(normalized)) return 'nature';
  return 'other';
}

export function resolveTrackCover(name: string): SleepMusicCover {
  const normalized = name.toLowerCase();
  if (/ocean|wave|sea|海|潮/.test(normalized)) return 'ocean';
  if (/forest|bird|river|森林|鸟|溪/.test(normalized)) return 'forest';
  if (/rain|storm|noise|white|pink|brown|雨|噪/.test(normalized)) return 'rain';
  if (/meditat|breath|yoga|zen|mindful|冥想|呼吸|正念/.test(normalized)) return 'dawn';
  return 'stars';
}

function createTrackId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `track-${(hash >>> 0).toString(36)}`;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
