- **The workspace and the published MCP and n8n packages resolve zod 4.6.7, outside the vulnerable range of GHSA-mrhx-c7xc-m3w5.**
  `packages/flair-mcp` moves its zod pin from 4.3.6 to 4.6.7 and
  `packages/n8n-nodes-flair` from 3.25.76 to 4.6.7; a root `overrides` entry pins
  zod 4.6.7 so `bun.lock` resolves a single copy. The n8n node's schema use
  (`z.object` and `z.string().describe`) is unchanged. Nothing to do on upgrade.
