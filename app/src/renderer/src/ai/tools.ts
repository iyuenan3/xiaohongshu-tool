// 11 个小红书 MCP 工具的 OpenAI function calling schema + HTTP API 路径映射。
//
// schema 直接对齐 Go 端 mcp_server.go 的 jsonschema 注解;
// path 对齐 Go 端 routes.go 的 /api/v1/* HTTP endpoint。

import type OpenAI from 'openai';

export type ToolName =
  | 'check_login_status'
  | 'list_feeds'
  | 'search_feeds'
  | 'get_feed_detail'
  | 'user_profile'
  | 'my_profile'
  | 'post_comment_to_feed'
  | 'reply_comment_in_feed'
  | 'like_feed'
  | 'favorite_feed'
  | 'publish_content'
  | 'publish_with_video'
  | 'search_local_assets';

interface ToolBinding {
  schema: OpenAI.Chat.Completions.ChatCompletionTool;
  /** Go 端 HTTP 调用映射. null = 本地处理 (renderer 直接走 IPC) */
  http: { method: 'GET' | 'POST'; path: string } | null;
  /** 是否敏感操作 (需用户确认) */
  sensitive: boolean;
}

export const TOOLS: Record<ToolName, ToolBinding> = {
  check_login_status: {
    schema: {
      type: 'function',
      function: {
        name: 'check_login_status',
        description: '检查当前小红书账号是否已登录, 操作前必先调用',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    http: { method: 'GET', path: '/api/v1/login/status' },
    sensitive: false,
  },
  list_feeds: {
    schema: {
      type: 'function',
      function: {
        name: 'list_feeds',
        description: '获取小红书首页推荐 Feed 列表 (含 feed_id 和 xsec_token, 后续工具会用到)',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    http: { method: 'GET', path: '/api/v1/feeds/list' },
    sensitive: false,
  },
  search_feeds: {
    schema: {
      type: 'function',
      function: {
        name: 'search_feeds',
        description: '按关键词搜索小红书笔记',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键词' },
            filters: {
              type: 'object',
              description: '可选筛选',
              properties: {
                sort_by: { type: 'string', enum: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'] },
                note_type: { type: 'string', enum: ['不限', '视频', '图文'] },
                publish_time: { type: 'string', enum: ['不限', '一天内', '一周内', '半年内'] },
              },
            },
          },
          required: ['keyword'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/search' },
    sensitive: false,
  },
  get_feed_detail: {
    schema: {
      type: 'function',
      function: {
        name: 'get_feed_detail',
        description: '获取笔记详情 (包含正文、图片、评论等)',
        parameters: {
          type: 'object',
          properties: {
            feed_id: { type: 'string', description: '笔记 ID, 从 list_feeds/search_feeds 获取' },
            xsec_token: { type: 'string', description: '访问令牌, 从 list_feeds/search_feeds 获取' },
            load_all_comments: { type: 'boolean', description: '是否加载全部评论' },
          },
          required: ['feed_id', 'xsec_token'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/detail' },
    sensitive: false,
  },
  user_profile: {
    schema: {
      type: 'function',
      function: {
        name: 'user_profile',
        description: '获取指定用户的主页信息',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string' },
            xsec_token: { type: 'string' },
          },
          required: ['user_id', 'xsec_token'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/user/profile' },
    sensitive: false,
  },
  my_profile: {
    schema: {
      type: 'function',
      function: {
        name: 'my_profile',
        description: '获取当前登录用户的主页信息',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    http: { method: 'GET', path: '/api/v1/user/me' },
    sensitive: false,
  },
  post_comment_to_feed: {
    schema: {
      type: 'function',
      function: {
        name: 'post_comment_to_feed',
        description: '在笔记下发表评论',
        parameters: {
          type: 'object',
          properties: {
            feed_id: { type: 'string' },
            xsec_token: { type: 'string' },
            content: { type: 'string', description: '评论内容' },
          },
          required: ['feed_id', 'xsec_token', 'content'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/comment' },
    sensitive: true,
  },
  reply_comment_in_feed: {
    schema: {
      type: 'function',
      function: {
        name: 'reply_comment_in_feed',
        description: '回复笔记下的某条评论',
        parameters: {
          type: 'object',
          properties: {
            feed_id: { type: 'string' },
            xsec_token: { type: 'string' },
            comment_id: { type: 'string', description: '目标评论 ID (二选一)' },
            user_id: { type: 'string', description: '目标用户 ID (二选一)' },
            content: { type: 'string' },
          },
          required: ['feed_id', 'xsec_token', 'content'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/comment/reply' },
    sensitive: true,
  },
  like_feed: {
    schema: {
      type: 'function',
      function: {
        name: 'like_feed',
        description: '点赞或取消点赞笔记',
        parameters: {
          type: 'object',
          properties: {
            feed_id: { type: 'string' },
            xsec_token: { type: 'string' },
            unlike: { type: 'boolean', description: 'true 取消点赞, false 点赞' },
          },
          required: ['feed_id', 'xsec_token'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/like' },
    sensitive: true,
  },
  favorite_feed: {
    schema: {
      type: 'function',
      function: {
        name: 'favorite_feed',
        description: '收藏或取消收藏笔记',
        parameters: {
          type: 'object',
          properties: {
            feed_id: { type: 'string' },
            xsec_token: { type: 'string' },
            unfavorite: { type: 'boolean' },
          },
          required: ['feed_id', 'xsec_token'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/feeds/favorite' },
    sensitive: true,
  },
  publish_content: {
    schema: {
      type: 'function',
      function: {
        name: 'publish_content',
        description: '发布图文笔记到小红书',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '标题 (≤20 字)' },
            content: { type: 'string', description: '正文, 不含 # 标签' },
            images: {
              type: 'array',
              items: { type: 'string' },
              description: '图片 URL 或本地绝对路径列表 (至少 1 张)',
            },
            tags: { type: 'array', items: { type: 'string' }, description: '标签列表 (不带 #)' },
            schedule_at: { type: 'string', description: 'ISO8601 定时发布时间 (可选)' },
          },
          required: ['title', 'content', 'images'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/publish' },
    sensitive: true,
  },
  publish_with_video: {
    schema: {
      type: 'function',
      function: {
        name: 'publish_with_video',
        description: '发布视频笔记到小红书 (仅本地文件)',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            video: { type: 'string', description: '本地视频绝对路径' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'content', 'video'],
        },
      },
    },
    http: { method: 'POST', path: '/api/v1/publish_video' },
    sensitive: true,
  },
  search_local_assets: {
    schema: {
      type: 'function',
      function: {
        name: 'search_local_assets',
        description:
          '在本地图片素材库中搜索, 返回匹配的图片 (含本地绝对路径). 用户已经预先上传图片到素材库, 每张图都有 tag 和描述. 想发布图文笔记但用户没明确给图片路径时, 用此工具按关键词找候选, 选合适的把 storage_path 填进 publish_content.images.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词, 匹配图片的 tag/描述/文件名 (中文), 例如 "猫" / "户外" / "咖啡"',
            },
            limit: {
              type: 'integer',
              description: '返回数量上限, 默认 10',
            },
          },
          required: ['query'],
        },
      },
    },
    http: null,
    sensitive: false,
  },
};

export const ALL_TOOL_SCHEMAS: OpenAI.Chat.Completions.ChatCompletionTool[] = Object.values(
  TOOLS,
).map((t) => t.schema);

export function isSensitive(name: string): boolean {
  return TOOLS[name as ToolName]?.sensitive ?? false;
}

export function getHttpBinding(name: string): { method: 'GET' | 'POST'; path: string } | null {
  return TOOLS[name as ToolName]?.http ?? null;
}

export function isLocalTool(name: string): boolean {
  const t = TOOLS[name as ToolName];
  return !!t && t.http === null;
}

export function isRegisteredTool(name: string): boolean {
  return name in TOOLS;
}
