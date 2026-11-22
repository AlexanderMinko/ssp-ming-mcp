import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Filter } from "mongodb";
import { z } from "zod";
import { db } from "../mongo.js";
import {
  defaultSupplyPartnerId,
  name,
  publisherId,
  sourceId,
  springClass,
  supplyPartnerKey,
  supplyPartnerType,
  type SupplyPartnerKey,
} from "../schemas.js";
import { jsonResult } from "../../common/result.js";

const COLLECTION = "supply_partners";

interface SupplyPartnerDoc {
  _id: string;
  entityType: "SOURCE" | "PUBLISHER";
  sourceId?: string;
  publisherId?: string;
  name: string;
  _class: string;
}

function keyFilter(key: SupplyPartnerKey): Filter<SupplyPartnerDoc> {
  if (key.entityType === "SOURCE") {
    return { entityType: "SOURCE", sourceId: key.sourceId };
  }
  return { entityType: "PUBLISHER", publisherId: key.publisherId };
}

export function registerSupplyPartnerTools(server: McpServer): void {
  server.registerTool(
    "list_supply_partners",
    {
      title: "List supply partners",
      description:
        "List documents in supply_partners. SOURCE rows are keyed by the 3-char sourceId (?account=), " +
        "PUBLISHER rows by publisherId (site.publisher.id / app.publisher.id). Filters are optional.",
      inputSchema: {
        entityType: supplyPartnerType.optional(),
        sourceId: sourceId.optional(),
        publisherId: publisherId.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const filter: Filter<SupplyPartnerDoc> = {};
      if (args.entityType) {
        filter.entityType = args.entityType;
      }
      if (args.sourceId) {
        filter.sourceId = args.sourceId;
      }
      if (args.publisherId) {
        filter.publisherId = args.publisherId;
      }
      const rows = await (await db("exchange")).collection<SupplyPartnerDoc>(COLLECTION).find(filter).sort({ _id: 1 }).toArray();
      return jsonResult(rows);
    },
  );

  server.registerTool(
    "upsert_supply_partner",
    {
      title: "Upsert supply partner",
      description:
        "Insert or update one supply partner by its natural key (SOURCE: sourceId, PUBLISHER: publisherId). " +
        "On insert the _id defaults to src-<sourceId> or pub-<publisherId>. The exchange reloads config every 30 s.",
      inputSchema: {
        entityType: supplyPartnerType,
        sourceId: sourceId.optional().describe("Required for SOURCE"),
        publisherId: publisherId.optional().describe("Required for PUBLISHER"),
        name,
        id: z.string().min(1).optional().describe("Mongo _id to use when inserting. Ignored on update."),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const key = supplyPartnerKey.parse(args);
      const collection = (await db("exchange")).collection<SupplyPartnerDoc>(COLLECTION);
      const before = await collection.findOne(keyFilter(key));
      const fields: Omit<SupplyPartnerDoc, "_id"> = {
        entityType: key.entityType,
        name: args.name,
        _class: springClass.supplyPartner,
        ...(key.entityType === "SOURCE" ? { sourceId: key.sourceId } : { publisherId: key.publisherId }),
      };
      if (before) {
        await collection.updateOne({ _id: before._id }, { $set: fields });
      } else {
        await collection.insertOne({ _id: args.id ?? defaultSupplyPartnerId(key), ...fields });
      }
      const after = await collection.findOne(keyFilter(key));
      return jsonResult({ action: before ? "updated" : "inserted", before, after });
    },
  );

  server.registerTool(
    "delete_supply_partner",
    {
      title: "Delete supply partner",
      description: "Delete one supply partner by its natural key. Returns the deleted document, or null if none matched.",
      inputSchema: {
        entityType: supplyPartnerType,
        sourceId: sourceId.optional().describe("Required for SOURCE"),
        publisherId: publisherId.optional().describe("Required for PUBLISHER"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const key = supplyPartnerKey.parse(args);
      const collection = (await db("exchange")).collection<SupplyPartnerDoc>(COLLECTION);
      const deleted = await collection.findOneAndDelete(keyFilter(key));
      return jsonResult({ deleted });
    },
  );
}
