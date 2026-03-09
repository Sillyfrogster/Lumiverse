import { Hono } from "hono";
import * as svc from "../services/characters.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import * as cardSvc from "../services/character-card.service";
import { parsePagination } from "../services/pagination";

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listCharacters(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const character = svc.createCharacter(userId, body);
  return c.json(character, 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);
  return c.json(char);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const char = svc.updateCharacter(userId, c.req.param("id"), body);
  if (!char) return c.json({ error: "Not found" }, 404);
  return c.json(char);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteCharacter(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/avatar", (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);

  // Prefer image_id, fall back to legacy avatar_path
  if (char.image_id) {
    const filepath = images.getImageFilePath(userId, char.image_id);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
    }
  }

  if (char.avatar_path) {
    const filepath = files.getAvatarPath(char.avatar_path);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
    }
  }

  return c.json({ error: "Not found" }, 404);
});

app.post("/:id/duplicate", (c) => {
  const userId = c.get("userId");
  const character = svc.duplicateCharacter(userId, c.req.param("id"));
  if (!character) return c.json({ error: "Not found" }, 404);
  return c.json(character, 201);
});

app.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  // Clean up old image if present
  if (char.image_id) images.deleteImage(userId, char.image_id);
  if (char.avatar_path) files.deleteAvatar(char.avatar_path);

  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, char.id, image.id);
  svc.setCharacterAvatar(userId, char.id, image.filename);
  return c.json({ image_id: image.id, avatar_path: image.filename });
});

app.post("/import-bulk", async (c) => {
  const userId = c.get("userId");

  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) return c.json({ error: "files are required" }, 400);
    if (files.length > 500) return c.json({ error: "Maximum 500 files per bulk import" }, 400);

    const skipDuplicates = formData.get("skip_duplicates") === "true";

    const results: Array<{
      filename: string;
      success: boolean;
      character?: any;
      lorebook?: { name: string; entryCount: number };
      error?: string;
      skipped?: boolean;
    }> = [];

    for (const file of files) {
      const filename = file.name || "unknown";
      try {
        let cardInput;
        let isPng = false;

        if (file.type === "image/png" || filename.endsWith(".png")) {
          cardInput = await cardSvc.extractCardFromPng(file);
          isPng = true;
        } else {
          const text = await file.text();
          const json = JSON.parse(text);
          cardInput = cardSvc.parseCardJson(json);
        }

        // Deduplication check
        if (skipDuplicates) {
          const hasRealFilename = filename && filename !== "unknown" && filename !== "";
          const existingByFile = hasRealFilename
            ? svc.findCharacterBySourceFilename(userId, filename)
            : null;

          if (existingByFile) {
            results.push({ filename, success: true, skipped: true, character: existingByFile });
            continue;
          }

          // No filename match — fall back to name-based check only when filename is absent
          if (!hasRealFilename && svc.characterExistsByName(userId, cardInput.name)) {
            const existing = svc.findCharactersByName(userId, cardInput.name);
            results.push({ filename, success: true, skipped: true, character: existing[0] });
            continue;
          }
        }

        const character = svc.createCharacter(userId, cardInput);

        // Store source filename so re-imports can deduplicate by file identity
        if (filename && filename !== "unknown" && filename !== "") {
          svc.setCharacterSourceFilename(userId, character.id, filename);
        }

        if (isPng) {
          const image = await images.uploadImage(userId, file);
          svc.setCharacterImage(userId, character.id, image.id);
          svc.setCharacterAvatar(userId, character.id, image.filename);
        }

        const imported = svc.getCharacter(userId, character.id)!;

        // Check for embedded lorebook
        let lorebook: { name: string; entryCount: number } | undefined;
        const charBook = imported.extensions?.character_book;
        if (charBook?.entries?.length) {
          const entries = Array.isArray(charBook.entries)
            ? charBook.entries
            : Object.values(charBook.entries);
          lorebook = {
            name: charBook.name || `${imported.name}'s Lorebook`,
            entryCount: entries.length,
          };
        }

        results.push({ filename, success: true, character: imported, lorebook });
      } catch (err: any) {
        results.push({
          filename,
          success: false,
          error: err.message || "Failed to import",
        });
      }
    }

    const imported = results.filter((r) => r.success && !r.skipped && r.character).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    return c.json({ results, summary: { total: files.length, imported, skipped, failed } }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Bulk import failed" }, 400);
  }
});

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;
      if (!file) return c.json({ error: "file is required" }, 400);

      if (file.type === "image/png" || file.name?.endsWith(".png")) {
        // PNG card — extract embedded JSON + use as avatar
        const cardInput = await cardSvc.extractCardFromPng(file);
        const character = svc.createCharacter(userId, cardInput);
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported }, 201);
      } else {
        // JSON file — read text content, parse card spec
        const text = await file.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          return c.json({ error: "Invalid JSON in uploaded file" }, 400);
        }
        const cardInput = cardSvc.parseCardJson(json);
        const character = svc.createCharacter(userId, cardInput);
        return c.json({ character }, 201);
      }
    } else {
      // Raw JSON body — support both card-spec wrapper and flat input
      const body = await c.req.json();
      const input = (body.spec && body.data) ? cardSvc.parseCardJson(body) : body;
      if (!input.name) return c.json({ error: "name is required" }, 400);
      const character = svc.createCharacter(userId, input);
      return c.json({ character }, 201);
    }
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to import character card" }, 400);
  }
});

export { app as charactersRoutes };
