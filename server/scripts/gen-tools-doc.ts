// scripts/gen-tools-doc.ts
// Gera ../TOOLS.md a partir das definições reais das tools (src/tools/registry.ts).
// Uso: npm run docs:tools  — rode sempre que mudar uma tool, para o documento não divergir do código.

import fs from "fs";
import path from "path";
import { collectTools, toolInputJsonSchema, SERVER_INSTRUCTIONS, TOOL_GROUPS } from "../src/tools/registry";

type JsonSchema = Record<string, any>;

function typeLabel(s: JsonSchema): string {
  if (!s || Object.keys(s).length === 0) return "qualquer";
  if (s.enum) return s.enum.map((v: unknown) => `\`${JSON.stringify(v).replace(/"/g, "'")}\``).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeLabel).join(" ou ");
  switch (s.type) {
    case "array":
      return `${typeLabel(s.items ?? {})}[]`;
    case "object":
      return s.properties ? "objeto" : "objeto (chave → valor)";
    case "integer":
      return "inteiro";
    case "number":
      return "número";
    case "string":
      return "texto";
    case "boolean":
      return "booleano";
    default:
      return String(s.type ?? "qualquer");
  }
}

function esc(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Linhas da tabela de parâmetros; objetos aninhados viram linhas `pai.filho`. */
function paramRows(schema: JsonSchema, prefix = ""): string[] {
  const rows: string[] = [];
  const required: string[] = schema.required ?? [];
  for (const [name, prop] of Object.entries<JsonSchema>(schema.properties ?? {})) {
    const full = prefix + name;
    const req = required.includes(name) ? "**sim**" : "não";
    rows.push(`| \`${full}\` | ${esc(typeLabel(prop))} | ${req} | ${esc(prop.description)} |`);
    const nested = prop.type === "object" && prop.properties ? prop : prop.type === "array" && prop.items?.properties ? prop.items : null;
    if (nested) rows.push(...paramRows(nested, full + (prop.type === "array" ? "[]." : ".")));
  }
  return rows;
}

function exampleArgs(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sample = (p: JsonSchema): unknown => {
    if (p.enum) return p.enum[0];
    switch (p.type) {
      case "integer":
      case "number":
        return 239256;
      case "boolean":
        return true;
      case "array":
        return [];
      case "object":
        return {};
      default:
        return "...";
    }
  };
  for (const name of schema.required ?? []) out[name] = sample(schema.properties[name]);
  return out;
}

const tools = collectTools();
const lines: string[] = [];

lines.push("# Firecast MCP — referência das tools");
lines.push("");
lines.push("> Gerado automaticamente por `npm run docs:tools` (server/scripts/gen-tools-doc.ts) a partir das definições em `server/src/tools/`. Não edite à mão: altere as descrições no código e gere de novo.");
lines.push("");
lines.push(`Total: ${tools.length} tools. Todas recebem um objeto JSON de argumentos e devolvem JSON em texto.`);
lines.push("");
lines.push("## Visão geral (instruções enviadas ao modelo)");
lines.push("");
lines.push("```text");
lines.push(SERVER_INSTRUCTIONS);
lines.push("```");
lines.push("");
lines.push("## Índice");
lines.push("");
for (const g of TOOL_GROUPS) {
  const names = tools.filter((t) => t.group === g.title).map((t) => `[\`${t.name}\`](#${t.name})`);
  lines.push(`- **${g.title}**: ${names.join(", ")}`);
}
lines.push("");

for (const g of TOOL_GROUPS) {
  lines.push(`## ${g.title}`);
  lines.push("");
  for (const t of tools.filter((x) => x.group === g.title)) {
    const schema = toolInputJsonSchema(t.shape) as JsonSchema;
    lines.push(`### ${t.name}`);
    lines.push("");
    lines.push(t.description);
    lines.push("");
    const rows = paramRows(schema);
    if (rows.length === 0) {
      lines.push("_Sem parâmetros._");
    } else {
      lines.push("| Parâmetro | Tipo | Obrigatório | Descrição |");
      lines.push("|---|---|---|---|");
      lines.push(...rows);
    }
    lines.push("");
    lines.push("Chamada mínima:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify({ name: t.name, arguments: exampleArgs(schema) }));
    lines.push("```");
    lines.push("");
  }
}

const outPath = path.resolve(__dirname, "..", "..", "TOOLS.md");
fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
process.stderr.write(`TOOLS.md gerado: ${outPath} (${tools.length} tools)\n`);
