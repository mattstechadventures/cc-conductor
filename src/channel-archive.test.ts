import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { buildArchivedChannelName, findArchiveCategory } from './channel-archive.js';

test('buildArchivedChannelName prefixes session names for archived channels', () => {
  assert.equal(buildArchivedChannelName('bookshelf'), 'archive-bookshelf');
});

test('findArchiveCategory returns the Archive category from fetched channels', () => {
  const category = findArchiveCategory([
    null,
    { id: 'text-1', name: 'bookshelf', type: ChannelType.GuildText },
    { id: 'cat-1', name: 'Archive', type: ChannelType.GuildCategory },
  ]);

  assert.deepEqual(category, {
    id: 'cat-1',
    name: 'Archive',
    type: ChannelType.GuildCategory,
  });
});

test('findArchiveCategory ignores non-category channels named Archive', () => {
  const category = findArchiveCategory([
    { id: 'text-archive', name: 'Archive', type: ChannelType.GuildText },
  ]);

  assert.equal(category, null);
});
