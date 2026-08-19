// @vitest-environment jsdom
// File: tests/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/web/markdown.js';

/**
 * Document, card and comment bodies are writable by any MCP client, so these
 * payloads represent what a hostile agent can put in front of the operator.
 */
describe('renderMarkdown sanitization', () => {
  const attacks: Array<[string, string]> = [
    ['inline script tag', '<script>window.__pwned = 1</script>'],
    ['img onerror handler', '<img src=x onerror="window.__pwned=1">'],
    ['svg onload handler', '<svg onload="window.__pwned=1"></svg>'],
    ['body onload via markup', '<body onload="window.__pwned=1">'],
    ['iframe with javascript src', '<iframe src="javascript:window.__pwned=1"></iframe>'],
    ['javascript: link', '[click me](javascript:window.__pwned=1)'],
    ['form action', '<form action="https://evil.test"><button>Go</button></form>'],
    ['object embed', '<object data="https://evil.test/x.swf"></object>'],
    ['style tag', '<style>body { display: none }</style>'],
    ['details ontoggle', '<details open ontoggle="window.__pwned=1"></details>'],
    ['case-varied handler', '<img src=x OnErRoR="window.__pwned=1">'],
    ['nested markdown image with handler', '![alt](x" onerror="window.__pwned=1)'],
  ];

  const FORBIDDEN = 'script, iframe, object, embed, form, input, button, style, svg, link, meta';

  // Assertions run against the parsed DOM, not the HTML string. A payload that
  // isn't valid markdown comes back as escaped *text* — `<p>... onerror=...</p>`
  // — which is inert but would trip a naive string match on `on\w+=`. What
  // matters is whether an element actually carries the handler.
  it.each(attacks)('neutralizes: %s', (_name, payload) => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(payload);

    expect(host.querySelector(FORBIDDEN)).toBeNull();

    for (const el of host.querySelectorAll('*')) {
      const handlers = [...el.attributes].filter((a) => a.name.toLowerCase().startsWith('on'));
      expect(handlers.map((a) => a.name)).toEqual([]);

      for (const attr of ['href', 'src', 'action', 'formaction', 'data']) {
        const value = el.getAttribute(attr);
        if (value) expect(value.toLowerCase().replace(/\s/g, '')).not.toContain('javascript:');
      }
    }
  });

  it('does not execute a script payload once attached to the DOM', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('<img src=x onerror="window.__pwned = 1">');
    document.body.appendChild(host);

    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(host.querySelector('[onerror]')).toBeNull();
  });

  const dataUriAttacks: Array<[string, string]> = [
    ['img data:text/html script', '<img src="data:text/html,<script>window.__pwned=1</script>">'],
    ['a data:text/html link', '[click](data:text/html,<script>window.__pwned=1</script>)'],
    ['object data URI', '<object data="data:text/html,<script>window.__pwned=1</script>"></object>'],
    ['embed data URI', '<embed src="data:text/html,<script>window.__pwned=1</script>">'],
    ['iframe data URI', '<iframe src="data:text/html,<script>window.__pwned=1</script>"></iframe>'],
    ['video data URI', '<video src="data:text/html,<script>window.__pwned=1</script>"></video>'],
    ['source data URI', '<source src="data:text/html,<script>window.__pwned=1</script>">'],
    ['audio data URI', '<audio src="data:text/html,<script>window.__pwned=1</script>"></audio>'],
    ['form action data URI', '<form action="data:text/html,<script>window.__pwned=1</script>"><button>Go</button></form>'],
    ['button formaction data URI', '<button formaction="data:text/html,<script>window.__pwned=1</script>">Go</button>'],
    ['input image data URI', '<input type="image" src="data:text/html,<script>window.__pwned=1</script>">'],
    ['svg image data URI', '<image href="data:text/html,<script>window.__pwned=1</script>">'],
  ];

  it.each(dataUriAttacks)('neutralizes data: URI vector: %s', (_name, payload) => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(payload);

    // No element should carry a data: URI in any URL-bearing attribute.
    for (const el of host.querySelectorAll('*')) {
      for (const attr of ['href', 'src', 'action', 'formaction', 'data']) {
        const value = el.getAttribute(attr);
        if (value) {
          expect(value.trim().toLowerCase()).not.toMatch(/^data:/);
        }
      }
    }
  });

  it('does not execute a data: URI script payload once attached to the DOM', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('<img src="data:text/html,<script>window.__pwned=1</script>">');
    document.body.appendChild(host);

    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('neutralizes the detached-resource payload from GHSA-55q2-fjhq-7xh7', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(`
      <footer>
        <img
          src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          onload="window.__pwned = 1"
        >
      </footer>
      <div>safe</div>
    `);
    document.body.appendChild(host);

    expect(host.textContent).toContain('safe');
    expect(host.querySelector('[onload]')).toBeNull();
    expect(host.querySelector('img[src]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('preserves legitimate markdown structure', () => {
    const html = renderMarkdown(
      '# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```'
    );

    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('const x = 1;');
  });

  it('opens links detached from this window', () => {
    const html = renderMarkdown('[docs](https://example.test/page)');

    expect(html).toContain('href="https://example.test/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders the fallback only when content is empty', () => {
    expect(renderMarkdown('', 'No description provided.')).toContain('No description provided.');
    expect(renderMarkdown(null, 'No description provided.')).toContain('No description provided.');
    expect(renderMarkdown('   ', 'No description provided.')).toContain('No description provided.');
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown('real content', 'No description provided.')).toContain('real content');
  });
});
