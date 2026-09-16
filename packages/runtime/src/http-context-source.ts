import type { ContextSource, ExternalContextUnit } from "@llmovoice/core";

export interface HttpContextSourceInput {
  userId: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
}

export interface HttpContextSourceOptions {
  name: string;
  endpoint: string | ((input: HttpContextSourceInput) => string);
  headers?: HeadersInit | ((input: HttpContextSourceInput) => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  mapResponse?: (body: unknown, input: HttpContextSourceInput) => ExternalContextUnit[] | Promise<ExternalContextUnit[]>;
  fetch?: typeof fetch;
  appendQuery?: boolean;
}

function defaultMap(body: unknown): ExternalContextUnit[] {
  const units = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "units" in body && Array.isArray(body.units)
      ? body.units
      : [];
  return units.filter((unit): unit is ExternalContextUnit => Boolean(
    unit && typeof unit === "object"
      && "id" in unit && typeof unit.id === "string"
      && "source" in unit && typeof unit.source === "string"
      && "content" in unit && typeof unit.content === "string",
  ));
}

export class HttpContextSource implements ContextSource {
  readonly name: string;

  constructor(private readonly options: HttpContextSourceOptions) {
    this.name = options.name.trim();
    if (!this.name) throw new Error("HttpContextSource requires a name.");
  }

  async retrieve(input: HttpContextSourceInput): Promise<ExternalContextUnit[]> {
    const endpoint = typeof this.options.endpoint === "function" ? this.options.endpoint(input) : this.options.endpoint;
    const target = this.target(endpoint, input);
    const headers = typeof this.options.headers === "function"
      ? await this.options.headers(input)
      : this.options.headers;
    const response = await (this.options.fetch ?? fetch)(target, {
      method: "GET",
      ...(headers ? { headers } : {}),
      credentials: this.options.credentials ?? "same-origin",
      cache: "no-store",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new Error(`Context source ${this.name} returned HTTP ${response.status}.`);
    const body: unknown = await response.json();
    const units = await (this.options.mapResponse ?? defaultMap)(body, input);
    return units.slice(0, Math.max(0, input.limit));
  }

  private target(endpoint: string, input: HttpContextSourceInput): string {
    if (this.options.appendQuery === false) return endpoint;
    const absolute = /^https?:\/\//i.test(endpoint);
    const url = new URL(endpoint, absolute ? undefined : "http://llmovoice.local");
    url.searchParams.set("q", input.query);
    url.searchParams.set("limit", String(input.limit));
    return absolute ? url.toString() : `${url.pathname}${url.search}`;
  }
}
