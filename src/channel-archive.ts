import { ChannelType } from 'discord.js';

export interface ArchiveCategoryLike {
  id: string;
  name: string;
  type: ChannelType;
}

export function buildArchivedChannelName(sessionName: string): string {
  return `archive-${sessionName}`;
}

export function findArchiveCategory(
  channels: Iterable<ArchiveCategoryLike | null | undefined>
): ArchiveCategoryLike | null {
  for (const channel of channels) {
    if (channel?.name === 'Archive' && channel.type === ChannelType.GuildCategory) {
      return channel;
    }
  }
  return null;
}
