import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem, TidalApi, redux, observe } from "@luna/lib";

export { Settings } from "./Settings";

export const unloads = new Set<LunaUnload>();
const { trace, errSignal } = Tracer("[MusicVideoButton]");
export { errSignal };

const songToVideoMappings = new Map<number, { trackId: number; videoId: number }>();
const failedSearches = new Set<string>();
const ongoingSearches = new Map<string, Promise<{ trackId: number; videoId: number } | undefined>>();
const seekPositions = new Map<number, number>();

function pruneCache<K, V>(cache: Map<K, V>, maxSize = 1000, keepSize = 500) {
    if (cache.size > maxSize) {
        const entries = Array.from(cache.entries()).slice(-keepSize);
        cache.clear();
        entries.forEach(([k, v]) => cache.set(k, v));
    }
}

function pruneSet<T>(set: Set<T>, maxSize = 1000, keepSize = 500) {
    if (set.size > maxSize) {
        const entries = Array.from(set).slice(-keepSize);
        set.clear();
        entries.forEach(item => set.add(item));
    }
}

async function findBestMatchingId(items: any[], type: "track" | "video", originalTitle?: string): Promise<number | undefined> {
    if (!items?.length) return undefined;
    
    const normalizedOriginal = originalTitle ? normalizeTitle(originalTitle) : undefined;
    if (normalizedOriginal) {
        const candidates = items.map(item => ({
            id: item.id,
            score: scoreTitleMatch(normalizedOriginal, String(item.title ?? ""))
        })).sort((a, b) => b.score - a.score);
        
        for (const { id, score } of candidates.slice(0, 3)) {
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

function getCurrentSeekSeconds(): number {
    const state = redux.store.getState() as any;
    const pc = state?.playbackControls as any;
    if (!pc) return 0;
    const base = Number(pc.latestCurrentTime ?? 0);
    if (pc.playbackState === 'PLAYING' && typeof pc.latestCurrentTimeSyncTimestamp === 'number') {
        const elapsed = (Date.now() - pc.latestCurrentTimeSyncTimestamp) / 1000;
        const duration = Number(pc.playbackContext?.actualDuration ?? Infinity);
        return Math.max(0, Math.min(duration, base + elapsed));
    }
    return base;
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
        const title = media.tidalItem?.title ?? (await media.title());
        const artist = media.tidalItem?.artist?.name ?? (await media.artist())?.name ?? "";
        
        if (!title) return undefined;
        return findSongVideoPair(title, artist);
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
        
        const state = redux.store.getState() as any;
        const pq = state?.playQueue;
        const currentIndex = pq?.currentIndex ?? -1;
        const currentElem = pq?.elements?.[currentIndex];
        
        if (!pq || currentIndex < 0 || !currentElem) {
            await redux.actions["playQueue/ADD_NOW"]({ context: { type: "active" }, mediaItemIds: [targetId] });
            await redux.actions["playbackControls/PLAY"]();
            return;
        }
        
        const context = currentElem.context ?? { type: "active" };
        const oldUid = currentElem.uid;
        
        await redux.actions["playQueue/ADD_AT_INDEX"]({ context, mediaItemIds: [targetId], index: currentIndex + 1 });
        await redux.actions["playQueue/MOVE_TO"](currentIndex + 1);
        await redux.actions["playbackControls/PLAY"]();
        
        if (oldUid) {
            await redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: oldUid });
        }
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
        redux.actions["playbackControls/SEEK"](pending);
        seekPositions.delete(Number(media.id));
    }
    
    createOrUpdateTaskbarButton().catch(() => {});
});

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
observe(unloads, 'div._moreContainer_f6162c8', () => {
    createOrUpdateTaskbarButton().catch(() => {});
});

function getEffectiveType(current?: MediaItem, fallback?: 'track' | 'video') {
    const storeType = current ? getMediaTypeById(current.id) : undefined;
    return (storeType ?? fallback ?? current?.contentType) as 'track' | 'video' | undefined;
}

function normalizeTitle(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreTitleMatch(normalizedOriginal: string, candidateTitle: string): number {
    const t = normalizeTitle(candidateTitle);
    
    if (!t.includes(normalizedOriginal)) return 0;
    if (!hasStrictBoundary(t, normalizedOriginal)) return 0;
    
    const rejectKeywords = ["behind the scenes", "bts", "interview", "making of", "teaser", "trailer", "snippet", "shorts", "reaction", "fan", "cover", "dance", "lyrics"];
    for (const kw of rejectKeywords) {
        if (t.includes(kw)) return 0;
    }
    
    if (t === normalizedOriginal) return 1000;
    
    const officialKeywords = ["official music video", "official video", "music video", "official mv", "mv"];
    for (const kw of officialKeywords) {
        if (t.includes(kw)) return 900;
    }
    
    const songName = extractSongName(t);
    if (songName === normalizedOriginal) return 800;
    
    if (t.startsWith(normalizedOriginal + " ")) return 700;
    if (t.startsWith(normalizedOriginal)) return 600;
    
    if (t.includes(" " + normalizedOriginal + " ")) return 500;
    if (t.includes(normalizedOriginal)) return 400;
    
    return 0;
}

function hasStrictBoundary(title: string, normalizedOriginal: string): boolean {
    const idx = title.indexOf(normalizedOriginal);
    if (idx < 0) return false;
    let after = title.slice(idx + normalizedOriginal.length).trim();
    if (after.length === 0) return true;
    after = after.replace(/^[-–—:|•~*.,'"\s]+/, "").trim();
    if (after.length === 0) return true;
    const allowed = [
        "official music video",
        "official video",
        "music video",
        "official mv",
        "mv",
        "video",
        "hd",
        "4k",
        "uhd"
    ];
    if (after.startsWith("(") || after.startsWith("[")) {
        const m = after.match(/^[(\[]\s*([^\]\)]*?)\s*[)\]](.*)$/);
        if (!m) return false;
        const content = normalizeTitle(m[1]);
        if (!allowed.includes(content)) return false;
        const rest = m[2].replace(/^[-–—:|•~*.,'"\s]+/, "").trim();
        return rest.length === 0;
    }
    for (const suf of allowed) {
        if (after.startsWith(suf)) {
            const rest = after.slice(suf.length).replace(/^[-–—:|•~*.,'"\s]+/, "").trim();
            return rest.length === 0;
        }
    }
    return after.length <= 8;
}

function extractSongName(title: string): string {
    const suffixes = [
        "official music video",
        "music video", 
        "official video",
        "official mv",
        "mv",
        "official",
        "video"
    ];
    
    let cleaned = title;
    for (const suffix of suffixes) {
        if (cleaned.endsWith(suffix)) {
            cleaned = cleaned.substring(0, cleaned.length - suffix.length).trim();
        }
    }
    
    // Remove content in brackets/parentheses
    cleaned = cleaned.replace(/[[(].*?[\])]/g, "").trim();
    
    return cleaned;
}

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

function getMediaTypeById(id: number | string): "track" | "video" | undefined {
    const media = (redux.store.getState().content?.mediaItems ?? {})[String(id)] as any;
    return media?.type;
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
    
    const container = document.querySelector('div._moreContainer_f6162c8');
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
            svgContent: '<path d="M17 10.5V7c0-1.1-.9-2-2-2H4C2.9 5 2 5.9 2 7v10c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z"/>'
        };
    }
    if (effectiveType === 'video') {
        return {
            hasValidMapping: !!mapping?.trackId,
            svgContent: '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>'
        };
    }
    return { hasValidMapping: false, svgContent: '' };
}

function getOrCreateButton(container: Element): HTMLButtonElement {
    let button = container.querySelector('button.mv-taskbar-button') as HTMLButtonElement;
    if (button) return button;
    
    button = document.createElement('button');
    button.classList.add('mv-taskbar-button');
    button.type = 'button';
    button.style.cssText = 'background: none; border: none; padding: 0; margin: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;';
    button.addEventListener('click', onButtonClick);
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('_icon_77f3f89');
    svg.setAttribute('viewBox', '0 0 24 24');
    button.appendChild(svg);
    
    const lastButton = container.querySelector('button[data-test="mp-toggle-now-playing"]');
    if (lastButton) {
        container.insertBefore(button, lastButton);
    } else {
        container.appendChild(button);
    }
    
    return button;
}

function removeTaskbarButton() {
    document.querySelector('button.mv-taskbar-button')?.remove();
}
