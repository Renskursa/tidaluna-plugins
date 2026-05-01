import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem, TidalApi, redux, observe, PlayState } from "@luna/lib";
import { 
    pruneCache, 
    pruneSet, 
    getCurrentSeekSeconds, 
    getEffectiveType, 
    getMediaTypeById, 
    normalizeTitle, 
    scoreTitleMatch, 
    extractSongName 
} from "./utils";

export { Settings } from "./Settings";

export const unloads = new Set<LunaUnload>();
const { trace, errSignal } = Tracer("[MusicVideoButton]");
export { errSignal };

const songToVideoMappings = new Map<number, { trackId: number; videoId: number }>();
const failedSearches = new Set<string>();
const ongoingSearches = new Map<string, Promise<{ trackId: number; videoId: number } | undefined>>();
const seekPositions = new Map<number, number>();

async function findBestMatchingId(items: any[], type: "track" | "video", originalTitle?: string): Promise<number | undefined> {
    if (!items?.length) return undefined;
    
    const normalizedOriginal = originalTitle ? normalizeTitle(originalTitle) : undefined;
    if (normalizedOriginal) {
        const candidates = items.map(item => {
            const itemTitle = item.version ? `${item.title} (${item.version})` : (item.title ?? "");
            return {
                id: item.id,
                score: scoreTitleMatch(normalizedOriginal, String(itemTitle))
            };
        }).sort((a, b) => b.score - a.score); // 1000s will be at the top!
        
        for (const { id, score } of candidates) {
            if (score > 0) {
                try {
                    await MediaItem.fromId(id, type);
                    return id;
                } catch { /* Item not accessible */ }
            }
        }
        return undefined;
    }
    
    for (const item of items) {
        try {
            await MediaItem.fromId(item.id, type);
            return item.id;
        } catch { /* Item not accessible */ }
    }
    return undefined;
}

export function clearCaches() {
    songToVideoMappings.clear();
    failedSearches.clear();
    ongoingSearches.clear();
}

unloads.add(() => {
    for (const el of document.querySelectorAll('button.mv-taskbar-button')) el.remove();
    clearCaches();
});

async function findSongVideoPair(title: string, artist: string): Promise<{ trackId: number; videoId: number } | undefined> {
    const searchKey = `${artist.toLowerCase()} - ${title.toLowerCase()}`;
    if (failedSearches.has(searchKey)) return undefined;
    
    const existing = ongoingSearches.get(searchKey);
    if (existing) return existing;
    
    const searchPromise = performSearch(title, artist, searchKey);
    ongoingSearches.set(searchKey, searchPromise);
    
    return searchPromise.finally(() => ongoingSearches.delete(searchKey));
}

async function performSearch(title: string, artist: string, searchKey: string): Promise<{ trackId: number; videoId: number } | undefined> {
    try {
        const searchQuery = `${title} ${artist}`.trim();
        const headers = await TidalApi.getAuthHeaders();
        const baseUrl = 'https://desktop.tidal.com/v1/search';
        const commonParams = `query=${encodeURIComponent(searchQuery)}&limit=10&${TidalApi.queryArgs()}`;
        
        const [trackRes, videoRes] = await Promise.all([
            fetch(`${baseUrl}?${commonParams}&types=TRACKS`, { headers }),
            fetch(`${baseUrl}?${commonParams}&types=VIDEOS`, { headers })
        ]);
        
        if (!trackRes.ok || !videoRes.ok) {
            failedSearches.add(searchKey);
            return undefined;
        }
        
        const [trackData, videoData] = await Promise.all([trackRes.json(), videoRes.json()]);
        const [trackId, videoId] = await Promise.all([
            findBestMatchingId(trackData?.tracks?.items ?? [], "track", title),
            findBestMatchingId(videoData?.videos?.items ?? [], "video", title)
        ]);
        
        if (trackId && videoId) {
            const mapping = { trackId, videoId };
            songToVideoMappings.set(trackId, mapping);
            songToVideoMappings.set(videoId, mapping);
            pruneCache(songToVideoMappings);
            return mapping;
        }
        
        failedSearches.add(searchKey);
        pruneSet(failedSearches);
        return undefined;
    } catch {
        failedSearches.add(searchKey);
        pruneSet(failedSearches);
        return undefined;
    }
}

async function resolveMapping(media: MediaItem): Promise<{ trackId: number; videoId: number } | undefined> {
    const cached = songToVideoMappings.get(Number(media.id));
    if (cached) return cached;
    
    try {
        let rawTitle = media.tidalItem?.title;
        if (rawTitle && media.tidalItem?.version) {
            rawTitle += ` (${media.tidalItem.version})`;
        }
        if (!rawTitle) {
            rawTitle = await media.title();
        }
        
        const artist = media.tidalItem?.artist?.name ?? (await media.artist())?.name ?? "";
        
        if (!rawTitle) return undefined;
        
        const cleanTitle = extractSongName(rawTitle);
        
        return findSongVideoPair(cleanTitle, artist);
    } catch {
        return undefined;
    }
}

async function switchToMediaItem(targetId: number, type: "track" | "video", startAt?: number) {
    try {
        await MediaItem.fromId(targetId, type);
        
        if (startAt !== undefined) {
            seekPositions.set(targetId, startAt);
        }
        
        PlayState.playNext([targetId]); 
        
        const state = redux.store.getState() as any;
        const pq = state?.playQueue;
        const currentIndex = pq?.currentIndex ?? -1;
        
        if (currentIndex >= 0) {
            await redux.actions["playQueue/MOVE_TO"](currentIndex + 1);
            
            const currentElem = pq?.elements?.[currentIndex];
            if (currentElem?.uid) {
                await redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: currentElem.uid });
            }
        }
        
        PlayState.play();
        
    } catch (err) {
        trace.err.withContext("Failed to switch media item")(err as any);
    }
}

MediaItem.onMediaTransition(unloads, async (media) => {
    if (media.contentType === "track" || media.contentType === "video") {
        resolveMapping(media).catch(() => {});
    }
    
    const pending = seekPositions.get(Number(media.id));
    if (pending !== undefined) {
        seekPositions.delete(Number(media.id));
        
        if (media.contentType === "video") {
                await waitUntilSeekable();
        }
        
        PlayState.seek(pending);
    }
    
    createOrUpdateTaskbarButton().catch(() => {});
});

function waitUntilSeekable(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
        const start = Date.now();

        const check = () => {
            if (Date.now() - start >= timeoutMs) return resolve();

            const currentPos = getCurrentSeekSeconds();
            const state = redux.store.getState() as any;
            const pc = state?.playbackControls;
            const duration = Number(pc?.playbackContext?.actualDuration ?? 0);
            const playbackState = pc?.playbackState;

            if (
                (playbackState === 'PLAYING' || playbackState === 'PAUSED') &&
                duration > 0 &&
                currentPos < 1.0
            ) {
                return resolve();
            }

            requestAnimationFrame(check);
        };

        setTimeout(() => requestAnimationFrame(check), 300);
    });
}

async function onButtonClick() {
    const { storage } = await import("./Settings");
    const { item: current, type } = await getCurrentMedia();
    if (!current) return;
    
    const effectiveType = getEffectiveType(current, type);
    const mapping = await resolveMapping(current);
    if (!mapping) return;
    
    const seekPosition = storage.seekOnSwitch ? getCurrentSeekSeconds() : undefined;
    
    if (effectiveType === 'track' && mapping.videoId) {
        await switchToMediaItem(mapping.videoId, "video", seekPosition);
    } else if (effectiveType === 'video' && mapping.trackId) {
        await switchToMediaItem(mapping.trackId, "track", seekPosition);
    }
}

// Monitor taskbar container
observe(unloads, 'div._utilityButtons_4d7aaf9', () => {
    createOrUpdateTaskbarButton().catch(() => {});
});

async function getCurrentMedia(): Promise<{ item?: MediaItem; type?: "track" | "video" }> {
    try {
        const controls = redux.store.getState().playbackControls;
        const ctx = controls?.playbackContext;
        
        if (ctx?.actualProductId !== undefined) {
            const storeType = getMediaTypeById(ctx.actualProductId);
            const inferredType = storeType || (ctx.actualVideoQuality === null ? 'track' : 'video');
            const item = await MediaItem.fromId(ctx.actualProductId, inferredType);
            return { item, type: inferredType };
        }
        
        const mp = controls?.mediaProduct;
        if (mp?.productId !== undefined && mp?.productType) {
            const productType = mp.productType === 'video' ? 'video' : 'track';
            const item = await MediaItem.fromId(mp.productId, productType);
            return { item, type: productType };
        }
    } catch { /* Media item not accessible */ }
    
    return {};
}

async function createOrUpdateTaskbarButton() {
    const { item: current, type } = await getCurrentMedia();
    const effectiveType = getEffectiveType(current, type);
    
    if (!current || !effectiveType) {
        removeTaskbarButton();
        return;
    }
    
    const mapping = await resolveMapping(current);
    const { hasValidMapping, svgContent } = getButtonConfig(effectiveType, mapping);
    
    if (!hasValidMapping) {
        removeTaskbarButton();
        return;
    }
    
    const container = document.querySelector('div._utilityButtons_4d7aaf9');
    if (!container) {
        removeTaskbarButton();
        return;
    }
    
    const button = getOrCreateButton(container);
    const svg = button.querySelector('svg');
    if (svg) {
        svg.innerHTML = svgContent;
    }
}

function getButtonConfig(effectiveType: string, mapping?: { trackId: number; videoId: number }) {
    if (effectiveType === 'track') {
        return {
            hasValidMapping: !!mapping?.videoId,
            svgContent: '<path d="M 4 6 H 14 A 2 2 0 0 1 16 8 V 9 L 22 6 V 18 L 16 15 V 16 A 2 2 0 0 1 14 18 H 4 A 2 2 0 0 1 2 16 V 8 A 2 2 0 0 1 4 6 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
        };
    }
    if (effectiveType === 'video') {
        return {
            hasValidMapping: !!mapping?.trackId,
            svgContent: '<path d="M 8.5 17 A 2.5 2.5 0 0 1 3.5 17 A 2.5 2.5 0 0 1 8.5 17 V 5 L 18.5 3 V 15 A 2.5 2.5 0 0 1 13.5 15 A 2.5 2.5 0 0 1 18.5 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
        };
    }
    return { hasValidMapping: false, svgContent: '' };
}

function getOrCreateButton(container: Element): HTMLButtonElement {
    let button = container.querySelector('button.mv-taskbar-button') as HTMLButtonElement;
    if (button) return button;
    
    button = document.createElement('button');
    button.classList.add('mv-taskbar-button', 'withBackground');
    button.type = 'button';
    button.style.cssText = 'background: none; border: none; padding: 0; margin: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;';
    button.addEventListener('click', onButtonClick);
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('_icon_77f3f89');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.transform = 'scale(1.2)'; 
    
    button.appendChild(svg);
    
    const targetElement = container.querySelector('._sliderContainer_da74942');
    if (targetElement) {
        container.insertBefore(button, targetElement);
    } else {
        container.appendChild(button);
    }
    
    return button;
}

function removeTaskbarButton() {
    document.querySelector('button.mv-taskbar-button')?.remove();
}