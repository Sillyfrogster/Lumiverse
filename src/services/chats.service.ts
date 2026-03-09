import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getCharacter } from "./characters.service";
import type { Chat, CreateChatInput, CreateGroupChatInput, UpdateChatInput, RecentChat, GroupedRecentChat, ChatSummary } from "../types/chat";
import type { Message, CreateMessageInput, UpdateMessageInput } from "../types/message";
import type { BulkMessageInput } from "../types/migrate";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

// --- Chat helpers ---

function rowToChat(row: any): Chat {
  return { ...row, metadata: JSON.parse(row.metadata) };
}

function rowToMessage(row: any): Message {
  return {
    ...row,
    is_user: !!row.is_user,
    swipes: JSON.parse(row.swipes),
    extra: JSON.parse(row.extra),
    parent_message_id: row.parent_message_id || null,
    branch_id: row.branch_id || null,
  };
}

function rowToRecentChat(row: any): RecentChat {
  return {
    ...row,
    metadata: JSON.parse(row.metadata),
    character_name: row.character_name || "",
    character_avatar_path: row.character_avatar_path || null,
    character_image_id: row.character_image_id || null,
  };
}

// --- Chat CRUD ---

export function listChats(userId: string, pagination: PaginationParams, characterId?: string): PaginatedResult<Chat> {
  if (characterId) {
    return paginatedQuery(
      "SELECT * FROM chats WHERE user_id = ? AND character_id = ? ORDER BY updated_at DESC",
      "SELECT COUNT(*) as count FROM chats WHERE user_id = ? AND character_id = ?",
      [userId, characterId],
      pagination,
      rowToChat
    );
  }
  return paginatedQuery(
    "SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM chats WHERE user_id = ?",
    [userId],
    pagination,
    rowToChat
  );
}

export function listRecentChats(userId: string, pagination: PaginationParams): PaginatedResult<RecentChat> {
  return paginatedQuery(
    `SELECT c.id, c.character_id, c.name, c.metadata, c.created_at, c.updated_at,
       ch.name AS character_name, ch.avatar_path AS character_avatar_path, ch.image_id AS character_image_id
     FROM chats c LEFT JOIN characters ch ON ch.id = c.character_id
     WHERE c.user_id = ?
     ORDER BY c.updated_at DESC`,
    "SELECT COUNT(*) as count FROM chats WHERE user_id = ?",
    [userId],
    pagination,
    rowToRecentChat
  );
}

export function listRecentChatsGrouped(userId: string, pagination: PaginationParams): PaginatedResult<GroupedRecentChat> {
  const db = getDb();

  // Count distinct characters (for pagination total)
  const countRow = db.query(
    `SELECT COUNT(DISTINCT character_id) as count FROM chats WHERE user_id = ?`
  ).get(userId) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const rows = db.query(`
    WITH ranked AS (
      SELECT
        c.id,
        c.character_id,
        c.name,
        c.metadata,
        c.updated_at,
        ROW_NUMBER() OVER (PARTITION BY c.character_id ORDER BY c.updated_at DESC) as rn,
        COUNT(*) OVER (PARTITION BY c.character_id) as chat_count
      FROM chats c
      WHERE c.user_id = ?
    )
    SELECT
      r.id as latest_chat_id,
      r.character_id,
      r.name as latest_chat_name,
      r.metadata,
      r.updated_at,
      r.chat_count,
      ch.name AS character_name,
      ch.avatar_path AS character_avatar_path,
      ch.image_id AS character_image_id
    FROM ranked r
    LEFT JOIN characters ch ON ch.id = r.character_id
    WHERE r.rn = 1
    ORDER BY r.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map((row: any) => {
      const metadata = JSON.parse(row.metadata || '{}');
      return {
        character_id: row.character_id,
        character_name: row.character_name || '',
        character_avatar_path: row.character_avatar_path || null,
        character_image_id: row.character_image_id || null,
        latest_chat_id: row.latest_chat_id,
        latest_chat_name: row.latest_chat_name || '',
        updated_at: row.updated_at,
        chat_count: row.chat_count,
        is_group: metadata?.group === true,
      };
    }),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function listChatSummaries(userId: string, characterId: string): ChatSummary[] {
  const db = getDb();
  const rows = db.query(`
    SELECT
      c.id,
      c.name,
      c.created_at,
      c.updated_at,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
    FROM chats c
    WHERE c.user_id = ? AND c.character_id = ?
    ORDER BY c.updated_at DESC
  `).all(userId, characterId) as any[];

  return rows.map((row: any) => ({
    id: row.id,
    name: row.name || '',
    message_count: row.message_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getChat(userId: string, id: string): Chat | null {
  const row = getDb().query("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToChat(row);
}

export function createChat(userId: string, input: CreateChatInput): Chat {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.character_id, input.name || "", JSON.stringify(input.metadata || {}), now, now);

  // Insert the character's greeting as the opening message
  const character = getCharacter(userId, input.character_id);
  if (character) {
    let greeting = character.first_mes;
    if (input.greeting_index && input.greeting_index >= 1 && character.alternate_greetings?.length) {
      const altIdx = input.greeting_index - 1;
      if (altIdx < character.alternate_greetings.length) {
        greeting = character.alternate_greetings[altIdx];
      }
    }
    if (greeting) {
      createMessage(id, {
        is_user: false,
        name: character.name,
        content: greeting,
      });
    }
  }

  return getChat(userId, id)!;
}

export function createGroupChat(userId: string, input: CreateGroupChatInput): Chat {
  const greetingCharId = input.greeting_character_id || input.character_ids[0];
  const metadata = { group: true, character_ids: input.character_ids };

  const chat = createChat(userId, {
    character_id: greetingCharId,
    name: input.name || "",
    metadata,
    greeting_index: input.greeting_index,
  });

  return chat;
}

export function deleteChat(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM chats WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function updateChat(userId: string, id: string, input: UpdateChatInput): Chat | null {
  const existing = getChat(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  const now = Math.floor(Date.now() / 1000);
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  getDb().query(`UPDATE chats SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const updated = getChat(userId, id)!;
  eventBus.emit(EventType.CHAT_CHANGED, { chat: updated }, userId);
  return updated;
}

export function reattributeUserMessages(userId: string, chatId: string, personaId: string, personaName: string): number | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const rows = getDb()
    .query("SELECT id, extra FROM messages WHERE chat_id = ? AND is_user = 1")
    .all(chatId) as Array<{ id: string; extra: string }>;

  const update = getDb().query("UPDATE messages SET name = ?, extra = ? WHERE id = ?");
  for (const row of rows) {
    let extra: Record<string, any> = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    extra.persona_id = personaId;
    update.run(personaName, JSON.stringify(extra), row.id);
  }

  if (rows.length > 0) {
    eventBus.emit(EventType.CHAT_CHANGED, { chatId, reattributedUserMessages: rows.length }, userId);
  }

  return rows.length;
}

export function getLastAssistantMessage(userId: string, chatId: string): Message | null {
  const row = getDb()
    .query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? AND m.is_user = 0 ORDER BY m.index_in_chat DESC LIMIT 1")
    .get(chatId, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

export function getLastMessage(userId: string, chatId: string): Message | null {
  const row = getDb()
    .query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat DESC LIMIT 1")
    .get(chatId, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

// --- Message CRUD ---

export function getMessages(userId: string, chatId: string): Message[] {
  const rows = getDb()
    .query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat ASC")
    .all(chatId, userId) as any[];
  return rows.map(rowToMessage);
}

export function listMessages(userId: string, chatId: string, pagination: PaginationParams): PaginatedResult<Message> {
  return paginatedQuery(
    "SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat ASC",
    "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ?",
    [chatId, userId],
    pagination,
    rowToMessage
  );
}

export function getMessage(userId: string, id: string): Message | null {
  const row = getDb().query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.id = ? AND c.user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

export function createMessage(chatId: string, input: CreateMessageInput, userId?: string): Message {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const maxIndex = getDb()
    .query("SELECT COALESCE(MAX(index_in_chat), -1) as max_idx FROM messages WHERE chat_id = ?")
    .get(chatId) as any;
  const nextIndex = (maxIndex?.max_idx ?? -1) + 1;

  const swipes = [input.content];

  getDb()
    .query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, parent_message_id, branch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, chatId, nextIndex, input.is_user ? 1 : 0, input.name, input.content,
      now, 0, JSON.stringify(swipes), JSON.stringify(input.extra || {}),
      input.parent_message_id || null, input.branch_id || null, now
    );

  getDb().query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);

  // getMessage without userId — internal use after validated chat
  const row = getDb().query("SELECT * FROM messages WHERE id = ?").get(id) as any;
  const message = rowToMessage(row);
  eventBus.emit(EventType.MESSAGE_SENT, { chatId, message }, userId);
  return message;
}

export function updateMessage(userId: string, id: string, input: UpdateMessageInput): Message | null {
  const existing = getMessage(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.content !== undefined) {
    fields.push("content = ?");
    values.push(input.content);

    // Update current swipe content too
    const swipes = [...existing.swipes];
    swipes[existing.swipe_id] = input.content;
    fields.push("swipes = ?");
    values.push(JSON.stringify(swipes));
  }
  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.extra !== undefined) { fields.push("extra = ?"); values.push(JSON.stringify(input.extra)); }

  if (fields.length === 0) return existing;
  values.push(id);

  getDb().query(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const updated = getMessage(userId, id)!;
  eventBus.emit(EventType.MESSAGE_EDITED, { chatId: updated.chat_id, message: updated }, userId);
  return updated;
}

export function deleteMessage(userId: string, id: string): boolean {
  const msg = getMessage(userId, id);
  if (!msg) return false;
  const result = getDb().query("DELETE FROM messages WHERE id = ?").run(id);
  if (result.changes > 0) {
    eventBus.emit(EventType.MESSAGE_DELETED, { chatId: msg.chat_id, messageId: id }, userId);
  }
  return result.changes > 0;
}

// --- Swipes ---

export function addSwipe(userId: string, messageId: string, content: string): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg) return null;

  const swipes = [...msg.swipes, content];
  const newSwipeId = swipes.length - 1;

  getDb()
    .query("UPDATE messages SET swipes = ?, swipe_id = ?, content = ? WHERE id = ?")
    .run(JSON.stringify(swipes), newSwipeId, content, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(EventType.MESSAGE_SWIPED, { chatId: updated.chat_id, message: updated }, userId);
  return updated;
}

export function updateSwipe(userId: string, messageId: string, swipeIdx: number, content: string): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || swipeIdx < 0 || swipeIdx >= msg.swipes.length) return null;

  const swipes = [...msg.swipes];
  swipes[swipeIdx] = content;

  const updates = swipeIdx === msg.swipe_id
    ? "swipes = ?, content = ?"
    : "swipes = ?";
  const values = swipeIdx === msg.swipe_id
    ? [JSON.stringify(swipes), content, messageId]
    : [JSON.stringify(swipes), messageId];

  getDb().query(`UPDATE messages SET ${updates} WHERE id = ?`).run(...values);
  const updated = getMessage(userId, messageId)!;
  eventBus.emit(EventType.MESSAGE_SWIPED, { chatId: updated.chat_id, message: updated }, userId);
  return updated;
}

export function deleteSwipe(userId: string, messageId: string, swipeIdx: number): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || msg.swipes.length <= 1) return null; // can't delete last swipe
  if (swipeIdx < 0 || swipeIdx >= msg.swipes.length) return null;

  const swipes = [...msg.swipes];
  swipes.splice(swipeIdx, 1);

  // Adjust swipe_id: if deleted swipe was before or at current, shift back (min 0)
  let newSwipeId = msg.swipe_id;
  if (swipeIdx < msg.swipe_id) {
    newSwipeId = msg.swipe_id - 1;
  } else if (swipeIdx === msg.swipe_id) {
    newSwipeId = Math.min(msg.swipe_id, swipes.length - 1);
  }

  const newContent = swipes[newSwipeId] ?? swipes[0];

  getDb()
    .query("UPDATE messages SET swipes = ?, swipe_id = ?, content = ? WHERE id = ?")
    .run(JSON.stringify(swipes), newSwipeId, newContent, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(EventType.MESSAGE_SWIPED, { chatId: updated.chat_id, message: updated }, userId);
  return updated;
}

export function cycleSwipe(userId: string, messageId: string, direction: "left" | "right"): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || msg.swipes.length <= 1) return msg;

  const nextIdx = direction === "left" ? msg.swipe_id - 1 : msg.swipe_id + 1;
  if (nextIdx < 0 || nextIdx >= msg.swipes.length) return msg;

  const nextContent = msg.swipes[nextIdx] ?? msg.content;

  getDb()
    .query("UPDATE messages SET swipe_id = ?, content = ? WHERE id = ?")
    .run(nextIdx, nextContent, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(EventType.MESSAGE_SWIPED, { chatId: updated.chat_id, message: updated }, userId);
  return updated;
}

// --- Branching ---

export function branchChat(userId: string, chatId: string, atMessageId: string): Chat | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const msg = getMessage(userId, atMessageId);
  if (!msg || msg.chat_id !== chatId) return null;

  const branchId = crypto.randomUUID();
  const newChatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Create the chat row directly — skip createChat() which auto-inserts a greeting
  const metadata = { ...chat.metadata, branched_from: chatId, branch_at_message: atMessageId };
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(newChatId, userId, chat.character_id, `${chat.name || "Chat"} (branch)`, JSON.stringify(metadata), now, now);

  // Copy messages up to and including the branch point
  const messages = getDb()
    .query("SELECT * FROM messages WHERE chat_id = ? AND index_in_chat <= ? ORDER BY index_in_chat ASC")
    .all(chatId, msg.index_in_chat) as any[];

  for (const m of messages) {
    const newMsgId = crypto.randomUUID();
    getDb()
      .query(
        `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, branch_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(newMsgId, newChatId, m.index_in_chat, m.is_user, m.name, m.content, m.send_date, m.swipe_id, m.swipes, m.extra, branchId, now);
  }

  return getChat(userId, newChatId)!;
}

// Branch tree

export type ChatTreeNode = {
  id: string
  name: string
  created_at: number
  updated_at: number
  message_count: number
  branch_at_message: string | null
  children: ChatTreeNode[]
}

function buildSubTree(userId: string, chatId: string, visited: Set<string>, depth: number): ChatTreeNode | null {
  if (visited.has(chatId) || depth > 20) return null;
  visited.add(chatId);

  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const db = getDb();
  const countRow = db.query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?").get(chatId) as { count: number } | null;
  const message_count = countRow?.count ?? 0;

  const childRows = db.query(
    `SELECT * FROM chats WHERE user_id = ? AND json_extract(metadata, '$.branched_from') = ? ORDER BY created_at ASC`
  ).all(userId, chatId) as any[];

  const children: ChatTreeNode[] = [];
  for (const row of childRows) {
    const child = buildSubTree(userId, row.id, visited, depth + 1);
    if (child) children.push(child);
  }

  return {
    id: chat.id,
    name: chat.name,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    message_count,
    branch_at_message: (chat.metadata.branch_at_message as string) ?? null,
    children,
  };
}

export function getChatTree(userId: string, chatId: string): ChatTreeNode | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  // root of the branch family
  let rootId = chatId;
  const ancestorVisited = new Set<string>();
  ancestorVisited.add(chatId);
  let current = chat;

  while (current.metadata.branched_from) {
    const parentId = current.metadata.branched_from as string;
    if (ancestorVisited.has(parentId)) break;
    ancestorVisited.add(parentId);
    const parent = getChat(userId, parentId);
    if (!parent) break;
    rootId = parentId;
    current = parent;
  }

  return buildSubTree(userId, rootId, new Set(), 0);
}

// --- Migration helpers ---

export function createChatRaw(userId: string, input: { character_id: string; name?: string; metadata?: Record<string, any>; created_at?: number; updated_at?: number }): Chat {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const createdAt = input.created_at ?? now;
  const updatedAt = input.updated_at ?? createdAt;

  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.character_id, input.name || "", JSON.stringify(input.metadata || {}), createdAt, updatedAt);

  return getChat(userId, id)!;
}

export function bulkInsertMessages(chatId: string, messages: BulkMessageInput[]): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const insert = db.query(
    `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, parent_message_id, branch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const swipes = m.swipes && m.swipes.length > 0 ? m.swipes : [m.content];
      const swipeId = m.swipe_id ?? 0;
      const sendDate = m.send_date ?? now;

      insert.run(
        crypto.randomUUID(),
        chatId,
        i,
        m.is_user ? 1 : 0,
        m.name,
        m.content,
        sendDate,
        swipeId,
        JSON.stringify(swipes),
        JSON.stringify(m.extra || {}),
        null,
        null,
        sendDate
      );
    }
  });

  tx();

  // Update chat's updated_at to last message timestamp
  if (messages.length > 0) {
    const lastDate = messages[messages.length - 1].send_date ?? now;
    db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(lastDate, chatId);
  }

  return messages.length;
}

// --- Export ---

export function exportChat(userId: string, chatId: string): { chat: Chat; messages: Message[] } | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;
  const messages = getMessages(userId, chatId);
  return { chat, messages };
}
