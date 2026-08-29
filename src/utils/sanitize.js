/**
 * Sanitization helpers for EPUB generation.
 * This file is used by both content scripts and the service worker.
 * Functions that need a DOM (cleanForEpub) fall back to the DOM-free path.
 */
const Sanitizer = {
    /**
     * Elements that must never reach the EPUB: they are unsupported by e-ink
     * readers, pull in remote resources, or are simply not content.
     */
    STRIPPED_ELEMENTS: [
        'script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'form',
        'input', 'button', 'select', 'textarea', 'video', 'audio', 'canvas',
        'noscript', 'template', 'link', 'meta', 'base', 'map', 'dialog'
    ],

    /**
     * Void elements that only exist to reference an external resource.
     * Images are disabled for X4 compatibility, and a remote <img> would make
     * the EPUB unreadable offline (and invalid: the file is not listed in the
     * OPF manifest), so these are dropped rather than self-closed.
     */
    DROPPED_VOID_ELEMENTS: ['img', 'source', 'track', 'area', 'param', 'picture'],

    /**
     * Void elements that are kept, and must be self-closed for XHTML.
     */
    KEPT_VOID_ELEMENTS: ['br', 'hr', 'col', 'wbr'],

    /**
     * Named HTML entities that are NOT predefined in XML. An EPUB content
     * document is parsed as XML, so an undefined entity is a fatal error and
     * the book fails to open. Everything here is mapped to a numeric
     * reference, which is always valid.
     */
    ENTITY_MAP: {
        nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165,
        brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171,
        not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177,
        sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
        cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189,
        frac34: 190, iquest: 191, times: 215, divide: 247,
        Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197,
        AElig: 198, Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203,
        Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209,
        Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, Oslash: 216,
        Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222,
        szlig: 223, agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228,
        aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233, ecirc: 234,
        euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240,
        ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246,
        oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253,
        thorn: 254, yuml: 255, OElig: 338, oelig: 339, Scaron: 352, scaron: 353,
        Yuml: 376, fnof: 402, circ: 710, tilde: 732,
        ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
        lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216,
        rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
        dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240,
        prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254,
        frasl: 8260, euro: 8364, trade: 8482, larr: 8592, uarr: 8593,
        rarr: 8594, darr: 8595, harr: 8596, minus: 8722, lowast: 8727,
        radic: 8730, infin: 8734, ne: 8800, le: 8804, ge: 8805,
        loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
        alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949,
        theta: 952, lambda: 955, mu: 956, pi: 960, sigma: 963, tau: 964,
        phi: 966, omega: 969, Omega: 937, Delta: 916, Sigma: 931, Pi: 928
    },

    /**
     * Attributes that are dropped from every element: event handlers, inline
     * styles, and anything that would make the reader reach for the network.
     */
    isDroppedAttribute(name) {
        const n = String(name).toLowerCase();
        return n.indexOf('on') === 0 ||
            n === 'style' ||
            n === 'src' ||
            n === 'srcset' ||
            n === 'background' ||
            n === 'poster' ||
            n.indexOf('data-') === 0 ||
            n.indexOf('aria-') === 0;
    },

    /**
     * Clean HTML for EPUB inclusion using the DOM when one is available.
     * Returns a well-formed XHTML fragment.
     * @param {string} html - Raw HTML string
     * @returns {string} - Clean XHTML string
     */
    cleanForEpub(html) {
        if (typeof document === 'undefined' || typeof XMLSerializer === 'undefined') {
            return this.xhtmlBody(html);
        }

        const temp = document.createElement('div');
        temp.innerHTML = html || '';

        const removeSelector = this.STRIPPED_ELEMENTS
            .concat(this.DROPPED_VOID_ELEMENTS)
            .join(',');
        temp.querySelectorAll(removeSelector).forEach(el => el.remove());

        temp.querySelectorAll('*').forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                if (this.isDroppedAttribute(attr.name)) {
                    el.removeAttribute(attr.name);
                }
            });
        });

        // XMLSerializer guarantees well-formed XML: void elements come out
        // self-closed, and characters such as U+00A0 are emitted literally
        // instead of as the (XML-undefined) &nbsp; entity.
        return new XMLSerializer().serializeToString(temp);
    },

    /**
     * Convert an HTML fragment into a well-formed XHTML fragment without a DOM
     * (service worker). This is the safety net for bodies that did not come
     * from cleanForEpub; it is idempotent, so running it over already
     * serialized XHTML leaves the markup unchanged.
     * @param {string} html
     * @returns {string}
     */
    xhtmlBody(html) {
        if (!html) return '';

        let out = String(html);

        // Comments and processing instructions: "--" and "?>" inside them are
        // fatal XML errors, and they carry no reading value.
        out = out.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
        out = out.replace(/<\?[\s\S]*?(?:\?>|$)/g, '');
        out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
        out = out.replace(/<!DOCTYPE[^>]*>/gi, '');

        // Drop non-content elements together with their contents.
        this.STRIPPED_ELEMENTS.forEach(tag => {
            out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
            out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, 'gi'), '');
        });

        // Drop elements that only point at an external resource.
        this.DROPPED_VOID_ELEMENTS.forEach(tag => {
            out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, 'gi'), '');
        });

        // Rewrite every remaining tag: quote bare attribute values, expand
        // boolean attributes, drop event handlers, self-close void elements.
        const tagPattern = /<\s*(\/?)\s*([a-zA-Z][\w:.-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+))?)*)\s*(\/?)\s*>/g;
        const pieces = [];
        let lastIndex = 0;
        let match;

        while ((match = tagPattern.exec(out)) !== null) {
            pieces.push(this.escapeTextNode(out.slice(lastIndex, match.index)));
            pieces.push(this.rewriteTag(match[1], match[2], match[3], match[4]));
            lastIndex = tagPattern.lastIndex;
        }
        pieces.push(this.escapeTextNode(out.slice(lastIndex)));

        // A stray "<" that did not parse as a tag would break the XML.
        return pieces.join('').replace(/<(?![a-zA-Z\/])/g, '&lt;');
    },

    /**
     * Rebuild a single tag as valid XHTML.
     */
    rewriteTag(closing, tagName, attrText, selfClosing) {
        const tag = tagName.toLowerCase();

        if (closing) return `</${tag}>`;

        const attrPattern = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+)))?/g;
        let attrs = '';
        let attrMatch;

        while ((attrMatch = attrPattern.exec(attrText || '')) !== null) {
            const name = attrMatch[1];
            if (this.isDroppedAttribute(name)) continue;
            if (!/^[a-zA-Z_:][\w:.-]*$/.test(name)) continue;

            const rawValue = attrMatch[2] !== undefined ? attrMatch[2]
                : attrMatch[3] !== undefined ? attrMatch[3]
                    : attrMatch[4] !== undefined ? attrMatch[4]
                        // Boolean attribute (e.g. <td nowrap>): illegal in XML.
                        : name;

            attrs += ` ${name}="${this.escapeAttributeValue(rawValue)}"`;
        }

        if (this.KEPT_VOID_ELEMENTS.indexOf(tag) !== -1 || selfClosing) {
            return `<${tag}${attrs} />`;
        }

        return `<${tag}${attrs}>`;
    },

    /**
     * Escape a text node: fix bare "&" and ">" and replace HTML named entities
     * (which XML does not define) with numeric references.
     */
    escapeTextNode(text) {
        if (!text) return '';
        return this.normalizeEntities(text).replace(/>/g, '&gt;');
    },

    escapeAttributeValue(value) {
        if (!value) return '';
        return this.normalizeEntities(value).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    },

    /**
     * Replace every "&" that is not part of an XML-legal reference, and map
     * HTML named entities onto numeric references.
     */
    normalizeEntities(text) {
        return String(text).replace(/&(#\d+;|#[xX][\da-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)?/g, (match, ref) => {
            if (!ref) return '&amp;';
            if (ref.charAt(0) === '#') return `&${ref}`;

            const name = ref.slice(0, -1);
            if (name === 'amp' || name === 'lt' || name === 'gt' || name === 'quot' || name === 'apos') {
                return `&${ref}`;
            }

            const code = this.ENTITY_MAP[name];
            if (code) return `&#${code};`;

            // Unknown named entity: keep the text, lose the (fatal) reference.
            return `&amp;${ref}`;
        });
    },

    /**
     * Convert HTML to XHTML.
     * @param {string} html
     * @returns {string}
     */
    toXhtml(html) {
        return this.xhtmlBody(html);
    },

    /**
     * Sanitize a single filename component.
     * The result is safe to hand to downloads.download(), which rejects the
     * whole request with "Invalid filename" when a component contains a path
     * separator, a reserved character, or a trailing dot or space.
     * @param {string} text
     * @param {number} maxLength
     * @returns {string}
     */
    sanitizeFilename(text, maxLength = 80) {
        if (!text) return '';
        return String(text)
            .replace(/[\u0000-\u001F\u007F]/g, ' ')      // control characters
            .replace(/[\/\\:*?"<>|]/g, '')              // reserved characters
            .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '') // emoji & symbols
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, maxLength)
            .replace(/^[.\s]+/, '')                     // no leading dot or space
            .replace(/[.\s]+$/, '')                     // no trailing dot or space
            .trim();
    },

    /**
     * Escape for XML/XHTML attributes and text
     * @param {string} text
     * @returns {string}
     */
    escapeXml(text) {
        if (!text) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }
};
