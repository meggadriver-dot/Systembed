import fs from 'node:fs';
import path from 'node:path';

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId?: string;
}

function loadConfig(): FirebaseAppletConfig {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as FirebaseAppletConfig;
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function decodeValue(val: FirestoreValue | undefined): unknown {
  if (!val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number.parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map((v) => decodeValue(v));
  if ('mapValue' in val) return decodeFields(val.mapValue.fields || {});
  return null;
}

function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeValue(v);
  }
  return out;
}

function docIdFromName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] || '';
}

function getBaseFirestoreUrl() {
  const cfg = loadConfig();
  const dbId = cfg.firestoreDatabaseId || '(default)';
  return {
    baseUrl: `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(dbId)}/documents`,
    apiKey: cfg.apiKey,
  };
}

export async function firestoreRestGetDoc(docPath: string): Promise<Record<string, unknown> | null> {
  const { baseUrl, apiKey } = getBaseFirestoreUrl();
  const url = `${baseUrl}/${docPath}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
  if (!data.fields) return null;
  return {
    id: docIdFromName(data.name || docPath),
    ...decodeFields(data.fields),
  };
}

export async function firestoreRestRunQuery(
  parentPath: string,
  collectionId: string,
  filters: Array<{ field: string; value: string | number | boolean }>,
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  const { baseUrl, apiKey } = getBaseFirestoreUrl();
  const parent = parentPath ? `${baseUrl}/${parentPath}` : baseUrl;
  const url = `${parent}:runQuery?key=${encodeURIComponent(apiKey)}`;

  const fieldFilters = filters.map((f) => {
    let encodedVal: FirestoreValue;
    if (typeof f.value === 'boolean') {
      encodedVal = { booleanValue: f.value };
    } else if (typeof f.value === 'number') {
      encodedVal = { integerValue: String(Math.trunc(f.value)) };
    } else {
      encodedVal = { stringValue: f.value };
    }
    return {
      fieldFilter: {
        field: { fieldPath: f.field },
        op: 'EQUAL',
        value: encodedVal,
      },
    };
  });

  const whereClause =
    fieldFilters.length === 1
      ? fieldFilters[0]
      : fieldFilters.length > 1
        ? { compositeFilter: { op: 'AND', filters: fieldFilters } }
        : undefined;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        ...(whereClause ? { where: whereClause } : {}),
        limit,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ document?: { name: string; fields?: Record<string, FirestoreValue> } }>;
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.document?.fields) {
      results.push({
        id: docIdFromName(row.document.name),
        ...decodeFields(row.document.fields),
      });
    }
  }
  return results;
}
