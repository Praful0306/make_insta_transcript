// OpenAPI 3.1 description of the read-only knowledge-base API. Served at /api/v1/openapi.json.
export function openapi(origin) {
  const filters = [
    { name: "trader", in: "query", schema: { type: "string" }, description: "Comma-separated trader ids, e.g. 1,4. Omit for all traders." },
    { name: "concept", in: "query", schema: { type: "string" }, description: "Exact concept name (case-insensitive), e.g. 'Order block'." },
    { name: "category", in: "query", schema: { type: "string" }, description: "Rule category, e.g. 'entry', 'exit', 'risk'." },
    { name: "q", in: "query", schema: { type: "string" }, description: "Text search in title, rule, explanation, concept and quote." },
    { name: "verified", in: "query", schema: { type: "boolean" }, description: "true = only rules whose quote was found word for word in the transcript. Recommended when building indicators." },
  ];
  const ok = (desc, schema) => ({ 200: { description: desc, content: schema }, 400: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" } });
  const json = ref => ({ "application/json": { schema: { $ref: "#/components/schemas/" + ref } } });
  const secured = [{ neonUrl: [] }];
  return {
    openapi: "3.1.0",
    info: {
      title: "Trader knowledge base API",
      version: "1.0.0",
      description: "Read-only access to the trading rules extracted from Instagram reels and YouTube videos and stored in YOUR OWN Neon database. " +
        "The server keeps no data: every request carries your Neon connection string in the x-neon-url header and reads from your database. " +
        "Rules come only from each trader's own words, with the exact quote and source. 'Not stated' means the trader did not say it. This is educational material, not financial advice.",
    },
    servers: [{ url: origin + "/api/v1" }],
    security: secured,
    paths: {
      "/traders": { get: { operationId: "listTraders", summary: "List traders with rule counts", responses: ok("Traders", json("TraderList")) } },
      "/traders/{id}": {
        get: {
          operationId: "getTrader", summary: "One trader with accounts, sources and all rules",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "include", in: "query", schema: { type: "string", enum: ["transcripts"] }, description: "transcripts adds the full transcript text of each source." }, ...filters.slice(1)],
          responses: ok("Trader", json("TraderDetail")),
        },
      },
      "/sources/{id}": { get: { operationId: "getSource", summary: "One source with its full transcript", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: ok("Source", json("SourceDetail")) } },
      "/rules": {
        get: {
          operationId: "listRules", summary: "Search and page through rules across traders",
          parameters: [...filters, { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } }, { name: "offset", in: "query", schema: { type: "integer", default: 0 } }],
          responses: ok("A page of rules", json("RuleList")),
        },
      },
      "/concepts": { get: { operationId: "listConcepts", summary: "Concepts across all traders, with which traders cover them", parameters: filters, responses: ok("Concepts", json("ConceptList")) } },
      "/knowledge": {
        get: {
          operationId: "getKnowledge", summary: "Everything combined: all matching rules from all (or chosen) traders, grouped by concept",
          description: "Best starting point for building an indicator. Use format=markdown for a single text document that can be pasted into a prompt.",
          parameters: [...filters, { name: "format", in: "query", schema: { type: "string", enum: ["json", "markdown"], default: "json" } }],
          responses: { 200: { description: "Combined knowledge", content: { ...json("Knowledge"), "text/markdown": { schema: { type: "string" } } } }, 400: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" } },
        },
      },
    },
    components: {
      securitySchemes: { neonUrl: { type: "apiKey", in: "header", name: "x-neon-url", description: "Your Neon connection string (postgresql://user:password@ep-....neon.tech/neondb?sslmode=require). A read-only Neon role is recommended." } },
      responses: { Error: { description: "Error", content: json("Error") } },
      schemas: {
        Error: { type: "object", properties: { ok: { const: false }, error: { type: "string" }, code: { type: "string" } } },
        Rule: {
          type: "object",
          properties: {
            id: { type: "integer" }, trader: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
            source: { type: "object", properties: { id: { type: "integer" }, platform: { enum: ["instagram", "youtube"] }, url: { type: "string" }, title: { type: "string" }, link: { type: "string", description: "Source link, with a timestamp for YouTube." }, timestamp_sec: { type: ["number", "null"] } } },
            category: { type: "string" }, concept: { type: "string" }, title: { type: "string" }, rule: { type: "string" }, explanation: { type: "string" },
            conditions: { type: "array", items: { type: "string" } }, entry: { type: "string" }, stop_loss: { type: "string" }, target: { type: "string" }, invalidation: { type: "string" },
            timeframe: { type: "string" }, instruments: { type: "string" },
            indicators: { type: "array", items: { type: "object", properties: { name: { type: "string" }, settings: { type: "string" } } } },
            ambiguities: { type: "array", items: { type: "string" }, description: "Things the trader did not specify." }, related: { type: "array", items: { type: "string" } },
            quote: { type: "string", description: "The trader's exact words." }, quote_found: { type: "boolean" }, verified: { type: "boolean" }, review_note: { type: ["string", "null"] },
          },
        },
        TraderList: { type: "object", properties: { traders: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, sources: { type: "integer" }, rules: { type: "integer" }, verified_rules: { type: "integer" }, accounts: { type: "array", items: { type: "object" } } } } } } },
        TraderDetail: { type: "object", properties: { trader: { type: "object" }, accounts: { type: "array", items: { type: "object" } }, sources: { type: "array", items: { type: "object" } }, rules: { type: "array", items: { $ref: "#/components/schemas/Rule" } } } },
        SourceDetail: { type: "object", properties: { source: { type: "object" } } },
        RuleList: { type: "object", properties: { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" }, rules: { type: "array", items: { $ref: "#/components/schemas/Rule" } } } },
        ConceptList: { type: "object", properties: { concepts: { type: "array", items: { type: "object", properties: { concept: { type: "string" }, rules: { type: "integer" }, verified_rules: { type: "integer" }, traders: { type: "array", items: { type: "object" } } } } } } },
        Knowledge: {
          type: "object",
          properties: {
            generated: { type: "string" }, rule_count: { type: "integer" }, verified_count: { type: "integer" }, truncated: { type: "boolean" },
            traders: { type: "array", items: { type: "object" } },
            concepts: { type: "array", items: { type: "object", properties: { concept: { type: "string" }, rules: { type: "integer" }, traders: { type: "array", items: { type: "string" } }, items: { type: "array", items: { $ref: "#/components/schemas/Rule" } } } } },
          },
        },
      },
    },
  };
}
