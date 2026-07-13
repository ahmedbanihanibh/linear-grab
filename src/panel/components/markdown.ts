/**
 * Minimal, safe markdown → HTML for Linear comment bodies. Escape-first: the
 * whole input is entity-escaped, then ONLY our generated tags are introduced,
 * so arbitrary comment HTML can never execute. Covers what Linear
 * comments/agents actually produce: bold, inline code, code fences, links
 * (incl. `<url>`-wrapped and mailto), autolinks, images, lists, headings.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

/**
 * <lg-media>: Linear upload URLs carry NO file extension — image vs video is
 * only knowable from the response content-type. This element fetches once
 * (through the auth'd bridge proxy), sniffs the blob type, and renders the
 * right tag from an object URL.
 */
class LgMediaElement extends HTMLElement {
  private objectUrl: string | null = null;

  connectedCallback(): void {
    const src = this.getAttribute('src') ?? '';
    const alt = this.getAttribute('alt') ?? '';
    void (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        this.objectUrl = URL.createObjectURL(blob);
        this.textContent = '';
        if (blob.type.startsWith('video/')) {
          const v = document.createElement('video');
          v.controls = true;
          v.preload = 'metadata';
          v.src = this.objectUrl;
          this.appendChild(v);
        } else {
          const img = document.createElement('img');
          img.src = this.objectUrl;
          img.alt = alt;
          this.appendChild(img);
        }
      } catch {
        this.textContent = '';
        const note = document.createElement('span');
        note.textContent = `🖼 ${alt || 'media'} — start the bridge (npx linear-grab-bridge) to view Linear-hosted media here`;
        note.style.cssText = 'font-size:10.5px;color:var(--color-text-faint);';
        this.appendChild(note);
      }
    })();
  }

  disconnectedCallback(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
if (typeof customElements !== 'undefined' && !customElements.get('lg-media')) {
  customElements.define('lg-media', LgMediaElement);
}

/** uploads.linear.app media needs Linear auth — route through the bridge proxy. */
let mediaProxyBase: string | null = null;
export function setLinearMediaProxy(base: string | null): void {
  mediaProxyBase = base ? base.replace(/\/$/, '') : null;
}
function resolveMedia(url: string): string {
  try {
    if (mediaProxyBase && new URL(url).hostname.endsWith('uploads.linear.app')) {
      return `${mediaProxyBase}/fetch?url=${encodeURIComponent(url)}`;
    }
  } catch {
    /* keep original */
  }
  return url;
}

function inline(md: string): string {
  let out = md;

  // Inline code first — its contents must not be further transformed.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

  // Images/video: ![alt](url) — URL may be &lt;wrapped&gt;. Linear-hosted
  // media is proxied; video extensions get a real player.
  out = out.replace(
    /!\[([^\]]*)\]\((?:&lt;)?([^()\s]+?)(?:&gt;)?\)/g,
    (_m, alt: string, url: string) => {
      if (!SAFE_HREF.test(url)) return alt;
      const src = resolveMedia(url);
      if (VIDEO_EXT.test(url)) {
        return `<video controls preload="metadata" src="${src}"></video>`;
      }
      // Linear uploads have NO extension — type-sniff via <lg-media>.
      if (src !== url && !IMAGE_EXT.test(url)) {
        return `<lg-media src="${src}" alt="${alt}"></lg-media>`;
      }
      return `<img src="${src}" alt="${alt}" loading="lazy" />`;
    },
  );

  // Links: [text](url) — URL may be &lt;wrapped&gt;.
  out = out.replace(
    /\[([^\]]+)\]\((?:&lt;)?([^()\s]+?)(?:&gt;)?\)/g,
    (_m, text: string, url: string) =>
      SAFE_HREF.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text,
  );

  // Autolinks: <https://…> (escaped) and bare URLs.
  out = out.replace(
    /&lt;(https?:\/\/[^\s&]+)&gt;/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<>()"']+)/g,
    (_m, pre: string, url: string) =>
      `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );

  // Bold / italic.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');

  return out;
}

export function renderMarkdown(md: string): string {
  const src = esc(md.trim());
  const lines = src.split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Code fence
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(`<h4>${inline(heading[2])}</h4>`);
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph — consume until blank line / block start.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${inline(buf.join('<br />'))}</p>`);
  }

  return blocks.join('');
}
