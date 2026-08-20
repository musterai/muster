import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { config } from '../src/config/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import { canonicalCardWebUrl, withCardPageWebUrls, withCardWebUrl } from '../src/mcp/card-links.js';
import type { Page } from '../src/shared/pagination.js';
import type { Card } from '../src/shared/types.js';
import type { Services } from '../src/shared/services.js';

const originalPublicUrl = config.oidc.publicUrl;

const card = {
  id: 'card-id',
  key: 'MUS-84',
} as Card;

afterEach(() => {
  config.oidc.publicUrl = originalPublicUrl;
});

describe('MCP linked card references', () => {
  it('adds the canonical deployment URL to card results and pages', () => {
    config.oidc.publicUrl = 'https://muster.example.test';

    expect(canonicalCardWebUrl(card.key)).toBe('https://muster.example.test/cards/MUS-84');
    expect(withCardWebUrl(card).web_url).toBe('https://muster.example.test/cards/MUS-84');

    const page = {
      items: [card],
      page: { limit: 50, has_more: false, next_cursor: null },
    } satisfies Page<Card>;
    expect(withCardPageWebUrls(page).items[0].web_url).toBe('https://muster.example.test/cards/MUS-84');
  });

  it('advertises the linked-key rule during initialization and in the collaboration prompt', async () => {
    config.oidc.publicUrl = 'https://muster.example.test';
    const server = createMcpServer({} as Services);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'linked-card-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getInstructions()).toContain('[MUS-84](https://muster.example.test/cards/MUS-84)');
      expect(client.getInstructions()).toContain('Never present a bare card key');

      const prompt = await client.getPrompt({ name: 'collaboration_protocol', arguments: {} });
      const text = prompt.messages[0].content.type === 'text'
        ? prompt.messages[0].content.text
        : '';
      expect(text).toContain('[MUS-84](https://muster.example.test/cards/MUS-84)');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('includes web_url in the get_card tool result', async () => {
    config.oidc.publicUrl = 'https://muster.example.test';
    const server = createMcpServer({
      cardService: { getById: async () => card },
    } as Services) as any;

    const result = await server._registeredTools.get_card.handler({ card_id: card.key }, {});
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      key: 'MUS-84',
      web_url: 'https://muster.example.test/cards/MUS-84',
    });
  });

  it('includes web_url on cards nested in get_board results', async () => {
    config.oidc.publicUrl = 'https://muster.example.test';
    const server = createMcpServer({
      boardService: { getById: async () => ({ id: 'board-id' }) },
      columnService: { list: async () => [] },
      cardService: {
        listPage: async () => ({
          items: [card],
          page: { limit: 50, has_more: false, next_cursor: null },
        }),
      },
    } as Services) as any;

    const result = await server._registeredTools.get_board.handler({ board_id: 'board-id' }, {});
    expect(JSON.parse(result.content[0].text).cards[0]).toMatchObject({
      key: 'MUS-84',
      web_url: 'https://muster.example.test/cards/MUS-84',
    });
  });
});
