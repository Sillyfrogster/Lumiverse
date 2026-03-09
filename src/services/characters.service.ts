import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Character, CreateCharacterInput, UpdateCharacterInput } from "../types/character";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

function rowToCharacter(row: any): Character {
  return {
    ...row,
    avatar_path: row.avatar_path || null,
    image_id: row.image_id || null,
    tags: JSON.parse(row.tags),
    alternate_greetings: JSON.parse(row.alternate_greetings),
    extensions: JSON.parse(row.extensions),
  };
}

export function listCharacters(userId: string, pagination: PaginationParams): PaginatedResult<Character> {
  return paginatedQuery(
    "SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM characters WHERE user_id = ?",
    [userId],
    pagination,
    rowToCharacter
  );
}

export function getCharacter(userId: string, id: string): Character | null {
  const row = getDb().query("SELECT * FROM characters WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToCharacter(row);
}

export function createCharacter(userId: string, input: CreateCharacterInput): Character {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.description || "",
      input.personality || "",
      input.scenario || "",
      input.first_mes || "",
      input.mes_example || "",
      input.creator || "",
      input.creator_notes || "",
      input.system_prompt || "",
      input.post_history_instructions || "",
      JSON.stringify(input.tags || []),
      JSON.stringify(input.alternate_greetings || []),
      JSON.stringify(input.extensions || {}),
      now,
      now
    );

  return getCharacter(userId, id)!;
}

export function updateCharacter(userId: string, id: string, input: UpdateCharacterInput): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);
  const fields: string[] = [];
  const values: any[] = [];

  const stringFields = [
    "name", "description", "personality", "scenario", "first_mes",
    "mes_example", "creator", "creator_notes", "system_prompt", "post_history_instructions",
  ] as const;

  for (const field of stringFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(input[field]);
    }
  }

  const jsonFields = ["tags", "alternate_greetings", "extensions"] as const;
  for (const field of jsonFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(JSON.stringify(input[field]));
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE characters SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getCharacter(userId, id)!;
  eventBus.emit(EventType.CHARACTER_EDITED, { id, character: updated }, userId);
  return updated;
}

export function setCharacterAvatar(userId: string, id: string, avatarPath: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function setCharacterImage(userId: string, id: string, imageId: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(imageId, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function duplicateCharacter(userId: string, id: string): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, avatar_path, image_id, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.description,
      existing.personality,
      existing.scenario,
      existing.first_mes,
      existing.mes_example,
      existing.creator,
      existing.creator_notes,
      existing.system_prompt,
      existing.post_history_instructions,
      existing.avatar_path,
      existing.image_id,
      JSON.stringify(existing.tags),
      JSON.stringify(existing.alternate_greetings),
      JSON.stringify(existing.extensions),
      now,
      now
    );

  const character = getCharacter(userId, newId)!;
  eventBus.emit(EventType.CHARACTER_EDITED, { id: newId, character }, userId);
  return character;
}

export function findCharactersByName(userId: string, name: string): Character[] {
  const rows = getDb()
    .query("SELECT * FROM characters WHERE user_id = ? AND name = ? ORDER BY updated_at DESC")
    .all(userId, name) as any[];
  return rows.map(rowToCharacter);
}

export function characterExistsByName(userId: string, name: string): boolean {
  const row = getDb()
    .query("SELECT 1 FROM characters WHERE user_id = ? AND name = ? LIMIT 1")
    .get(userId, name) as any;
  return !!row;
}

export function findCharacterBySourceFilename(userId: string, sourceFilename: string): Character | null {
  const row = getDb()
    .query(
      "SELECT * FROM characters WHERE user_id = ? AND json_extract(extensions, '$._lumiverse_source_filename') = ? LIMIT 1"
    )
    .get(userId, sourceFilename) as any;
  return row ? rowToCharacter(row) : null;
}

export function setCharacterSourceFilename(userId: string, id: string, sourceFilename: string): void {
  const char = getCharacter(userId, id);
  if (!char) return;
  const extensions = { ...(char.extensions ?? {}), _lumiverse_source_filename: sourceFilename };
  getDb()
    .query("UPDATE characters SET extensions = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(extensions), Math.floor(Date.now() / 1000), id, userId);
}

export function deleteCharacter(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM characters WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.CHARACTER_DELETED, { id }, userId);
  }
  return result.changes > 0;
}
