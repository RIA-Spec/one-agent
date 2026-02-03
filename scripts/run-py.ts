import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getServer } from "../src/tools.js";

const pyFile = process.argv[2];

if (!pyFile) {
  console.error("Usage: pnpm run-py <file.py>");
  console.error("\nExamples:");
  console.error("  pnpm run-py examples/simple_calc.py");
  console.error("  pnpm run-py examples/use_ai.py");
  console.error("  pnpm run-py examples/pandas_demo.py");
  process.exit(1);
}

const filePath = resolve(process.cwd(), pyFile);
let code;

try {
  code = readFileSync(filePath, "utf-8");
} catch (error) {
  console.error(`Error reading file: ${filePath}`);
  console.error(error);
  process.exit(1);
}

const server = await getServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);

const client = new Client({
  name: "run-py-cli",
  version: "1.0.0",
});

await client.connect(clientTransport);

try {
  const result = await client.callTool({
    name: "run",
    arguments: { code },
  }, undefined, { timeout: 600_000 });

  if (result.content) {
    console.log(result);
  } else {
    console.log("(no output)");
  }
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
} finally {
  await client.close();
}
