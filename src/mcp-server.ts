// Countinghouse MCP server (stdio): the ERP as tools for an AI operator.
// A thin client over the same HTTP API the UI uses — same auth, same
// validation, same events underneath. Configure with:
//   COUNTINGHOUSE_URL   (default http://localhost:5310)
//   COUNTINGHOUSE_TOKEN (default dev-bigsur — the tenant's API token)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS, type ApiFn } from './mcp-tools.js'

const BASE = process.env.COUNTINGHOUSE_URL ?? 'http://localhost:5310'
const TOKEN = process.env.COUNTINGHOUSE_TOKEN ?? 'dev-bigsur'

const api: ApiFn = async (path, init = {}) => {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`)
  return body
}

const server = new McpServer({ name: 'countinghouse', version: '0.1.0' })

for (const tool of TOOLS) {
  server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: await tool.run(args, api) }] }
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      }
    }
  })
}

await server.connect(new StdioServerTransport())
