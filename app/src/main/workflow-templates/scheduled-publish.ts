// scheduled_publish 模板: 定时发布笔记 (M7 P2).
// 图素材从 media_assets 表选, params 存 asset_id[] (跟 ChatPanel AttachmentPicker 一致).
// 视频发布走 publish_with_video, 图文走 publish_content.

import { getAssetPath } from '../assets';
import type { Template, ExecHelpers, ExecResult } from './index';

export const scheduledPublish: Template = {
  id: 'scheduled_publish',
  name: '定时发布笔记',
  emoji: '⏰',
  description: '在指定时间自动发布预先准备好的笔记. 图文用素材库选图, 视频填本机视频路径.',
  paramsSchema: {
    title: { type: 'string', default: '', label: '笔记标题' },
    content: { type: 'string', default: '', label: '正文 (支持多行)' },
    image_ids: { type: 'image_list', default: [], label: '图素材 (从素材库选, 最多 9 张)' },
    video_path: { type: 'string', default: '', label: '视频路径 (留空则发图文)' },
    cover_path: { type: 'string', default: '', label: '视频封面路径 (可选)' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const title = String(params.title ?? '').trim();
    const content = String(params.content ?? '').trim();
    const imageIds = Array.isArray(params.image_ids) ? (params.image_ids as string[]) : [];
    const videoPath = String(params.video_path ?? '').trim();
    const coverPath = String(params.cover_path ?? '').trim();

    if (!title) return { status: 'partial', summary: '⚠️ 标题为空, 跳过' };

    helpers.log({ step: 'start', result: { title, hasVideo: !!videoPath, imageCount: imageIds.length } });

    // 分支: 视频 vs 图文
    if (videoPath) {
      try {
        await helpers.callTool('publish_with_video', {
          title,
          content,
          video_path: videoPath,
          cover: coverPath || undefined,
        });
        helpers.log({ step: 'publish_with_video', result: { title } });
        return { status: 'success', summary: `✅ 视频笔记已发布: ${title}` };
      } catch (e) {
        const msg = (e as Error).message;
        helpers.log({ step: 'publish_with_video', error: msg });
        throw e;
      }
    }

    // 图文: 把 asset_id 解析成本地文件路径
    const imagePaths: string[] = [];
    for (const id of imageIds.slice(0, 9)) {
      const p = getAssetPath(id);
      if (p) imagePaths.push(p);
      else helpers.log({ step: 'resolve_asset', error: `asset_id=${id} not found` });
    }
    if (imagePaths.length === 0) {
      return { status: 'partial', summary: '⚠️ 没有可用图素材, 跳过 (请编辑工作流选图)' };
    }

    try {
      await helpers.callTool('publish_content', {
        title,
        content,
        images: imagePaths,
      });
      helpers.log({ step: 'publish_content', result: { title, count: imagePaths.length } });
      return { status: 'success', summary: `✅ 图文笔记已发布: ${title} (${imagePaths.length} 图)` };
    } catch (e) {
      const msg = (e as Error).message;
      helpers.log({ step: 'publish_content', error: msg });
      throw e;
    }
  },
};
