#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { z } from "zod";

// Configuração base da API Legado do Filazero (pode vir de variáveis de ambiente depois)
const FILAZERO_API_URL = process.env.FILAZERO_API_URL || "https://api.filazero.net/v1";

// 1. Inicialização do Servidor MCP
const server = new Server(
  {
    name: "Filazero-MCP-Server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Schema de validação Zod para os argumentos da IA
const EtaArgumentsSchema = z.object({
  unidadeId: z.string().describe("O ID da unidade de atendimento (ex: 'hospital-central')"),
  filaId: z.string().describe("O identificador da fila específica (ex: 'triagem')"),
});

// 2. Exposição do Catálogo de Ferramentas (Discovery)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "consultar_tempo_espera",
        description: "Consulta o tempo estimado de atendimento (ETA) dinâmico em uma fila virtual da plataforma Filazero.",
        inputSchema: {
          type: "object",
          properties: {
            unidadeId: {
              type: "string",
              description: "O ID da unidade de atendimento",
            },
            filaId: {
              type: "string",
              description: "O identificador da fila específica",
            },
          },
          required: ["unidadeId", "filaId"],
        },
      },
    ],
  };
});

// 3. Tradução Inteligente: Interceptando a chamada da IA e convertendo para REST
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "consultar_tempo_espera") {
    try {
      // Valida estritamente o que a IA enviou para evitar erros no backend
      const { unidadeId, filaId } = EtaArgumentsSchema.parse(args);

      // Simulação da chamada Axios para a API REST legado do Filazero
      // const response = await axios.get(`${FILAZERO_API_URL}/unidades/${unidadeId}/filas/${filaId}/eta`);
      // const etaData = response.data;

      // Mock temporário para testarmos a comunicação antes de plugar a API real
      const etaData = {
        status: "success",
        data: {
          tempoEstimadoMinutos: 45,
          pessoasNaFrente: 12,
          mensagem: "Fluxo intenso. Atendimento previsto para 45 minutos."
        }
      };

      // Formatação padronizada da resposta para a IA
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(etaData, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Parâmetros inválidos enviados pela IA: ${error.errors.map(e => e.message).join(", ")}`);
      }
      throw new Error(`Falha ao conectar com a API Filazero: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
    }
  }

  throw new Error(`Ferramenta desconhecida: ${name}`);
});

// 4. Inicialização da Comunicação via Stdio (Padrão para IAs Desktop como Claude/Cursor)
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Filazero MCP Server rodando e aguardando conexões via stdio...");
}

run().catch((error) => {
  console.error("Erro fatal ao iniciar o servidor MCP:", error);
  process.exit(1);
});