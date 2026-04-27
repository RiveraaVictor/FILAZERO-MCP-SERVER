#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { type AxiosResponse } from "axios";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_FILAZERO_API_URL = "https://api.staging.filazero.net";
const DEFAULT_FILAZERO_APP_ORIGIN = "https://app.filazero.net";
const DEFAULT_CACHE_TTL_COMPANIES_SECONDS = 300;

const FILAZERO_API_URL = normalizeUrl(
  process.env.FILAZERO_API_URL || DEFAULT_FILAZERO_API_URL
);
const FILAZERO_APP_ORIGIN = normalizeUrl(
  process.env.FILAZERO_APP_ORIGIN || DEFAULT_FILAZERO_APP_ORIGIN
);
const CACHE_TTL_COMPANIES_SECONDS = getCacheTtlCompaniesSeconds();

type ApiMessage = {
  type?: unknown;
  description?: unknown;
  message?: unknown;
};

type NormalizedCompany = {
  id: string | number;
  slug: string;
  name: string;
};

type CompaniesCache = {
  expiresAt: number;
  companies: NormalizedCompany[];
};

let companiesCache: CompaniesCache | null = null;

class FilazeroBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilazeroBusinessError";
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getCacheTtlCompaniesSeconds(): number {
  const rawTtl = process.env.CACHE_TTL_COMPANIES;

  if (!rawTtl) {
    return DEFAULT_CACHE_TTL_COMPANIES_SECONDS;
  }

  const parsedTtl = Number(rawTtl);

  if (!Number.isFinite(parsedTtl) || parsedTtl < 0) {
    return DEFAULT_CACHE_TTL_COMPANIES_SECONDS;
  }

  return parsedTtl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildFilazeroPublicHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Origin: FILAZERO_APP_ORIGIN,
    Referer: `${FILAZERO_APP_ORIGIN}/`,
    "User-Agent": "MCP-Server-FilaZero/1.0",
    DNT: "1",
  };
}

function getBusinessErrorDescription(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    return null;
  }

  const errorMessage = payload.messages.find((message): message is ApiMessage => {
    return isRecord(message) && message.type === "ERROR";
  });

  if (!errorMessage) {
    return null;
  }

  if (typeof errorMessage.description === "string") {
    return errorMessage.description;
  }

  if (typeof errorMessage.message === "string") {
    return errorMessage.message;
  }

  return "Erro de negocio retornado pela API Filazero.";
}

function throwIfBusinessError(payload: unknown): void {
  const businessErrorDescription = getBusinessErrorDescription(payload);

  if (businessErrorDescription) {
    throw new FilazeroBusinessError(businessErrorDescription);
  }
}

function extractCompaniesPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      return payload.data;
    }

    if (isRecord(payload.data) && Array.isArray(payload.data.companies)) {
      return payload.data.companies;
    }

    if (Array.isArray(payload.companies)) {
      return payload.companies;
    }
  }

  throw new Error("Resposta inesperada da API Filazero ao listar empresas.");
}

function normalizeCompany(company: unknown): NormalizedCompany {
  if (!isRecord(company)) {
    throw new Error("Empresa retornada pela API Filazero em formato invalido.");
  }

  const { id, slug, name } = company;

  if (
    (typeof id !== "string" && typeof id !== "number") ||
    typeof slug !== "string" ||
    typeof name !== "string"
  ) {
    throw new Error("Empresa retornada pela API Filazero sem id, slug ou name valido.");
  }

  return {
    id,
    slug,
    name,
  };
}

function formatErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const businessErrorDescription = getBusinessErrorDescription(error.response?.data);

    if (businessErrorDescription) {
      return businessErrorDescription;
    }

    if (error.response?.status) {
      return `HTTP ${error.response.status}: ${error.message}`;
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Erro desconhecido";
}

async function fetchCompaniesFromApi(): Promise<NormalizedCompany[]> {
  let response: AxiosResponse<unknown>;

  try {
    response = await axios.get<unknown>(`${FILAZERO_API_URL}/api/companies`, {
      headers: buildFilazeroPublicHeaders(),
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const businessErrorDescription = getBusinessErrorDescription(error.response?.data);

      if (businessErrorDescription) {
        throw new FilazeroBusinessError(businessErrorDescription);
      }
    }

    throw error;
  }

  throwIfBusinessError(response.data);

  return extractCompaniesPayload(response.data).map(normalizeCompany);
}

async function listCompanies(): Promise<NormalizedCompany[]> {
  const now = Date.now();

  if (companiesCache && companiesCache.expiresAt > now) {
    return companiesCache.companies;
  }

  const companies = await fetchCompaniesFromApi();
  companiesCache = {
    companies,
    expiresAt: now + CACHE_TTL_COMPANIES_SECONDS * 1000,
  };

  return companies;
}

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

const EtaArgumentsSchema = z.object({
  unidadeId: z.string().describe("O ID da unidade de atendimento (ex: 'hospital-central')"),
  filaId: z.string().describe("O identificador da fila especifica (ex: 'triagem')"),
});
const ListCompaniesArgumentsSchema = z.object({}).strict();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_companies",
        description:
          "Lista publicamente as empresas da plataforma Filazero. Use o campo slug retornado na proxima tool get_company_services.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "consultar_tempo_espera",
        description:
          "Consulta o tempo estimado de atendimento (ETA) dinamico em uma fila virtual da plataforma Filazero.",
        inputSchema: {
          type: "object",
          properties: {
            unidadeId: {
              type: "string",
              description: "O ID da unidade de atendimento",
            },
            filaId: {
              type: "string",
              description: "O identificador da fila especifica",
            },
          },
          required: ["unidadeId", "filaId"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_companies") {
    try {
      ListCompaniesArgumentsSchema.parse(args ?? {});
      const companies = await listCompanies();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                companies,
                nextToolHint: "Use o slug da empresa na proxima tool get_company_services.",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error("A tool list_companies nao aceita parametros de entrada.");
      }

      if (error instanceof FilazeroBusinessError) {
        throw error;
      }

      throw new Error(`Falha ao listar empresas na API Filazero: ${formatErrorMessage(error)}`);
    }
  }

  if (name === "consultar_tempo_espera") {
    try {
      const { unidadeId, filaId } = EtaArgumentsSchema.parse(args);

      // Mock temporario para testarmos a comunicacao antes de plugar a API real.
      const etaData = {
        status: "success",
        data: {
          unidadeId,
          filaId,
          tempoEstimadoMinutos: 45,
          pessoasNaFrente: 12,
          mensagem: "Fluxo intenso. Atendimento previsto para 45 minutos.",
        },
      };

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
        throw new Error(
          `Parametros invalidos enviados pela IA: ${error.errors
            .map((issue) => issue.message)
            .join(", ")}`
        );
      }

      throw new Error(
        `Falha ao conectar com a API Filazero: ${
          error instanceof Error ? error.message : "Erro desconhecido"
        }`
      );
    }
  }

  throw new Error(`Ferramenta desconhecida: ${name}`);
});

async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Filazero MCP Server rodando e aguardando conexoes via stdio...");
}

run().catch((error: unknown) => {
  console.error("Erro fatal ao iniciar o servidor MCP:", error);
  process.exit(1);
});
