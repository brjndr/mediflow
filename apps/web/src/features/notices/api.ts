import { api, requireData } from '@/shared/api';
import { noticePageSchema, noticeSchema } from './schemas';
import type { Notice, NoticePage } from './types';

export async function fetchNotices(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<NoticePage> {
  const result = await api.GET('/notices', { params: { query: { cursor, limit } }, signal });
  return noticePageSchema.parse(requireData(result));
}

export async function archiveNotice(noticeId: string): Promise<Notice> {
  const result = await api.POST('/notices/{noticeId}/archive', { params: { path: { noticeId } } });
  return noticeSchema.parse(requireData(result));
}
