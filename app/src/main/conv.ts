// 对话历史 + 消息持久化.

import { randomUUID } from 'crypto';
import { getDb } from './db';

export interface ConversationMeta {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export function listConversations(limit = 50): ConversationMeta[] {
  return getDb()
    .prepare(`SELECT id, title, created_at, updated_at FROM conversations
              ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as ConversationMeta[];
}

export function createConversation(): string {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)`)
    .run(id, now, now);
  return id;
}

export function getConversation(id: string): ConversationMeta | null {
  const row = getDb()
    .prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?`)
    .get(id) as ConversationMeta | undefined;
  return row ?? null;
}

export function getMessages(conversationId: string): StoredMessage[] {
  const rows = getDb()
    .prepare(`SELECT role, content, tool_calls, tool_call_id FROM messages
              WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
    }>;
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    tool_call_id: r.tool_call_id ?? undefined,
  }));
}

/**
 * 把整轮消息追加保存. caller 传入"自上次保存以来的新消息".
 * 简化版: 不做 upsert, 一律 INSERT (相同对话多次 saveMessages 会累积).
 *
 * 对于本项目, 调用方式是: 每轮 chat 结束, saveMessages 整段 newMessages.
 */
export function saveMessages(conversationId: string, messages: StoredMessage[]): void {
  const db = getDb();
  const now = Date.now();
  const insertStmt = db.prepare(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateConv = db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`);

  const txn = db.transaction((msgs: StoredMessage[]) => {
    for (const m of msgs) {
      insertStmt.run(
        conversationId,
        m.role,
        m.content,
        m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.tool_call_id ?? null,
        now,
      );
    }
    updateConv.run(now, conversationId);
  });
  txn(messages);
}

export function setConversationTitle(id: string, title: string): void {
  getDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, Date.now(), id);
}

export function deleteConversation(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  })();
}
