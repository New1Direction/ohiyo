// Generated contract shared with Rust; run with `bun scripts/burrow-catalog.ts`.
import { writeFileSync } from "node:fs";
import { z } from "../client/node_modules/zod/index.js";
import { pageSchema } from "../client/src/burrow/catalog.ts";
writeFileSync(new URL("../server/src/api/burrow/catalog.schema.json", import.meta.url), `${JSON.stringify(z.toJSONSchema(pageSchema), null, 2)}\n`);
