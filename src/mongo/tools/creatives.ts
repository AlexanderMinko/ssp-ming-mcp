import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Filter } from "mongodb";
import { z } from "zod";
import { db } from "../mongo.js";
import { creativeFormat, creativeInput, creativeShape, defaultCreativeId } from "../schemas.js";
import { jsonResult } from "../../common/result.js";

const COLLECTION = "creatives";

/** Same shape as the bidders service's Creative record. Seeded documents carry no _class, so we write none. */
interface CreativeDoc {
  _id: string;
  bidderId: string;
  crid: string;
  format: "BANNER" | "VIDEO";
  w: number;
  h: number;
  priceCpm: number;
  adomain: string[];
  cat: string[];
  adm: string;
  video?: { durationSec: number; mimes: string[] };
}

export function registerCreativeTools(server: McpServer): void {
  server.registerTool(
    "list_creatives",
    {
      title: "List creatives",
      description:
        "List creatives in the bidders service database (ssp-bidders). Every document is live: a bidder " +
        "answers with the highest-priced creative matching the imp's format and size above the floor. Filters optional.",
      inputSchema: {
        bidderId: z.string().min(1).optional(),
        format: creativeFormat.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const filter: Filter<CreativeDoc> = {};
      if (args.bidderId) {
        filter.bidderId = args.bidderId;
      }
      if (args.format) {
        filter.format = args.format;
      }
      const rows = await (await db("bidders")).collection<CreativeDoc>(COLLECTION).find(filter).sort({ _id: 1 }).toArray();
      return jsonResult(rows);
    },
  );

  server.registerTool(
    "upsert_creative",
    {
      title: "Upsert creative",
      description:
        "Insert or replace one creative by _id (defaults to cr-<crid>). VIDEO needs a video spec, BANNER must not have one. " +
        "The bidders service reads Mongo on every bid, so the change is live at once.",
      inputSchema: creativeShape,
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const creative = creativeInput.parse(args);
      const id = creative.id ?? defaultCreativeId(creative.crid);
      const collection = (await db("bidders")).collection<CreativeDoc>(COLLECTION);
      const before = await collection.findOne({ _id: id });
      const doc: CreativeDoc = {
        _id: id,
        bidderId: creative.bidderId,
        crid: creative.crid,
        format: creative.format,
        w: creative.w,
        h: creative.h,
        priceCpm: creative.priceCpm,
        adomain: creative.adomain,
        cat: creative.cat,
        adm: creative.adm,
        ...(creative.video ? { video: creative.video } : {}),
      };
      await collection.replaceOne({ _id: id }, doc, { upsert: true });
      const after = await collection.findOne({ _id: id });
      return jsonResult({ action: before ? "replaced" : "inserted", before, after });
    },
  );

  server.registerTool(
    "delete_creative",
    {
      title: "Delete creative",
      description: "Delete one creative by _id (retires it). Returns the deleted document, or null if none matched.",
      inputSchema: { id: z.string().min(1).describe("Mongo _id, e.g. cr-alpha-320x50") },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const deleted = await (await db("bidders")).collection<CreativeDoc>(COLLECTION).findOneAndDelete({ _id: args.id });
      return jsonResult({ deleted });
    },
  );
}
