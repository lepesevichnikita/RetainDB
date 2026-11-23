import { z } from "zod";
import { getOpenAIClient } from "./openai-client.js";
import { entityRelationType, saveChunkGraph, type ChunkGraph } from "./entity-graph-write.js";
import { writeMemoryCanonical } from "./memory/write.js";

// ═══════════════════════════════════════════════════════════════
// ENTITY EXTRACTION (runs during ingestion)
// ═══════════════════════════════════════════════════════════════

const entityClaims = z.object({
  entities: z.array(z.object({
    name: z.string().trim().min(1), type: z.string().trim().min(1), description: z.string().optional(),
  })),
  relations: z.array(z.object({
    from: z.string(), fromType: z.string(), to: z.string(), toType: z.string(), relation: z.string(),
  })),
});

function parseGraphClaims(value: unknown): ChunkGraph {
  const claims = entityClaims.parse(value);
  return {
    entities: claims.entities.slice(0, 20).map(({ type, ...entity }) => ({ ...entity, entityType: type })),
    relations: claims.relations.slice(0, 30).flatMap(toGraphRelation),
  };
}

function toGraphRelation({ from, fromType, to, toType, relation }: z.infer<typeof entityClaims>["relations"][number]) {
  const type = entityRelationType.safeParse(relation);
  if (!type.success) return [];
  return [{
    from: { name: from.trim(), entityType: fromType.trim() },
    to: { name: to.trim(), entityType: toType.trim() },
    type: type.data,
  }];
}

function entityPrompt(content: string, chunkType: string) {
  const isCode = ["code", "function", "class"].includes(chunkType);

  return isCode
    ? `Analyze this code and extract entities and relationships.

Entities: functions, classes, interfaces, types, modules, variables, constants, API endpoints, services.
Relations: imports, exports, calls, implements, extends, depends_on, references, part_of.

Code:
\`\`\`
${content.slice(0, 3000)}
\`\`\`

Respond with JSON only:
{
  "entities": [{"name": "...", "type": "function|class|interface|module|constant|api_endpoint|service", "description": "one line"}],
  "relations": [{"from": "name", "fromType": "type", "to": "name", "toType": "type", "relation": "imports|calls|extends|implements|depends_on|references|part_of"}]
}`
    : `Analyze this text and extract key entities (concepts, people, tools, services, APIs, technologies) and their relationships.

Text:
${content.slice(0, 3000)}

Respond with JSON only:
{
  "entities": [{"name": "...", "type": "concept|tool|service|api|technology|person|organization", "description": "one line"}],
  "relations": [{"from": "name", "fromType": "type", "to": "name", "toType": "type", "relation": "references|depends_on|related_to|part_of|supersedes"}]
}`;
}

export async function extractEntities(projectId: string, chunkId: string, content: string, chunkType: string) {
  return saveChunkGraph(projectId, chunkId, await readEntityClaims(content, chunkType));
}

export async function readEntityClaims(content: string, chunkType: string, options?: { timeout: number; maxRetries: number }) {
  const result = await getOpenAIClient().chat.completions.create({
    model: process.env.EXTRACTION_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: entityPrompt(content, chunkType) }],
    temperature: 0,
    max_tokens: 1000,
    response_format: { type: "json_object" },
  }, options);
  const choice = result.choices[0];
  if (choice?.finish_reason !== "stop" || choice.message.refusal || !choice.message.content) {
    throw new Error("Graph extraction did not return a complete response.");
  }
  return parseGraphClaims(JSON.parse(choice.message.content));
}

// ═══════════════════════════════════════════════════════════════
// MEMORY EXTRACTION (runs on conversation messages)
// ═══════════════════════════════════════════════════════════════

interface ExtractedMemory {
  content: string;
  type: "factual" | "episodic" | "semantic" | "procedural";
  importance: number;
}

/**
 * Analyzes a conversation message (or batch) and extracts facts worth remembering.
 * Call this after adding messages to a conversation.
 */
export async function extractMemories(
  projectId: string,
  messages: { role: string; content: string }[],
  opts?: { userId?: string; sessionId?: string; agentId?: string }
): Promise<{ memoriesCreated: number }> {
  if (messages.length === 0) return { memoriesCreated: 0 };

  const conversation = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  // Skip very short conversations
  if (conversation.length < 50) return { memoriesCreated: 0 };

  const prompt = `Analyze this conversation and extract important facts, preferences, decisions, or knowledge worth remembering for future interactions.

Rules:
- Only extract truly useful information (not greetings, acknowledgments, etc.)
- Each memory should be a standalone fact
- Set importance 0-1 (1 = critical preference/decision, 0.3 = minor detail)
- Type: factual (facts/preferences), episodic (what happened), semantic (general knowledge), procedural (how to do something)
- If nothing worth remembering, return empty array

Conversation:
${conversation.slice(0, 4000)}

Respond with JSON only:
{
  "memories": [
    {"content": "standalone fact", "type": "factual|episodic|semantic|procedural", "importance": 0.5}
  ]
}`;

  try {
    const res = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    const text = res.choices[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(text);
    const extracted: ExtractedMemory[] = parsed.memories || [];

    let created = 0;

    for (const mem of extracted.slice(0, 10)) {
      if (!mem.content || mem.content.length < 10) continue;

      const validTypes = ["factual", "episodic", "semantic", "procedural"];
      const memType = validTypes.includes(mem.type) ? mem.type : "factual";
      const importance = Math.max(0, Math.min(1, mem.importance || 0.5));

      try {
        const writeResult = await writeMemoryCanonical({
          projectId,
          userId: opts?.userId,
          sessionId: opts?.sessionId,
          agentId: opts?.agentId,
          content: mem.content,
          memoryType: memType,
          importance,
          confidenceRaw: importance,
          metadata: { autoExtracted: true },
          writeSource: "engine.extractor.legacy",
          writeMode: "session_extract",
          extractionMethod: "legacy_llm",
          publishPendingOverlay: false,
          sessionRetentionDays: 14,
        });
        if (writeResult.outcome === "created") created++;
      } catch (err: any) {
        console.error("[Extractor] Error creating memory:", err.message);
      }
    }

    return { memoriesCreated: created };
  } catch {
    return { memoriesCreated: 0 };
  }
}
