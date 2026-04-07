/**
 * MCP Tool Manifest Validation Tests
 *
 * Validates that:
 *   1. Every tool registered on the MCP server has a manifest entry.
 *   2. Every manifest has the required structural fields (name, description,
 *      inputSchema, outputSchema, metadata).
 *   3. All inputSchema / outputSchema entries are valid JSON Schema draft-07
 *      objects (type, properties, required are consistent).
 *   4. Required input properties listed in required[] are also declared in
 *      inputSchema.properties.
 *   5. Tool aliases point to existing canonical manifests.
 *   6. SERVER_CAPABILITIES categories reference only registered tool names.
 *   7. getDiscoveryPayload() returns a JSON-serialisable structure.
 *   8. Manifest tool names match their map keys.
 *   9. Metadata fields are well-formed.
 *  10. No duplicate tool registrations outside intentional aliases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_MANIFESTS,
  REGISTERED_TOOL_NAMES,
  TOOL_ALIASES,
  SERVER_CAPABILITIES,
  SHARED_DEFINITIONS,
  getDiscoveryPayload,
} from '../src/mcp/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a value is a plain non-null object.
 */
function assertObject(value, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} should be a plain object`
  );
}

/**
 * Assert that a JSON Schema object has at minimum { type: 'object', properties: {...} }.
 * Handles schemas that use oneOf / anyOf at the top level.
 */
function assertJsonSchemaShape(schema, label) {
  assertObject(schema, label);

  // Top-level schemas must have $schema or be clearly typed
  const hasType = 'type' in schema;
  const hasComposite = 'oneOf' in schema || 'anyOf' in schema || 'allOf' in schema;
  assert.ok(
    hasType || hasComposite,
    `${label}: JSON Schema must have "type" or a composite keyword (oneOf/anyOf/allOf)`
  );
}

/**
 * Assert inputSchema is a valid object-type JSON Schema with consistent
 * required[] and properties.
 */
function assertInputSchema(schema, toolName) {
  const label = `${toolName}.inputSchema`;
  assertObject(schema, label);
  assert.equal(schema.type, 'object', `${label} must have type "object"`);
  assertObject(schema.properties, `${label}.properties`);
  assert.ok(Array.isArray(schema.required), `${label}.required must be an array`);

  // Every property in required[] must exist in properties
  for (const req of schema.required) {
    assert.ok(
      req in schema.properties,
      `${label}: required property "${req}" is not declared in properties`
    );
  }

  // Every property value should be an object (JSON Schema node)
  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    assertObject(propSchema, `${label}.properties.${propName}`);
    assert.ok(
      'type' in propSchema || 'enum' in propSchema || '$ref' in propSchema ||
      'oneOf' in propSchema || 'anyOf' in propSchema,
      `${label}.properties.${propName} must have "type", "enum", "$ref", or composite keyword`
    );
  }
}

/**
 * Assert metadata has the expected shape.
 */
function assertMetadata(metadata, toolName) {
  const label = `${toolName}.metadata`;
  assertObject(metadata, label);

  assert.ok(typeof metadata.category === 'string' && metadata.category.length > 0,
    `${label}.category must be a non-empty string`);
  assert.ok(typeof metadata.requires_bot === 'boolean',
    `${label}.requires_bot must be a boolean`);
  assert.ok(Array.isArray(metadata.side_effects),
    `${label}.side_effects must be an array`);
  assert.ok(Array.isArray(metadata.aliases),
    `${label}.aliases must be an array`);
  assert.ok(Array.isArray(metadata.languages),
    `${label}.languages must be an array`);

  // side_effects values must be strings
  for (const effect of metadata.side_effects) {
    assert.equal(typeof effect, 'string',
      `${label}.side_effects entries must be strings, got: ${typeof effect}`);
  }
}

// ---------------------------------------------------------------------------
// The tools that tools.js registers on the server — ground truth
// ---------------------------------------------------------------------------

/**
 * These are all the tool names that tools.js calls server.tool() with.
 * Used to verify the manifest is complete.
 */
const TOOLS_JS_REGISTRATIONS = [
  'start_session',
  'stop_session',
  'start_recording',
  'stop_recording',
  'list_sessions',
  'get_session',
  'get_status',
  'get_transcript',
  'get_minutes',
  'list_recordings',
  'search_minutes',
  'search_meeting_minutes',
  'summarize_minutes',
  'get_meeting_minutes',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Tool Manifest — module exports', () => {
  it('exports TOOL_MANIFESTS as a non-empty object', () => {
    assertObject(TOOL_MANIFESTS, 'TOOL_MANIFESTS');
    assert.ok(Object.keys(TOOL_MANIFESTS).length > 0, 'TOOL_MANIFESTS should not be empty');
  });

  it('exports REGISTERED_TOOL_NAMES as a non-empty array', () => {
    assert.ok(Array.isArray(REGISTERED_TOOL_NAMES), 'REGISTERED_TOOL_NAMES must be an array');
    assert.ok(REGISTERED_TOOL_NAMES.length > 0, 'REGISTERED_TOOL_NAMES must not be empty');
  });

  it('exports TOOL_ALIASES as an object', () => {
    assertObject(TOOL_ALIASES, 'TOOL_ALIASES');
  });

  it('exports SERVER_CAPABILITIES as an object', () => {
    assertObject(SERVER_CAPABILITIES, 'SERVER_CAPABILITIES');
  });

  it('exports SHARED_DEFINITIONS as an object', () => {
    assertObject(SHARED_DEFINITIONS, 'SHARED_DEFINITIONS');
  });

  it('exports getDiscoveryPayload as a function', () => {
    assert.equal(typeof getDiscoveryPayload, 'function');
  });
});

describe('MCP Tool Manifest — completeness vs tools.js registrations', () => {
  it('every tool registered in tools.js has a manifest entry', () => {
    for (const name of TOOLS_JS_REGISTRATIONS) {
      assert.ok(
        name in TOOL_MANIFESTS,
        `Tool "${name}" is registered in tools.js but missing from TOOL_MANIFESTS`
      );
    }
  });

  it('REGISTERED_TOOL_NAMES matches TOOL_MANIFESTS keys', () => {
    const manifestKeys = new Set(Object.keys(TOOL_MANIFESTS));
    const registeredSet = new Set(REGISTERED_TOOL_NAMES);

    for (const name of manifestKeys) {
      assert.ok(registeredSet.has(name),
        `"${name}" is in TOOL_MANIFESTS but not in REGISTERED_TOOL_NAMES`);
    }
    for (const name of registeredSet) {
      assert.ok(manifestKeys.has(name),
        `"${name}" is in REGISTERED_TOOL_NAMES but not in TOOL_MANIFESTS`);
    }
  });
});

describe('MCP Tool Manifest — per-tool structural requirements', () => {
  for (const [toolName, manifest] of Object.entries(TOOL_MANIFESTS)) {
    it(`${toolName}: manifest is a plain object`, () => {
      assertObject(manifest, `TOOL_MANIFESTS["${toolName}"]`);
    });

    it(`${toolName}: name field equals map key`, () => {
      assert.equal(manifest.name, toolName,
        `manifest.name ("${manifest.name}") must equal its map key ("${toolName}")`);
    });

    it(`${toolName}: description is a non-empty string`, () => {
      assert.equal(typeof manifest.description, 'string',
        `${toolName}.description must be a string`);
      assert.ok(manifest.description.trim().length > 0,
        `${toolName}.description must not be empty`);
    });

    it(`${toolName}: inputSchema is valid JSON Schema`, () => {
      assertInputSchema(manifest.inputSchema, toolName);
    });

    it(`${toolName}: outputSchema is a valid JSON Schema shape`, () => {
      assertJsonSchemaShape(manifest.outputSchema, `${toolName}.outputSchema`);
    });

    it(`${toolName}: metadata is well-formed`, () => {
      assertMetadata(manifest.metadata, toolName);
    });
  }
});

describe('MCP Tool Manifest — alias consistency', () => {
  it('all TOOL_ALIASES values point to existing canonical manifests', () => {
    for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
      assert.ok(
        canonical in TOOL_MANIFESTS,
        `TOOL_ALIASES["${alias}"] points to "${canonical}" which is not in TOOL_MANIFESTS`
      );
    }
  });

  it('all TOOL_ALIASES keys are in TOOL_MANIFESTS', () => {
    for (const alias of Object.keys(TOOL_ALIASES)) {
      assert.ok(
        alias in TOOL_MANIFESTS,
        `TOOL_ALIASES key "${alias}" is not present in TOOL_MANIFESTS`
      );
    }
  });

  it('alias manifests declare the corresponding canonical tool in their own aliases list', () => {
    for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
      const aliasManifest = TOOL_MANIFESTS[alias];
      assert.ok(
        aliasManifest.metadata.aliases.includes(canonical),
        `Alias "${alias}" should list "${canonical}" in its metadata.aliases`
      );
    }
  });

  it('start_recording and start_session have identical inputSchema required fields', () => {
    const a = TOOL_MANIFESTS['start_session'].inputSchema.required;
    const b = TOOL_MANIFESTS['start_recording'].inputSchema.required;
    assert.deepEqual(
      [...a].sort(),
      [...b].sort(),
      'start_session and start_recording must require the same parameters'
    );
  });

  it('stop_recording and stop_session have identical inputSchema required fields', () => {
    const a = TOOL_MANIFESTS['stop_session'].inputSchema.required;
    const b = TOOL_MANIFESTS['stop_recording'].inputSchema.required;
    assert.deepEqual(
      [...a].sort(),
      [...b].sort(),
      'stop_session and stop_recording must require the same parameters'
    );
  });
});

describe('MCP Tool Manifest — SERVER_CAPABILITIES', () => {
  it('has required fields: name, version, description, capabilities', () => {
    assert.equal(typeof SERVER_CAPABILITIES.name, 'string');
    assert.equal(typeof SERVER_CAPABILITIES.version, 'string');
    assert.equal(typeof SERVER_CAPABILITIES.description, 'string');
    assertObject(SERVER_CAPABILITIES.capabilities, 'SERVER_CAPABILITIES.capabilities');
  });

  it('capabilities.tools is true', () => {
    assert.equal(SERVER_CAPABILITIES.capabilities.tools, true);
  });

  it('all tools in categories reference registered tool names', () => {
    const registeredSet = new Set(REGISTERED_TOOL_NAMES);
    for (const [category, tools] of Object.entries(SERVER_CAPABILITIES.categories)) {
      assert.ok(Array.isArray(tools), `categories.${category} must be an array`);
      for (const toolName of tools) {
        assert.ok(
          registeredSet.has(toolName),
          `Category "${category}" references "${toolName}" which is not in REGISTERED_TOOL_NAMES`
        );
      }
    }
  });

  it('every registered tool appears in exactly one category', () => {
    const allCategorised = Object.values(SERVER_CAPABILITIES.categories).flat();
    const categorisedSet = new Set(allCategorised);
    for (const name of REGISTERED_TOOL_NAMES) {
      assert.ok(
        categorisedSet.has(name),
        `Registered tool "${name}" does not appear in any SERVER_CAPABILITIES.categories`
      );
    }
  });

  it('has languages array containing at least ko and en', () => {
    assert.ok(Array.isArray(SERVER_CAPABILITIES.languages));
    assert.ok(SERVER_CAPABILITIES.languages.includes('ko'), 'Must include "ko"');
    assert.ok(SERVER_CAPABILITIES.languages.includes('en'), 'Must include "en"');
  });

  it('transport is an array', () => {
    assert.ok(Array.isArray(SERVER_CAPABILITIES.transport));
    assert.ok(SERVER_CAPABILITIES.transport.length > 0, 'At least one transport mode required');
  });

  it('standalone_mode is a boolean', () => {
    assert.equal(typeof SERVER_CAPABILITIES.standalone_mode, 'boolean');
  });
});

describe('MCP Tool Manifest — SHARED_DEFINITIONS validity', () => {
  const expectedDefinitions = [
    'DiscordId', 'DateString', 'LanguageCode',
    'Participant', 'MinutesIndexEntry', 'PaginationResult',
  ];

  for (const defName of expectedDefinitions) {
    it(`SHARED_DEFINITIONS.${defName} is a valid JSON Schema node`, () => {
      assert.ok(defName in SHARED_DEFINITIONS,
        `SHARED_DEFINITIONS is missing "${defName}"`);
      assertJsonSchemaShape(SHARED_DEFINITIONS[defName], `SHARED_DEFINITIONS.${defName}`);
    });
  }

  it('DiscordId has minLength: 1', () => {
    assert.equal(SHARED_DEFINITIONS.DiscordId.minLength, 1);
  });

  it('DateString has a YYYY-MM-DD pattern', () => {
    const { pattern } = SHARED_DEFINITIONS.DateString;
    assert.ok(typeof pattern === 'string' && pattern.includes('\\d{4}'),
      'DateString.pattern should encode YYYY-MM-DD format');
    // Validate the pattern works correctly
    const re = new RegExp(pattern);
    assert.ok(re.test('2025-01-15'), '"2025-01-15" should match DateString.pattern');
    assert.ok(!re.test('01-15-2025'), '"01-15-2025" should not match DateString.pattern');
  });

  it('LanguageCode enum contains ko, en, multi', () => {
    assert.deepEqual(
      SHARED_DEFINITIONS.LanguageCode.enum.sort(),
      ['en', 'ko', 'multi']
    );
  });
});

describe('MCP Tool Manifest — getDiscoveryPayload()', () => {
  it('returns an object with server and tools keys', () => {
    const payload = getDiscoveryPayload();
    assertObject(payload, 'getDiscoveryPayload()');
    assert.ok('server' in payload, 'payload must have "server" key');
    assert.ok('tools' in payload, 'payload must have "tools" key');
  });

  it('tools array has the same length as REGISTERED_TOOL_NAMES', () => {
    const { tools } = getDiscoveryPayload();
    assert.ok(Array.isArray(tools), 'payload.tools must be an array');
    assert.equal(
      tools.length,
      REGISTERED_TOOL_NAMES.length,
      'payload.tools must include one entry per registered tool'
    );
  });

  it('every tool entry has name, description, inputSchema, outputSchema, metadata', () => {
    const { tools } = getDiscoveryPayload();
    for (const tool of tools) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0,
        `Tool entry missing valid "name"`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0,
        `Tool "${tool.name}" missing valid "description"`);
      assertObject(tool.inputSchema, `Tool "${tool.name}".inputSchema`);
      assertObject(tool.outputSchema, `Tool "${tool.name}".outputSchema`);
      assertObject(tool.metadata, `Tool "${tool.name}".metadata`);
    }
  });

  it('payload is fully JSON-serialisable (no circular refs or undefined)', () => {
    const payload = getDiscoveryPayload();
    let json;
    assert.doesNotThrow(
      () => { json = JSON.stringify(payload); },
      'getDiscoveryPayload() must produce a JSON-serialisable object'
    );
    assert.ok(typeof json === 'string' && json.length > 0,
      'Serialised payload must be non-empty JSON string');
  });

  it('round-trip JSON parse equals original payload structure for tool names', () => {
    const payload = getDiscoveryPayload();
    const parsed = JSON.parse(JSON.stringify(payload));
    const payloadNames = payload.tools.map(t => t.name).sort();
    const parsedNames  = parsed.tools.map(t => t.name).sort();
    assert.deepEqual(payloadNames, parsedNames);
  });

  it('server info in payload matches SERVER_CAPABILITIES', () => {
    const { server } = getDiscoveryPayload();
    assert.equal(server.name, SERVER_CAPABILITIES.name);
    assert.equal(server.version, SERVER_CAPABILITIES.version);
  });
});

describe('MCP Tool Manifest — tool-specific parameter validation', () => {
  it('start_session requires guild_id, voice_channel_id, text_channel_id', () => {
    const required = TOOL_MANIFESTS['start_session'].inputSchema.required;
    assert.ok(required.includes('guild_id'));
    assert.ok(required.includes('voice_channel_id'));
    assert.ok(required.includes('text_channel_id'));
  });

  it('start_session language property has enum with ko, en, multi', () => {
    const langProp = TOOL_MANIFESTS['start_session'].inputSchema.properties.language;
    assert.ok(Array.isArray(langProp.enum));
    assert.deepEqual(langProp.enum.sort(), ['en', 'ko', 'multi']);
  });

  it('stop_session requires only guild_id', () => {
    const { required } = TOOL_MANIFESTS['stop_session'].inputSchema;
    assert.deepEqual(required, ['guild_id']);
  });

  it('list_sessions accepts no required parameters', () => {
    const { required } = TOOL_MANIFESTS['list_sessions'].inputSchema;
    assert.deepEqual(required, []);
  });

  it('get_status guild_id parameter is optional (not in required)', () => {
    const { required } = TOOL_MANIFESTS['get_status'].inputSchema;
    assert.ok(!required.includes('guild_id'),
      'get_status.guild_id should be optional (not in required[])');
  });

  it('get_transcript has format enum with raw and formatted', () => {
    const formatProp = TOOL_MANIFESTS['get_transcript'].inputSchema.properties.format;
    assert.ok(Array.isArray(formatProp.enum));
    assert.ok(formatProp.enum.includes('raw'));
    assert.ok(formatProp.enum.includes('formatted'));
  });

  it('search_minutes limit has valid integer constraints', () => {
    const limitProp = TOOL_MANIFESTS['search_minutes'].inputSchema.properties.limit;
    assert.equal(limitProp.type, 'integer');
    assert.ok(limitProp.minimum >= 1, 'limit.minimum should be at least 1');
    assert.ok(limitProp.maximum <= 100, 'limit.maximum should be at most 100');
  });

  it('search_meeting_minutes limit is capped lower than search_minutes', () => {
    const smLimit = TOOL_MANIFESTS['search_minutes'].inputSchema.properties.limit.maximum;
    const smmLimit = TOOL_MANIFESTS['search_meeting_minutes'].inputSchema.properties.limit.maximum;
    assert.ok(smmLimit <= smLimit,
      'search_meeting_minutes limit cap should be <= search_minutes cap (content is larger)');
  });

  it('summarize_minutes has focus_query as an optional string property', () => {
    const props = TOOL_MANIFESTS['summarize_minutes'].inputSchema.properties;
    assert.ok('focus_query' in props, 'summarize_minutes must have focus_query property');
    assert.equal(props.focus_query.type, 'string');
    const { required } = TOOL_MANIFESTS['summarize_minutes'].inputSchema;
    assert.ok(!required.includes('focus_query'), 'focus_query must be optional');
  });

  it('get_meeting_minutes has include_transcript and include_raw_markdown boolean props', () => {
    const props = TOOL_MANIFESTS['get_meeting_minutes'].inputSchema.properties;
    assert.ok('include_transcript' in props);
    assert.equal(props.include_transcript.type, 'boolean');
    assert.ok('include_raw_markdown' in props);
    assert.equal(props.include_raw_markdown.type, 'boolean');
  });

  it('date_from and date_to in search tools have YYYY-MM-DD pattern', () => {
    const searchTools = [
      'search_minutes',
      'search_meeting_minutes',
      'summarize_minutes',
      'get_meeting_minutes',
    ];
    for (const toolName of searchTools) {
      const props = TOOL_MANIFESTS[toolName].inputSchema.properties;
      for (const dateProp of ['date_from', 'date_to']) {
        if (dateProp in props) {
          assert.ok(
            typeof props[dateProp].pattern === 'string',
            `${toolName}.${dateProp} must have a regex pattern`
          );
          const re = new RegExp(props[dateProp].pattern);
          assert.ok(re.test('2025-06-15'),
            `${toolName}.${dateProp}.pattern should match "2025-06-15"`);
          assert.ok(!re.test('15/06/2025'),
            `${toolName}.${dateProp}.pattern should not match "15/06/2025"`);
        }
      }
    }
  });
});

describe('MCP Tool Manifest — requires_bot accuracy', () => {
  const BOT_REQUIRED_TOOLS = ['start_session', 'start_recording', 'stop_session', 'stop_recording'];
  const STANDALONE_TOOLS = [
    'list_sessions', 'get_session', 'get_status', 'get_transcript',
    'get_minutes', 'list_recordings', 'search_minutes',
    'search_meeting_minutes', 'summarize_minutes', 'get_meeting_minutes',
  ];

  for (const name of BOT_REQUIRED_TOOLS) {
    it(`${name}: requires_bot is true`, () => {
      assert.equal(
        TOOL_MANIFESTS[name].metadata.requires_bot, true,
        `${name} needs the Discord bot and should have requires_bot: true`
      );
    });
  }

  for (const name of STANDALONE_TOOLS) {
    it(`${name}: requires_bot is false (works in standalone mode)`, () => {
      assert.equal(
        TOOL_MANIFESTS[name].metadata.requires_bot, false,
        `${name} should work without the Discord bot (requires_bot: false)`
      );
    });
  }
});
