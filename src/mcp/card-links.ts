import { config } from '../config/index.js';
import { cardWebUrl } from '../shared/card-url.js';
import type { Page } from '../shared/pagination.js';
import type { Card } from '../shared/types.js';

export function canonicalCardWebUrl(cardReference: string): string {
  return cardWebUrl(config.oidc.publicUrl, cardReference);
}

export function withCardWebUrl<T extends Pick<Card, 'key'>>(card: T): T & { web_url: string } {
  return { ...card, web_url: canonicalCardWebUrl(card.key) };
}

export function withCardPageWebUrls<T extends Pick<Card, 'key'>>(page: Page<T>): Page<T & { web_url: string }> {
  return { ...page, items: page.items.map(withCardWebUrl) };
}

export function cardLinkInstructions(): string {
  const exampleUrl = canonicalCardWebUrl('MUS-84');
  return `Muster web origin: ${config.oidc.publicUrl}. `
    + `Whenever Markdown is supported, every human-readable card key must be a link, for example [MUS-84](${exampleUrl}). `
    + 'Never present a bare card key such as MUS-84 in user-facing prose, comments, documents, or progress reports. '
    + 'Use each card result\'s web_url field as the link target; keep ULIDs for tool calls and use the human-readable key as link text.';
}
