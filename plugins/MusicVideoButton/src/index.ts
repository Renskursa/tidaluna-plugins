import { LunaUnload } from "@luna/core";
import { ContextMenu, MediaItem, TidalApi, redux, observe } from "@luna/lib";

export { Settings } from "./Settings";

export const unloads = new Set<LunaUnload>();

const trackVideoMappings = new Map<number, { trackId: number; videoId: number }>();
const failedMappings = new Set<string>();
const inflight = new Map<string, Promise<{ trackId: number; videoId: number } | undefined>>();

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

export function clearCaches() {
    trackVideoMappings.clear();
    failedMappings.clear();
    inflight.clear();
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
        
        let trackId: number | undefined;
        for (const item of tracks) {
            if (await MediaItem.fromId(item.id, "track")) {
                trackId = item.id;
                break;
            }
        }
        
        let videoId: number | undefined;
        for (const item of videos) {
            if (await MediaItem.fromId(item.id, "video")) {
                videoId = item.id;
                break;
            }
        }
        
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

async function resolveVideoId(media: MediaItem): Promise<number | undefined> {
    const cached = trackVideoMappings.get(media.id as number);
    if (cached) return cached.videoId;
    
    const title = media.tidalItem?.title ?? (await media.title());
    const artist = (await media.artist())?.name ?? "";
    return (await findTrackVideoMapping(title, artist))?.videoId;
}

async function resolveTrackId(media: MediaItem): Promise<number | undefined> {
    const cached = trackVideoMappings.get(media.id as number);
    if (cached) return cached.trackId;
    
    const title = media.tidalItem?.title ?? (await media.title());
    const artist = (await media.artist())?.name ?? "";
    return (await findTrackVideoMapping(title, artist))?.trackId;
}

async function replaceCurrentWithMediaItem(targetId: number, type: "track" | "video") {
    await MediaItem.fromId(targetId, type);
    const state = redux.store.getState() as any;
    const pq = state?.playQueue;
    const currentIndex = pq?.currentIndex ?? -1;
    const currentElem = pq?.elements?.[currentIndex];
    const context = currentElem?.context ?? { type: "active" };

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

ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
    for await (const media of await mediaCollection.mediaItems()) {
        if (media.contentType === "track") {
            const vid = await resolveVideoId(media);
            if (vid) contextMenu.addButton("Play Music Video", () => replaceCurrentWithMediaItem(vid, "video"));
        } else if (media.contentType === "video") {
            const tid = await resolveTrackId(media);
            if (tid) contextMenu.addButton("Play Track", () => replaceCurrentWithMediaItem(tid, "track"));
        }
    }
});

MediaItem.onMediaTransition(unloads, async (media) => {
    if (media.contentType === "track") void resolveVideoId(media);
    else if (media.contentType === "video") void resolveTrackId(media);
    void updateTabEntryLabel();
});

async function onNowPlayingButtonClick() {
    const { item: current, type } = await getCurrentMedia();
    if (!current) return;

    const storeType = getMediaTypeById(current.id);
    const effectiveType = (storeType ?? type ?? current.contentType) as 'track' | 'video' | undefined;

    if (effectiveType === 'track') {
        const vid = await resolveVideoId(current);
        if (vid) await replaceCurrentWithMediaItem(vid, "video");
    } else if (effectiveType === 'video') {
        const tid = await resolveTrackId(current);
        if (tid) await replaceCurrentWithMediaItem(tid, "track");
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
        for (const c of Array.from(li.classList)) {
            if (c.includes('activeTab') || c.includes('react-tabs__tab--selected')) li.classList.remove(c);
        }
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
    li.setAttribute('aria-selected', 'false');
    for (const c of Array.from(li.classList)) {
        if (c.includes('activeTab') || c.includes('react-tabs__tab--selected')) li.classList.remove(c);
    }
    await updateTabEntryLabel();
}

async function updateTabEntryLabel() {
    const { item: current, type } = await getCurrentMedia();
    const li = document.querySelector<HTMLLIElement>('ul[role="tablist"] li.play-mv-tab');
    if (!li) return;

    const svg = li.querySelector('svg');
    const label = li.querySelector('span.wave-text-description-demi') as HTMLSpanElement | null;

    li.setAttribute('aria-selected', 'false');
    for (const c of Array.from(li.classList)) {
        if (c.includes('activeTab') || c.includes('react-tabs__tab--selected')) li.classList.remove(c);
    }

    const storeType = current ? getMediaTypeById(current.id) : undefined;
    const effectiveType = (storeType ?? type ?? current?.contentType) as 'track' | 'video' | undefined;

    if (!current || !effectiveType) {
        li.style.display = 'none';
        return;
    }

    if (effectiveType === 'track') {
        const vid = await resolveVideoId(current);
        if (!vid) {
            li.style.display = 'none';
            return;
        }
        li.style.display = '';
        if (svg) setVideoCameraIcon(svg);
        if (label) label.textContent = 'Music Video';
    } else if (effectiveType === 'video') {
        const tid = await resolveTrackId(current);
        if (!tid) {
            li.style.display = 'none';
            return;
        }
        li.style.display = '';
        if (svg) setMusicNoteIcon(svg);
        if (label) label.textContent = 'Track';
    } else {
        li.style.display = 'none';
    }
}

function setVideoCameraIcon(svg: SVGElement) {
    svg.innerHTML = '<path d="M17 10.5V7c0-1.1-.9-2-2-2H4C2.9 5 2 5.9 2 7v10c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z"/>';
}

function setMusicNoteIcon(svg: SVGElement) {
    svg.innerHTML = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
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