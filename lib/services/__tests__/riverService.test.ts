import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeRiverClusters } from '../riverService'
import type { Cluster } from '../../models/cluster'

const baseCluster: Cluster = {
  cluster_id: 1,
  lead_article_id: 101,
  lead_title: 'Lead article',
  lead_was_rewritten: false,
  lead_url: 'https://example.com/lead',
  lead_dek: null,
  lead_source: 'Example Source',
  lead_homepage: 'https://example.com',
  lead_author: 'Lead Author',
  published_at: '2024-05-01T00:00:00Z',
  size: 4,
  score: 10,
  sources_count: 3,
  subs: [],
  subs_total: 0,
  all_articles_by_source: {},
  lead_content_status: null,
  lead_content_word_count: null,
}

describe('normalizeRiverClusters', () => {
  it('deduplicates subs by source, keeps newest article, and sets counts', () => {
    const cluster: Cluster = {
      ...baseCluster,
      subs: [
        {
          article_id: 201,
          title: 'Bloomberg story 1',
          url: 'https://www.bloomberg.com/story-1',
          source: 'Bloomberg',
          author: 'Reporter 1',
          published_at: '2024-05-01T10:00:00Z',
        },
        {
          article_id: 202,
          title: 'Bloomberg story 2',
          url: 'https://www.bloomberg.com/story-2',
          source: 'Bloomberg',
          author: 'Reporter 2',
          published_at: '2024-05-01T12:00:00Z',
        },
        {
          article_id: 203,
          title: 'Reuters story 1',
          url: 'https://www.reuters.com/story-1',
          source: null,
          author: 'Reporter 3',
          published_at: '2024-05-01T09:00:00Z',
        },
        {
          article_id: 204,
          title: 'Reuters story 2',
          url: 'https://www.reuters.com/story-2',
          source: null,
          author: 'Reporter 4',
          published_at: '2024-05-01T11:00:00Z',
        },
      ],
      subs_total: 4,
      all_articles_by_source: {
        Bloomberg: [
          {
            article_id: 201,
            title: 'Bloomberg story 1',
            url: 'https://www.bloomberg.com/story-1',
            author: 'Reporter 1',
          },
          {
            article_id: 202,
            title: 'Bloomberg story 2',
            url: 'https://www.bloomberg.com/story-2',
            author: 'Reporter 2',
          },
        ],
        Reuters: [
          {
            article_id: 203,
            title: 'Reuters story 1',
            url: 'https://www.reuters.com/story-1',
            author: 'Reporter 3',
          },
          {
            article_id: 204,
            title: 'Reuters story 2',
            url: 'https://www.reuters.com/story-2',
            author: 'Reporter 4',
          },
        ],
      },
    }

    const [normalized] = normalizeRiverClusters([cluster])

    assert.equal(normalized.subs.length, 2)
    assert.equal(normalized.subs_total, 2)

    const bloomberg = normalized.subs.find((sub) => sub.source === 'Bloomberg')
    assert.ok(bloomberg)
    assert.equal(bloomberg!.article_id, 202)
    assert.equal(bloomberg!.article_count, 2)

    const reuters = normalized.subs.find((sub) =>
      (sub.source ?? '').includes('Reuters')
    )
    assert.ok(reuters)
    assert.equal(reuters!.article_id, 204)
    assert.equal(reuters!.article_count, 2)
  })
})
