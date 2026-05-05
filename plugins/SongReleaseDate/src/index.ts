import { LunaUnload } from "@luna/core";
import { MediaItem, observe, redux } from "@luna/lib";
import { storage } from "./Settings";
import { store as obyStore } from "oby";

export { Settings } from "./Settings";
export const unloads = new Set<LunaUnload>();

const releaseDateCache = new Map<string, string>();
let currentReleaseDate = "";
let lastId = "";
let fetchSeq = 0;

const VALID_TOKENS = ["YYYY", "MM", "DD", "M", "D"];

function formatDate(dateStr: string, format: string) {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (isNaN(date.getTime()) || !dateStr.includes("-")) return dateStr;
    if (!VALID_TOKENS.some(t => format.includes(t))) return dateStr;

    return format
        .replace("YYYY", date.getUTCFullYear().toString())
        .replace("MM", (date.getUTCMonth() + 1).toString().padStart(2, "0"))
        .replace("DD", date.getUTCDate().toString().padStart(2, "0"))
        .replace("M", (date.getUTCMonth() + 1).toString())
        .replace("D", date.getUTCDate().toString())
        .replace(/[A-Za-z]+/g, "")
        .replace(/[^0-9\/\-\.\s]/g, "")
        .replace(/[\/\-\.\s]{2,}/g, m => m[0])
        .replace(/^[\/\-\.\s]+|[\/\-\.\s]+$/g, "");
}
const updateNodes = () =>
    document.querySelectorAll(".luna-release-date").forEach(el => {
        el.textContent = currentReleaseDate;
    });

const prefetch = (radius = 10) => {
    try {
        const pq = (redux.store.getState() as any).playQueue;
        if (!pq?.elements || typeof pq.currentIndex !== "number") return;

        for (let i = -radius; i <= radius; i++) {
            if (i === 0) continue;
            const el = pq.elements[pq.currentIndex + i];
            if (!el?.mediaItemId) continue;
            const id = String(el.mediaItemId);
            if (releaseDateCache.has(id)) continue;
            MediaItem.fromId(el.mediaItemId, "track")
                .then(item => item?.releaseDateStr())
                .then(date => { if (date) releaseDateCache.set(id, date); })
                .catch(() => {});
        }
    } catch { }
};

const applyId = async (id: string, reformat = false) => {
    const seq = ++fetchSeq;

    if (releaseDateCache.has(id)) {
        currentReleaseDate = formatDate(releaseDateCache.get(id)!, storage.dateFormat);
        updateNodes();
        prefetch();
        return;
    }

    if (!reformat) {
        currentReleaseDate = "";
        updateNodes();
    }

    const item = await MediaItem.fromId(id, "track");
    if (seq !== fetchSeq) return;

    const rawDate = (await item?.releaseDateStr()) ?? "";
    if (seq !== fetchSeq) return;

    if (rawDate) releaseDateCache.set(id, rawDate);
    currentReleaseDate = formatDate(rawDate, storage.dateFormat);
    updateNodes();
    prefetch();
};

const getIdFromContainer = (container: Element) =>
    container.querySelector('a[href^="/track/"]')?.getAttribute("href")?.split("/").pop();

unloads.add(obyStore.on(storage, () => {
    if (!lastId) return;
    document.querySelectorAll(".luna-release-date").forEach(el => el.remove());
    applyId(lastId, true);
}));

document.querySelectorAll(".luna-release-date").forEach(el => el.remove());
unloads.add(() => document.querySelectorAll(".luna-release-date").forEach(el => el.remove()));

// Prefetch immediately on load with a large radius
prefetch(20);

const getAnchor = (container: Element) => {
    switch (storage.position) {
        case "below-artist":
            return {
                el: container.parentElement?.querySelector('[data-test="footer-artist-name"]') ?? container,
                pos: "afterend" as InsertPosition
            };
        default: // below-title
            return { el: container, pos: "afterend" as InsertPosition };
    }
};

observe(unloads, '[data-test="footer-track-title"]', (container) => {
    if (container.parentElement?.querySelector(".luna-release-date")) return;

    const span = document.createElement("span");
    span.className = "luna-release-date";
    span.style.cssText = "display: block; color: var(--text-secondary, #919496); font-size: 0.75rem; font-family: inherit; margin: -2px 0;";
    span.textContent = currentReleaseDate;

    const { el, pos } = getAnchor(container);
    el.insertAdjacentElement(pos, span);

    const titleObserver = new MutationObserver(() => {
        const id = getIdFromContainer(container);
        if (id) { lastId = id; applyId(id); }
    });
    titleObserver.observe(container, { characterData: true, childList: true, subtree: true });
    unloads.add(() => titleObserver.disconnect());

    const id = getIdFromContainer(container);
    if (id) { lastId = id; applyId(id); }
});