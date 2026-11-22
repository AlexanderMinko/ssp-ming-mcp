import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../mongo.js";
import { bidderInput, defaultBidderId, springClass } from "../schemas.js";
import { jsonResult } from "../../common/result.js";

const COLLECTION = "bidders";

interface BidderDoc {
  _id: string;
  name: string;
  seat: string;
  endpoint: string;
  tmaxMs?: number;
  _class: string;
}

export function registerBidderTools(server: McpServer): void {
  server.registerTool(
    "list_bidders",
    {
      title: "List bidders",
      description: "List every bidder in the bidders collection. The exchange calls all of them on every auction.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await (await db("exchange")).collection<BidderDoc>(COLLECTION).find({}).sort({ _id: 1 }).toArray();
      return jsonResult(rows);
    },
  );

  server.registerTool(
    "upsert_bidder",
    {
      title: "Upsert bidder",
      description:
        "Insert or replace one bidder by _id (defaults to bidder-<name>). " +
        "Omit tmaxMs to remove it. The exchange reloads config every 30 s.",
      inputSchema: bidderInput.shape,
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const id = args.id ?? defaultBidderId(args.name);
      const collection = (await db("exchange")).collection<BidderDoc>(COLLECTION);
      const before = await collection.findOne({ _id: id });
      const doc: BidderDoc = {
        _id: id,
        name: args.name,
        seat: args.seat,
        endpoint: args.endpoint,
        _class: springClass.bidder,
        ...(args.tmaxMs === undefined ? {} : { tmaxMs: args.tmaxMs }),
      };
      await collection.replaceOne({ _id: id }, doc, { upsert: true });
      const after = await collection.findOne({ _id: id });
      return jsonResult({ action: before ? "replaced" : "inserted", before, after });
    },
  );

  server.registerTool(
    "delete_bidder",
    {
      title: "Delete bidder",
      description: "Delete one bidder by _id. Returns the deleted document, or null if none matched.",
      inputSchema: { id: z.string().min(1).describe("Mongo _id, e.g. bidder-alpha") },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const deleted = await (await db("exchange")).collection<BidderDoc>(COLLECTION).findOneAndDelete({ _id: args.id });
      return jsonResult({ deleted });
    },
  );
}
