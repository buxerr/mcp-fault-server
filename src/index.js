const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean"]);
const FAULT_MODES = new Set(["timeout", "malformed", "rpc-error", "tool-error"]);

export class MockConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MockConfigError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON values must contain finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isObject(value)) throw new TypeError("value is not JSON-compatible");
  const normalized = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeJson(value[key]);
  }
  return normalized;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeJson(value));
}

function cloneJson(value) {
  return JSON.parse(stableStringify(value));
}

function validateToolResult(value, toolName) {
  if (!isObject(value) || !Array.isArray(value.content) || value.content.length > 64) {
    throw new MockConfigError("tool result for " + toolName + " must contain a bounded content array");
  }
  const result = { content: [] };
  for (const item of value.content) {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string" || item.text.length > 65_536) {
      throw new MockConfigError("tool result content must contain bounded text entries");
    }
    result.content.push({ type: "text", text: item.text });
  }
  if (value.isError !== undefined) {
    if (typeof value.isError !== "boolean") throw new MockConfigError("tool result isError must be boolean");
    result.isError = value.isError;
  }
  if (value.structuredContent !== undefined) {
    try {
      result.structuredContent = cloneJson(value.structuredContent);
    } catch {
      throw new MockConfigError("structuredContent must be JSON-compatible");
    }
  }
  return result;
}

function validatePropertySchema(schema, toolName, propertyName) {
  if (!isObject(schema) || !SUPPORTED_PROPERTY_TYPES.has(schema.type)) {
    throw new MockConfigError("unsupported schema for " + toolName + "." + propertyName);
  }
  const allowedKeys = new Set(["type", "enum", "minimum", "maximum", "minLength", "maxLength", "description"]);
  if (Object.keys(schema).some((key) => !allowedKeys.has(key))) {
    throw new MockConfigError("schema for " + toolName + "." + propertyName + " uses an unsupported keyword");
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    throw new MockConfigError("property descriptions must be strings");
  }
  if (schema.type === "string") {
    if (schema.minimum !== undefined || schema.maximum !== undefined) {
      throw new MockConfigError("numeric bounds cannot be used for string properties");
    }
    if (schema.minLength !== undefined && (!Number.isInteger(schema.minLength) || schema.minLength < 0)) {
      throw new MockConfigError("string minLength must be a non-negative integer");
    }
    if (schema.maxLength !== undefined && (!Number.isInteger(schema.maxLength) || schema.maxLength < 0)) {
      throw new MockConfigError("string maxLength must be a non-negative integer");
    }
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
      throw new MockConfigError("string minLength cannot exceed maxLength");
    }
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minLength !== undefined || schema.maxLength !== undefined) {
      throw new MockConfigError("string length bounds cannot be used for numeric properties");
    }
    for (const bound of ["minimum", "maximum"]) {
      if (schema[bound] !== undefined && (typeof schema[bound] !== "number" || !Number.isFinite(schema[bound]))) {
        throw new MockConfigError("numeric bounds must be finite");
      }
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
      throw new MockConfigError("numeric minimum cannot exceed maximum");
    }
  }
  if (schema.type === "boolean"
    && ["minimum", "maximum", "minLength", "maxLength"].some((key) => schema[key] !== undefined)) {
    throw new MockConfigError("boolean properties cannot have numeric or string bounds");
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 128) {
      throw new MockConfigError("enum must be a non-empty bounded array");
    }
    const seen = new Set();
    for (const value of schema.enum) {
      if (!matchesType(value, schema.type) || seen.has(stableStringify(value))) {
        throw new MockConfigError("enum values must be unique and match their declared type");
      }
      seen.add(stableStringify(value));
    }
  }
}

function validateTool(value) {
  if (!isObject(value) || !TOOL_NAME.test(value.name ?? "") || typeof value.description !== "string" || value.description.length > 1024) {
    throw new MockConfigError("each tool needs a valid name and bounded description");
  }
  const schema = value.inputSchema;
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) {
    throw new MockConfigError("tool inputSchema must describe an object with properties");
  }
  const allowedKeys = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
  if (Object.keys(schema).some((key) => !allowedKeys.has(key))) {
    throw new MockConfigError("tool inputSchema uses an unsupported keyword");
  }
  for (const key of ["title", "description"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "string" || schema[key].length > 1024)) {
      throw new MockConfigError("tool inputSchema title and description must be bounded strings");
    }
  }
  if (Object.keys(schema.properties).length > 128) {
    throw new MockConfigError("tool inputSchema has too many properties");
  }
  for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
    validatePropertySchema(propertySchema, value.name, propertyName);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
      throw new MockConfigError("required must be an array of property names");
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new MockConfigError("required property names must be unique");
    }
    if (schema.required.some((name) => !Object.hasOwn(schema.properties, name))) {
      throw new MockConfigError("required names must exist in properties");
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw new MockConfigError("additionalProperties must be boolean when supplied");
  }
  let descriptor;
  try {
    descriptor = cloneJson(value);
  } catch {
    throw new MockConfigError("tool descriptor must be JSON-compatible");
  }
  return descriptor;
}

function validateFault(value) {
  if (!isObject(value) || typeof value.method !== "string" || !value.method || value.method.length > 128 || !FAULT_MODES.has(value.mode)) {
    throw new MockConfigError("fault needs a method and a supported mode");
  }
  if (!Number.isInteger(value.occurrence) || value.occurrence < 1 || value.occurrence > 1_000_000) {
    throw new MockConfigError("fault occurrence must be a positive bounded integer");
  }
  if (value.toolName !== undefined && !TOOL_NAME.test(value.toolName)) {
    throw new MockConfigError("fault toolName is invalid");
  }
  if (value.mode === "malformed") {
    const rawLine = value.rawLine ?? '{"jsonrpc":';
    if (typeof rawLine !== "string" || rawLine.length > 65_536 || /[\r\n]/.test(rawLine)) {
      throw new MockConfigError("malformed rawLine must be one bounded line");
    }
    return { method: value.method, toolName: value.toolName, occurrence: value.occurrence, mode: value.mode, rawLine };
  }
  if (value.mode === "rpc-error") {
    if (!Number.isInteger(value.code) || typeof value.message !== "string" || !value.message || value.message.length > 1024) {
      throw new MockConfigError("rpc-error faults require an integer code and message");
    }
    return {
      method: value.method,
      toolName: value.toolName,
      occurrence: value.occurrence,
      mode: value.mode,
      code: value.code,
      message: value.message,
    };
  }
  if (value.mode === "tool-error" && value.message !== undefined
    && (typeof value.message !== "string" || value.message.length > 65_536)) {
    throw new MockConfigError("tool-error message must be a bounded string");
  }
  return {
    method: value.method,
    toolName: value.toolName,
    occurrence: value.occurrence,
    mode: value.mode,
    message: value.message,
  };
}

function matchesType(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function validateArguments(tool, args) {
  if (!isObject(args)) return "tool arguments must be a JSON object";
  const schema = tool.inputSchema;
  for (const requiredName of schema.required ?? []) {
    if (!Object.hasOwn(args, requiredName)) return "missing required property: " + requiredName;
  }
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, name)) {
      if (schema.additionalProperties === false) return "unknown property: " + name;
      continue;
    }
    const propertySchema = schema.properties[name];
    if (!matchesType(value, propertySchema.type)) return "invalid type for property: " + name;
    if (propertySchema.enum && !propertySchema.enum.some((candidate) => Object.is(candidate, value))) {
      return "value is outside enum for property: " + name;
    }
    if (propertySchema.type === "string") {
      const length = [...value].length;
      if (propertySchema.minLength !== undefined && length < propertySchema.minLength) {
        return "value is shorter than minLength for property: " + name;
      }
      if (propertySchema.maxLength !== undefined && length > propertySchema.maxLength) {
        return "value is longer than maxLength for property: " + name;
      }
    }
    if ((propertySchema.type === "number" || propertySchema.type === "integer")
      && propertySchema.minimum !== undefined && value < propertySchema.minimum) {
      return "value is below minimum for property: " + name;
    }
    if ((propertySchema.type === "number" || propertySchema.type === "integer")
      && propertySchema.maximum !== undefined && value > propertySchema.maximum) {
      return "value is above maximum for property: " + name;
    }
  }
  return null;
}

function rpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export class MCPMockServer {
  constructor(options = {}) {
    if (!isObject(options)) throw new MockConfigError("server options must be an object");
    this.name = options.name ?? "mcp-fault-server";
    this.version = options.version ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    if (typeof this.name !== "string" || !this.name || this.name.length > 128) {
      throw new MockConfigError("server name must be a bounded non-empty string");
    }
    if (typeof this.version !== "string" || !this.version || this.version.length > 64) {
      throw new MockConfigError("server version must be a bounded non-empty string");
    }
    if (typeof this.protocolVersion !== "string" || !this.protocolVersion || this.protocolVersion.length > 64) {
      throw new MockConfigError("protocolVersion must be a bounded non-empty string");
    }
    if (!Array.isArray(options.tools ?? []) || (options.tools ?? []).length > 128) {
      throw new MockConfigError("tools must be a bounded array");
    }
    this.tools = (options.tools ?? []).map(validateTool);
    this.toolsByName = new Map();
    for (const tool of this.tools) {
      if (this.toolsByName.has(tool.name)) throw new MockConfigError("duplicate tool name: " + tool.name);
      this.toolsByName.set(tool.name, tool);
    }
    const faultRules = options.faults ?? [];
    if (!Array.isArray(faultRules) || faultRules.length > 1_000) {
      throw new MockConfigError("faults must be a bounded array");
    }
    this.faults = faultRules.map(validateFault);
    const faultKeys = new Set();
    for (const fault of this.faults) {
      const key = fault.method + "\0" + (fault.toolName ?? "") + "\0" + fault.occurrence;
      if (faultKeys.has(key)) throw new MockConfigError("duplicate fault rule");
      faultKeys.add(key);
      if (fault.toolName && !this.toolsByName.has(fault.toolName)) {
        throw new MockConfigError("fault references an unknown tool: " + fault.toolName);
      }
    }
    const configuredResults = options.toolResults ?? {};
    if (!isObject(configuredResults)) throw new MockConfigError("toolResults must be an object");
    this.toolResults = new Map();
    for (const [toolName, configured] of Object.entries(configuredResults)) {
      if (!this.toolsByName.has(toolName)) throw new MockConfigError("tool result references an unknown tool: " + toolName);
      const values = Array.isArray(configured) ? configured : [configured];
      if (values.length === 0 || values.length > 1_000) throw new MockConfigError("tool result sequence must be non-empty and bounded");
      this.toolResults.set(toolName, values.map((result) => validateToolResult(result, toolName)));
    }
    this.occurrences = new Map();
  }

  handleLine(line) {
    if (typeof line !== "string") throw new TypeError("line must be a string");
    if (line.length > 1_048_576) return stableStringify(rpcError(null, -32700, "Request line is too large."));
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return stableStringify(rpcError(null, -32700, "Parse error"));
    }
    if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || !request.method) {
      return stableStringify(rpcError(null, -32600, "Invalid Request"));
    }
    const hasId = Object.hasOwn(request, "id");
    if (hasId && !(typeof request.id === "string" || (typeof request.id === "number" && Number.isFinite(request.id)))) {
      return stableStringify(rpcError(null, -32600, "Invalid Request"));
    }
    const id = hasId ? request.id : null;
    const toolName = request.method === "tools/call" && isObject(request.params) && typeof request.params.name === "string"
      ? request.params.name
      : undefined;
    const fault = this.matchFault(request.method, toolName);
    if (fault) {
      if (!hasId || fault.mode === "timeout") return null;
      if (fault.mode === "malformed") return fault.rawLine;
      if (fault.mode === "rpc-error") {
        return stableStringify(rpcError(id, fault.code, fault.message, { retryable: false }));
      }
      if (fault.mode === "tool-error") {
        return stableStringify(rpcResponse(id, {
          content: [{ type: "text", text: fault.message ?? "Injected tool failure" }],
          isError: true,
        }));
      }
    }
    if (!hasId) {
      this.dispatch(request.method, request.params);
      return null;
    }
    try {
      const result = this.dispatch(request.method, request.params);
      return stableStringify(rpcResponse(id, result === undefined ? {} : result));
    } catch (error) {
      if (error instanceof RpcFault) {
        return stableStringify(rpcError(id, error.code, error.message, error.data));
      }
      return stableStringify(rpcError(id, -32603, "Internal error"));
    }
  }

  matchFault(method, toolName) {
    const methodOccurrence = this.incrementOccurrence(method + "\0*");
    const toolOccurrence = toolName === undefined
      ? methodOccurrence
      : this.incrementOccurrence(method + "\0" + toolName);
    const matches = (fault) => {
      if (fault.method !== method) return false;
      if (fault.toolName !== undefined) {
        return fault.toolName === toolName && fault.occurrence === toolOccurrence;
      }
      return fault.occurrence === methodOccurrence;
    };
    return this.faults.find((fault) => fault.toolName !== undefined && matches(fault))
      ?? this.faults.find((fault) => fault.toolName === undefined && matches(fault));
  }

  dispatch(method, params) {
    if (method === "notifications/initialized") return undefined;
    if (method === "ping") return {};
    if (method === "initialize") {
      if (!isObject(params) || typeof params.protocolVersion !== "string") {
        throw new RpcFault(-32602, "Invalid initialize parameters");
      }
      return {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: this.name, version: this.version },
      };
    }
    if (method === "tools/list") {
      return { tools: this.tools.map((tool) => cloneJson(tool)) };
    }
    if (method === "tools/call") return this.callTool(params);
    throw new RpcFault(-32601, "Method not found");
  }

  callTool(params) {
    if (!isObject(params) || typeof params.name !== "string") {
      throw new RpcFault(-32602, "Invalid tool call parameters");
    }
    const tool = this.toolsByName.get(params.name);
    if (!tool) throw new RpcFault(-32602, "Unknown tool: " + params.name);
    const args = params.arguments ?? {};
    const argumentError = validateArguments(tool, args);
    if (argumentError) throw new RpcFault(-32602, argumentError);
    const occurrence = this.incrementOccurrence("tool-result\0" + tool.name);
    const configured = this.toolResults.get(tool.name);
    if (!configured) {
      return { content: [{ type: "text", text: stableStringify(args) }] };
    }
    return cloneJson(configured[Math.min(occurrence - 1, configured.length - 1)]);
  }

  incrementOccurrence(key) {
    const next = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, next);
    return next;
  }
}

class RpcFault extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
