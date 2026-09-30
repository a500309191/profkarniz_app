import { createHash } from 'node:crypto';
import type { Attachment } from '../telegram/normalize.js';

const supported = new Set(['photo', 'document', 'video', 'voice', 'audio', 'animation', 'video_note']);
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export interface DiscoveredAttachment { index: number; attachment: Attachment }

export function discoverAttachments(attachments: Attachment[]): DiscoveredAttachment[] {
  const candidates = attachments.map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment: a }) => supported.has(a.type) && a.file_id.length > 0 &&
      (a.type === 'photo' ? /^photo\.\d+$/.test(a.path) : a.path === a.type));
  const photos = candidates.filter(item => item.attachment.type === 'photo').sort((a, b) => {
    const area = (item: DiscoveredAttachment) => number(item.attachment.metadata.width) * number(item.attachment.metadata.height);
    return area(b) - area(a) || number(b.attachment.metadata.file_size) - number(a.attachment.metadata.file_size) || a.index - b.index;
  });
  const animations = new Set(candidates.filter(item => item.attachment.type === 'animation')
    .map(item => item.attachment.file_unique_id ?? item.attachment.file_id));
  return candidates.filter(item => (item.attachment.type !== 'photo' || item.index === photos[0]?.index) &&
    !(item.attachment.type === 'document' && animations.has(item.attachment.file_unique_id ?? item.attachment.file_id)));
}

const mimeExtensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/wav': 'wav', 'application/zip': 'zip', 'image/gif': 'gif'
};
export function extension(filename: string | null, mime: string | null): string {
  const basename = filename?.split(/[\\/]/).at(-1) ?? '';
  const suffix = /\.([a-zA-Z0-9]{1,10})$/.exec(basename)?.[1];
  if (suffix) return suffix.toLowerCase();
  const fromMime = mimeExtensions[mime?.split(';')[0]?.trim().toLowerCase() ?? ''];
  return fromMime ?? 'bin';
}

export function objectKey(input: {
  botId: string; chatId: string; messageId: string; eventId: string; date: Date;
  index: number; fileUniqueId: string | null; fileId: string; ext: string;
}): string {
  for (const id of [input.botId, input.chatId, input.messageId, input.eventId]) {
    if (!/^-?\d+$/.test(id)) throw new Error('INVALID_MEDIA_ID');
  }
  if (!Number.isSafeInteger(input.index) || input.index < 0 || !/^[a-z0-9]{1,10}$/.test(input.ext)) throw new Error('INVALID_MEDIA_KEY');
  const identity = input.fileUniqueId ?? input.fileId;
  const safeIdentity = input.fileUniqueId && /^[A-Za-z0-9_-]{1,120}$/.test(identity)
    ? identity : createHash('sha256').update(identity).digest('hex');
  const year = input.date.getUTCFullYear();
  const month = String(input.date.getUTCMonth() + 1).padStart(2, '0');
  // eventId prevents collisions across edits and business message namespaces.
  return `telegram/${input.botId}/${input.chatId}/${year}/${month}/${input.messageId}/events/${input.eventId}/${input.index}-${safeIdentity}.${input.ext}`;
}
