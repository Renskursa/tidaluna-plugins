import { LunaUnload } from "@luna/core";
import { MediaItem, TidalApi, redux, observe } from "@luna/lib";

export { Settings } from "./Settings";
import { storage } from "./Settings";

export const unloads = new Set<LunaUnload>();

const trackVideoMappings = new Map<number, { trackId: number; videoId: number }>();
const failedMappings = new Set<string>();
const inflight = new Map<string, Promise<{ trackId: number; videoId: number } | undefined>>();
const pendingSeeks = new Map<number, number>();

function pruneCache<K, V>(cache: Map<K, V>) {
    if (cache.size > 1000) {
        const entries = Array.from(cache.entries()).slice(-500);
        cache.clear();
        for (const [key, value] of entries) cache.set(key, value);
    }
}

function pruneSet<T>(set: Set<T>) {
    if (set.size > 1000) {
        const entries = Array.from(set).slice(-500);
        set.clear();
        for (const item of entries) set.add(item);
    }
}

async function findFirstExistingId(items: any[], type: "track" | "video", originalTitle?: string): Promise<number | undefined> {
    if (type === "track" && originalTitle) {
        const normalizedOriginal = normalizeTitle(originalTitle);
        const candidates: { id: number; score: number }[] = [];
        for (const item of items) {
            const title = String(item.title ?? "");
            const score = scoreTitleMatch(normalizedOriginal, title);
            candidates.push({ id: item.id, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        for (const { id } of candidates) {
            if (await MediaItem.fromId(id, type)) return id;
        }
    } else {
        for (const item of items) {
            if (await MediaItem.fromId(item.id, type)) return item.id;
        }
    }
    return undefined;
}

export function clearCaches() {
    trackVideoMappings.clear();
    failedMappings.clear();
    inflight.clear();
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
    for (const el of document.querySelectorAll('li.play-mv-tab')) el.remove();
    clearCaches();
});

async function findTrackVideoMapping(title: string, artist: string): Promise<{ trackId: number; videoId: number } | undefined> {
    const searchKey = `${artist.toLowerCase()} - ${title.toLowerCase()}`;
    if (failedMappings.has(searchKey)) return undefined;
    if (inflight.has(searchKey)) return inflight.get(searchKey);
    
    const p = (async () => {
        const query = `${title} ${artist}`.trim();
        const headers = await TidalApi.getAuthHeaders();
        const [trackRes, videoRes] = await Promise.all([
            fetch(`https://desktop.tidal.com/v1/search?query=${encodeURIComponent(query)}&types=TRACKS&limit=10&${TidalApi.queryArgs()}`, { headers }),
            fetch(`https://desktop.tidal.com/v1/search?query=${encodeURIComponent(query)}&types=VIDEOS&limit=10&${TidalApi.queryArgs()}`, { headers })
        ]);
        
        if (!trackRes.ok || !videoRes.ok) return undefined;
        
        const [trackJson, videoJson] = await Promise.all([trackRes.json(), videoRes.json()]);
        const tracks: any[] = trackJson?.tracks?.items ?? [];
        const videos: any[] = videoJson?.videos?.items ?? [];
        
        const trackId = await findFirstExistingId(tracks, "track", title);
        const videoId = await findBestMatchingVideoId(videos, title);
        
        if (trackId && videoId) {
            const mapping = { trackId, videoId };
            trackVideoMappings.set(trackId, mapping);
            trackVideoMappings.set(videoId, mapping);
            pruneCache(trackVideoMappings);
            return mapping;
        }
        
        failedMappings.add(searchKey);
        pruneSet(failedMappings);
        return undefined;
    })();
    
    inflight.set(searchKey, p);
    return await p.finally(() => inflight.delete(searchKey));
}

async function resolveMapping(media: MediaItem): Promise<{ trackId: number; videoId: number } | undefined> {
    const cached = trackVideoMappings.get(media.id as number);
    if (cached) return cached;
    
    const title = media.tidalItem?.title ?? (await media.title());
    const artist = (await media.artist())?.name ?? "";
    return findTrackVideoMapping(title, artist);
}

async function replaceCurrentWithMediaItem(targetId: number, type: "track" | "video", startAt?: number) {
    await MediaItem.fromId(targetId, type);
    const state = redux.store.getState() as any;
    const pq = state?.playQueue;
    const currentIndex = pq?.currentIndex ?? -1;
    const currentElem = pq?.elements?.[currentIndex];
    const context = currentElem?.context ?? { type: "active" };
    if (startAt !== undefined) pendingSeeks.set(targetId, startAt);

    if (!pq || currentIndex < 0 || !currentElem) {
        await redux.actions["playQueue/ADD_NOW"]({ context: { type: "active" }, mediaItemIds: [targetId] });
        await redux.actions["playbackControls/PLAY"]();
        return;
    }

    const oldUid = currentElem?.uid;
    await redux.actions["playQueue/ADD_AT_INDEX"]({ context, mediaItemIds: [targetId], index: currentIndex + 1 });
    await redux.actions["playQueue/MOVE_TO"](currentIndex + 1);
    await redux.actions["playbackControls/PLAY"]();
    if (oldUid) await redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: oldUid });
}

MediaItem.onMediaTransition(unloads, async (media) => {
    if (media.contentType === "track" || media.contentType === "video") void resolveMapping(media);
    const pending = pendingSeeks.get(media.id as number);
    if (pending !== undefined) {
        setTimeout(() => {
            redux.actions["playbackControls/SEEK"](pending);
        }, 150);
        pendingSeeks.delete(media.id as number);
    }
    void updateTabEntryLabel();
});

async function onNowPlayingButtonClick() {
    const { item: current, type } = await getCurrentMedia();
    if (!current) return;

    const effectiveType = getEffectiveType(current, type);
    const mapping = await resolveMapping(current);
    if (effectiveType === 'track') {
        const vid = mapping?.videoId;
        if (vid) {
            const seek = storage.seekOnSwitch ? getCurrentSeekSeconds() : undefined;
            await replaceCurrentWithMediaItem(vid, "video", seek);
        }
    } else if (effectiveType === 'video') {
        const tid = mapping?.trackId;
        if (tid) {
            const seek = storage.seekOnSwitch ? getCurrentSeekSeconds() : undefined;
            await replaceCurrentWithMediaItem(tid, "track", seek);
        }
    }
}

observe(unloads, 'li[data-test="tabs-play-queue"]', (queueLi: HTMLLIElement) => {
    const ul = queueLi.closest('ul[role="tablist"]') as HTMLUListElement | null;
    if (!ul) return;
    void ensureOrUpdateTabEntry(ul);
});

async function ensureOrUpdateTabEntry(ul: HTMLUListElement) {
    let li = ul.querySelector<HTMLLIElement>('li.play-mv-tab');
    if (!li) {
        const template = ul.querySelector<HTMLLIElement>('li._tabItem_8436610') || ul.querySelector('li');
        if (!template) return;
        li = template.cloneNode(true) as HTMLLIElement;
        li.classList.add('play-mv-tab');
        li.setAttribute('data-test', 'tabs-mv-toggle');
        li.setAttribute('aria-selected', 'false');
        li.setAttribute('aria-disabled', 'false');
        li.tabIndex = 0;
        li.id = 'tab:mv-toggle';
        li.setAttribute('aria-controls', 'panel:mv-toggle');
        resetTabSelectionState(li);
        li.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void onNowPlayingButtonClick();
        };
        let svg = li.querySelector('svg');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.classList.add('_icon_77f3f89');
            li.prepend(svg);
        }
        svg.innerHTML = '';
        let span = li.querySelector('span.wave-text-description-demi');
        if (!span) {
            span = document.createElement('span');
            span.classList.add('wave-text-description-demi');
            li.appendChild(span);
        }
        ul.appendChild(li);
    }
    resetTabSelectionState(li);
    await updateTabEntryLabel();
}

async function updateTabEntryLabel() {
    const { item: current, type } = await getCurrentMedia();
    const li = document.querySelector<HTMLLIElement>('ul[role="tablist"] li.play-mv-tab');
    if (!li) return;

    const svg = li.querySelector('svg');
    const label = li.querySelector('span.wave-text-description-demi') as HTMLSpanElement | null;

    resetTabSelectionState(li);
    const effectiveType = getEffectiveType(current, type);

    if (!current || !effectiveType) {
        li.style.display = 'none';
        return;
    }

    const mapping = await resolveMapping(current);
    if (effectiveType === 'track') {
        const vid = mapping?.videoId;
        if (!vid) {
            li.style.display = 'none';
            return;
        }
        li.style.display = '';
        if (svg) svg.innerHTML = '<path d="M17 10.5V7c0-1.1-.9-2-2-2H4C2.9 5 2 5.9 2 7v10c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z"/>';
        if (label) label.textContent = 'Music Video';
    } else if (effectiveType === 'video') {
        const tid = mapping?.trackId;
        if (!tid) {
            li.style.display = 'none';
            return;
        }
        li.style.display = '';
        if (svg) svg.innerHTML = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
        if (label) label.textContent = 'Track';
    } else {
        li.style.display = 'none';
    }
}

function resetTabSelectionState(li: HTMLLIElement) {
    li.setAttribute('aria-selected', 'false');
    for (const c of Array.from(li.classList)) {
        if (c.includes('activeTab') || c.includes('react-tabs__tab--selected')) li.classList.remove(c);
    }
}

function getEffectiveType(current?: MediaItem, fallback?: 'track' | 'video') {
    const storeType = current ? getMediaTypeById(current.id) : undefined;
    return (storeType ?? fallback ?? current?.contentType) as 'track' | 'video' | undefined;
}

async function findBestMatchingVideoId(items: any[], originalTitle: string): Promise<number | undefined> {
    const normalizedOriginal = normalizeTitle(originalTitle);
    const candidates: { id: number; score: number }[] = [];
    for (const item of items) {
        const title = String(item.title ?? "");
        const score = scoreTitleMatch(normalizedOriginal, title);
        candidates.push({ id: item.id, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const { id } of candidates) {
        if (await MediaItem.fromId(id, "video")) return id;
    }
    return undefined;
}

function normalizeTitle(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreTitleMatch(normalizedOriginal: string, candidateTitle: string): number {
    const t = normalizeTitle(candidateTitle);
    if (t === normalizedOriginal) return 1000;

    let score = 0;
    if (t.startsWith(normalizedOriginal)) score += 200;
    if (t.includes(normalizedOriginal)) score += 100;
    
    const positiveKeywords = ["official music video", "music video", "official video", "official mv", "mv"];
    for (const kw of positiveKeywords) {
        if (t.includes(kw)) score += 80;
    }

    const penaltyKeywords = ["behind the scenes", "bts", "interview", "making of", "live", "remix", "teaser", "trailer", "snippet", "shorts", "reaction", "fan", "cover", "dance", "lyrics"];
    const bracketContent = t.match(/[[(](.*?)[\])]/g) || [];
    for (const kw of penaltyKeywords) {
        if (t.includes(kw)) score -= 50;
    }
    if (bracketContent.length > 0) score -= 20 * bracketContent.length;
    score -= Math.min(50, Math.max(0, t.length - normalizedOriginal.length));
    return score;
}

async function getCurrentMedia(): Promise<{ item?: MediaItem; type?: "track" | "video" }> {
    const controls = redux.store.getState().playbackControls;
    const ctx = controls?.playbackContext;
    if (ctx?.actualProductId !== undefined) {
        const storeType = getMediaTypeById(ctx.actualProductId);
        const inferredType = storeType || (ctx.actualVideoQuality === null ? 'track' : 'video');
        const item = await MediaItem.fromId(ctx.actualProductId, inferredType);
        return { item, type: inferredType };
    }
    const mp = controls?.mediaProduct;
    const productType = mp?.productType === 'video' ? 'video' : mp?.productType === 'track' ? 'track' : undefined;
    if (mp?.productId !== undefined && productType) {
        const item = await MediaItem.fromId(mp.productId, productType);
        return { item, type: productType };
    }
    return {};
}

function getMediaTypeById(id: number | string): "track" | "video" | undefined {
    const media = (redux.store.getState().content?.mediaItems ?? {})[String(id)] as any;
    return media?.type;
}