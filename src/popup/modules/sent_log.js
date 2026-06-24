// Cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

/**
 * Sent Log
 * Remembers which article URLs have already been sent to the X4 so the popup can
 * warn before you re-send the same article. Stored in storage.local.
 */
const KEY = 'x4_sent';
const MAX_ENTRIES = 500;

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch (e) {
        return url;
    }
}

export const SentLog = {
    /** Return { date, title } if this URL was sent before, else null. */
    async find(url) {
        if (!url) return null;
        try {
            const store = await browserAPI.storage.local.get(KEY);
            const all = store[KEY] || {};
            return all[normalizeUrl(url)] || null;
        } catch (e) {
            console.warn('[SentLog] find failed:', e);
            return null;
        }
    },

    /** Record an article as sent (keeps the most recent MAX_ENTRIES). */
    async record(article) {
        if (!article || !article.sourceUrl) return;
        try {
            const store = await browserAPI.storage.local.get(KEY);
            const all = store[KEY] || {};
            all[normalizeUrl(article.sourceUrl)] = {
                date: new Date().toISOString().slice(0, 10),
                ts: Date.now(),
                title: article.title || ''
            };

            const keys = Object.keys(all);
            if (keys.length > MAX_ENTRIES) {
                keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
                for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
            }

            await browserAPI.storage.local.set({ [KEY]: all });
        } catch (e) {
            console.warn('[SentLog] record failed:', e);
        }
    }
};
