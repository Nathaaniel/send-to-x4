/**
 * EPUB Templates
 * Standard templates for EPUB structure
 */
const EpubTemplates = {
  /**
   * Generate mimetype file content
   */
  mimetype: 'application/epub+zip',

  /**
   * Generate container.xml
   */
  containerXml: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,

  /**
   * Generate content.opf
   * @param {Object} metadata - { title, author, date, uuid, coverMediaType }
   */
  contentOpf(metadata) {
    const { title, author, date, uuid, coverMediaType } = metadata;
    const creatorLine = author
      ? `    <dc:creator>${this.escapeXml(author)}</dc:creator>`
      : '';
    const dateLine = date
      ? `    <dc:date>${this.escapeXml(date)}</dc:date>`
      : '';

    // Cover metadata
    const coverMeta = coverMediaType
      ? `    <meta name="cover" content="cover-image" />`
      : '';

    const coverItem = coverMediaType
      ? `    <item id="cover-image" href="images/cover.jpg" media-type="${coverMediaType}" properties="cover-image"/>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${this.escapeXml(title)}</dc:title>
${creatorLine}
${dateLine}
${coverMeta}
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
${coverItem}
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`;
  },

  /**
   * Generate toc.ncx
   * @param {Object} metadata - { title, uuid }
   */
  tocNcx(metadata) {
    const { title, uuid } = metadata;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${this.escapeXml(title)}</text>
  </docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel>
        <text>${this.escapeXml(title)}</text>
      </navLabel>
      <content src="content.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;
  },

  /**
   * Generate content.xhtml for longpost
   * @param {Object} data - { title, author, date, body, url }
   */
  contentXhtml(data) {
    const { title, author, date, body } = data;
    // The extractors expose the article URL as `sourceUrl`; older callers used `url`.
    const url = data.url || data.sourceUrl;

    // Build metadata line: @handle • date • Source: url
    const metaParts = [];
    if (author) metaParts.push(this.escapeXml(author));
    if (date) metaParts.push(this.escapeXml(date));
    if (url) metaParts.push(`<a href="${this.escapeXml(url)}">Source</a>`);
    const metaLine = metaParts.length > 0
      ? `<p class="meta">${metaParts.join(' • ')}</p>`
      : '';

    // Turn the extracted HTML into well-formed XHTML. An EPUB content document
    // is parsed as XML, so anything the parser rejects (an HTML named entity, a
    // boolean attribute, an unclosed void element) makes the whole book
    // unopenable.
    const xhtmlBody = this.htmlToXhtml(body);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>
  <title>${this.escapeXml(title)}</title>
  <style type="text/css">
    body {
      margin: 1.5em;
      line-height: 1.7;
      font-family: Georgia, "Times New Roman", serif;
    }
    h1 {
      font-size: 1.5em;
      margin-bottom: 0.3em;
      line-height: 1.3;
    }
    .meta {
      color: #666;
      font-size: 0.85em;
      margin-bottom: 1.5em;
      padding-bottom: 1em;
      border-bottom: 1px solid #ddd;
    }
    .meta a {
      color: #666;
    }
    p {
      margin: 0.9em 0;
      text-align: left;
    }
    blockquote {
      margin: 1em 1.5em;
      padding-left: 1em;
      border-left: 3px solid #ccc;
      font-style: italic;
    }
    .tweet {
      border-bottom: 1px solid #ccc;
      padding: 0.6em 0;
    }
  </style>
</head>
<body>
  <h1>${this.escapeXml(title)}</h1>
  ${metaLine}
  <div class="content">
    ${xhtmlBody}
  </div>
</body>
</html>`;
  },

  /**
   * Escape XML special characters
   * @param {string} text
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
  },

  /**
   * Convert an HTML fragment into a well-formed XHTML fragment.
   * Sanitizer does the real work (entities, boolean attributes, void elements,
   * remote resources); the inline fallback only self-closes void elements, for
   * the case where sanitize.js failed to load.
   * @param {string} html
   */
  htmlToXhtml(html) {
    if (!html) return '';

    if (typeof Sanitizer !== 'undefined' && typeof Sanitizer.xhtmlBody === 'function') {
      return Sanitizer.xhtmlBody(html);
    }

    console.warn('[EpubTemplates] Sanitizer unavailable, using minimal XHTML conversion');

    const voidElements = [
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr'
    ];

    const pattern = new RegExp(
      `<(${voidElements.join('|')})([^>]*?)(?<!/)>`,
      'gi'
    );

    return html.replace(pattern, '<$1$2 />');
  }
};
