import { MediaItem, redux } from "@luna/lib";

const MATCH_WORDS = {
    OFFICIAL: ["official music video", "official video", "official mv"],
    VIDEO: ["music video", "mv", "video"],
    QUALITY: ["hd", "4k", "uhd"],
    REJECT: ["lyrics", "lyric video", "behind the scenes", "bts", "interview", "making of", "teaser", "trailer", "snippet", "shorts", "reaction", "fan", "cover", "dance"],
    VERSIONS: ["remix", "mix", "edit", "vip", "mashup", "version", "acoustic", "live", "instrumental", "slowed", "reverb", "remaster", "remastered", "extended", "radio", "club", "karaoke"]
};

export function pruneCache<K, V>(cache: Map<K, V>, maxSize = 1000, keepSize = 500) {
    if (cache.size > maxSize) {
        const entries = Array.from(cache.entries()).slice(-keepSize);
        cache.clear();
        entries.forEach(([k, v]) => cache.set(k, v));
    }
}

export function pruneSet<T>(set: Set<T>, maxSize = 1000, keepSize = 500) {
    if (set.size > maxSize) {
        const entries = Array.from(set).slice(-keepSize);
        set.clear();
        entries.forEach(item => set.add(item));
    }
}

export function getCurrentSeekSeconds(): number {
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

export function getMediaTypeById(id: number | string): "track" | "video" | undefined {
    const media = (redux.store.getState().content?.mediaItems ?? {})[String(id)] as any;
    return media?.type;
}

export function getEffectiveType(current?: MediaItem, fallback?: 'track' | 'video') {
    const storeType = current ? getMediaTypeById(current.id) : undefined;
    return (storeType ?? fallback ?? current?.contentType) as 'track' | 'video' | undefined;
}

export function normalizeTitle(s: string): string {
    return s.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
            .replace(/['"`,.?!\u2018\u2019\u201C\u201D]/g, "") 
            .replace(/\s+/g, " ")
            .trim();
}
export function getBaseString(s: string): string {
    const stripped = s.replace(/[\(\[\{].*?[\)\]\}]/g, '')
            .replace(/[-–—:|~*].*$/, '')
            .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
            
    return stripped.length < 3 ? s.replace(/\s+/g, ' ').trim() : stripped;
}

export function scoreTitleMatch(normalizedOriginal: string, candidateTitle: string): number {
    const t = normalizeTitle(candidateTitle);
    
    if (MATCH_WORDS.REJECT.some(kw => t.includes(kw))) {
        return 0;
    }

    for (const kw of MATCH_WORDS.VERSIONS) {
        const regex = new RegExp(`\\b${kw}\\b`);
        const originalHas = regex.test(normalizedOriginal);
        const candidateHas = regex.test(t);
        
        if (originalHas !== candidateHas) {
            return 0;
        }
    }

    const baseOriginal = getBaseString(normalizedOriginal);
    const baseCandidate = getBaseString(t);

    if (!baseCandidate.includes(baseOriginal) && !baseOriginal.includes(baseCandidate)) {
        return 0; 
    }

    if (t.includes(normalizedOriginal)) {
        if (!hasStrictBoundary(t, normalizedOriginal)) return 0;
        
        if (MATCH_WORDS.OFFICIAL.some(kw => t.includes(kw))) return 1000; 
        if (MATCH_WORDS.VIDEO.some(kw => t.includes(kw))) return 800;
        if (MATCH_WORDS.QUALITY.some(kw => t.includes(kw))) return 600;
        if (t === normalizedOriginal) return 500;
        return 100; // Minimal score for general inclusion
    }
    
    const cleanOrig = normalizedOriginal.replace(/[^a-z0-9]/g, '');
    const cleanCand = t.replace(/[^a-z0-9]/g, '');
    if (cleanCand.includes(cleanOrig)) return 80;

    const wordsOrig = normalizedOriginal.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const wordsCand = t.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    
    let overlap = 0;
    for (const w of wordsOrig) {
        if (wordsCand.includes(w)) overlap++;
    }
    
    if (wordsOrig.length > 0 && overlap / wordsOrig.length >= 0.8) {
        return 50;
    }

    return 0;
}

export function hasStrictBoundary(title: string, normalizedOriginal: string): boolean {
    const idx = title.indexOf(normalizedOriginal);
    if (idx < 0) return false;
    
    let after = title.slice(idx + normalizedOriginal.length).trim();
    if (after.length === 0) return true;
    
    after = after.replace(/^[-–—:|•~*.,'"\s]+/, "").trim();
    if (after.length === 0) return true;

    const allowed = [
        ...MATCH_WORDS.OFFICIAL,
        ...MATCH_WORDS.VIDEO,
        ...MATCH_WORDS.QUALITY
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

export function extractSongName(title: string): string {
    let cleaned = title.replace(/[[(](.*?)[\])]/g, (match, content) => {
        const normalizedContent = content.toLowerCase().trim();
        const allKeywords = [...MATCH_WORDS.OFFICIAL, ...MATCH_WORDS.VIDEO, ...MATCH_WORDS.QUALITY, ...MATCH_WORDS.REJECT];
        
        if (allKeywords.some(kw => normalizedContent.includes(kw))) {
            return "";
        }
        return match;
    }).trim();
    
    // Remove trailing suffixes not in brackets
    const suffixes = [...MATCH_WORDS.OFFICIAL, ...MATCH_WORDS.VIDEO, ...MATCH_WORDS.QUALITY];
    let lowerCleaned = cleaned.toLowerCase();
    
    for (const suffix of suffixes) {
        if (lowerCleaned.endsWith(suffix)) {
            cleaned = cleaned.substring(0, cleaned.length - suffix.length).trim();
            lowerCleaned = cleaned.toLowerCase();
        }
    }
    
    // Remove "feat" and trailing separators
    cleaned = cleaned.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "").trim();
    cleaned = cleaned.replace(/[-–—:|~*]+\s*$/, "").trim();
    
    return cleaned;
}