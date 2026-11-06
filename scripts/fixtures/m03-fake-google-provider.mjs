import http from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("A dedicated loopback port is required.");

const files = new Map();
const events = [];
let nextFile = 1;
let nextSheet = 10;
let fault = null;

function send(response, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  response.end(payload);
}

function receive(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("Malformed JSON")); }
    });
    request.on("error", reject);
  });
}

function toColumn(value) {
  let result = 0;
  for (const char of value) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

function fromColumn(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const digit = (value - 1) % 26;
    result = String.fromCharCode(65 + digit) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function parseRange(value) {
  const separator = value.lastIndexOf("!");
  if (separator < 0) throw new Error("Unqualified test range");
  const rawTitle = value.slice(0, separator);
  const title = rawTitle.startsWith("'") && rawTitle.endsWith("'")
    ? rawTitle.slice(1, -1).replaceAll("''", "'") : rawTitle;
  const cellRange = value.slice(separator + 1);
  const match = /^\$?([A-Z]+)?\$?(\d+)?(?::\$?([A-Z]+)?\$?(\d+)?)?$/.exec(cellRange);
  if (!match || (!match[1] && !match[2]) || (cellRange.includes(":") && !match[3] && !match[4])) {
    throw new Error("Unsupported test range");
  }
  const startColumn = match[1] ? toColumn(match[1]) : 0;
  const startRow = match[2] ? Number(match[2]) - 1 : 0;
  const endColumn = match[3] ? toColumn(match[3]) : (cellRange.includes(":") && !match[4] ? null : startColumn);
  const endRow = match[4] ? Number(match[4]) - 1 : (cellRange.includes(":") ? null : startRow);
  return { title, startColumn, startRow, endColumn, endRow };
}

function getFile(id) { return files.get(id); }

function properties(file) {
  return {
    spreadsheetId: file.id,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
    properties: { title: file.name },
    sheets: [...file.sheets.values()].map((sheet) => ({ properties: { sheetId: sheet.id, title: sheet.title, gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns } } })),
  };
}

function fileMetadata(file) {
  return { id: file.id, name: file.name, mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: `https://docs.google.com/spreadsheets/d/${file.id}/edit`, version: String(file.version), appProperties: file.appProperties, trashed: false };
}

function readRange(file, range) {
  let area;
  try { area = parseRange(range); }
  catch { return { status: 400, error: { message: "Unsupported synthetic Sheet range" } }; }
  const sheet = [...file.sheets.values()].find((item) => item.title === area.title);
  if (!sheet) return { status: 400, error: { message: "Unable to parse range: tab not found" } };
  const endRow = area.endRow ?? sheet.rows - 1;
  const endColumn = area.endColumn ?? sheet.columns - 1;
  if (area.startRow >= sheet.rows || area.startColumn >= sheet.columns || endRow >= sheet.rows || endColumn >= sheet.columns) return { status: 400, error: { message: "Requested range exceeds grid limits" } };
  const values = [];
  for (let row = area.startRow; row <= endRow; row += 1) {
    const source = sheet.values.get(row) || [];
    const output = [];
    for (let column = area.startColumn; column <= endColumn; column += 1) output.push(source[column] ?? "");
    while (output.length && output.at(-1) === "") output.pop();
    values.push(output);
  }
  while (values.length && values.at(-1).length === 0) values.pop();
  return { status: 200, body: { range, majorDimension: "ROWS", values } };
}

function writeRange(file, range, values) {
  let area;
  try { area = parseRange(range); }
  catch { return { status: 400, error: { message: "Unsupported synthetic Sheet range" } }; }
  const sheet = [...file.sheets.values()].find((item) => item.title === area.title);
  if (!sheet) return { status: 400, error: { message: "Unable to parse range: tab not found" } };
  if (area.startRow + values.length > sheet.rows) return { status: 400, error: { message: "Requested range exceeds grid limits" } };
  let written = 0;
  for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
    const rowIndex = area.startRow + rowOffset;
    const row = sheet.values.get(rowIndex) || [];
    for (let columnOffset = 0; columnOffset < (values[rowOffset] || []).length; columnOffset += 1) {
      const columnIndex = area.startColumn + columnOffset;
      if (columnIndex >= sheet.columns) return { status: 400, error: { message: "Requested range exceeds grid limits" } };
      row[columnIndex] = values[rowOffset][columnOffset] ?? "";
      written += 1;
    }
    sheet.values.set(rowIndex, row);
  }
  file.version += 1;
  return { status: 200, body: { spreadsheetId: file.id, updatedRange: range, updatedRows: values.length, updatedColumns: values[0]?.length || 0, updatedCells: written } };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  const method = request.method || "GET";
  if (url.pathname === "/__test/health" && method === "GET") return send(response, 200, { ok: true, bind: "127.0.0.1" });
  if (url.pathname === "/__test/report" && method === "GET") return send(response, 200, { eventCount: events.length, routes: events.map((item) => item.route), workbookCount: files.size, fault: fault ? "armed" : null });
  if (url.pathname === "/__test/workbooks" && method === "GET") return send(response, 200, [...files.values()].map((file) => ({ id: file.id, tabs: [...file.sheets.values()].map((sheet) => ({ title: sheet.title, sheetId: sheet.id, rows: sheet.rows, columns: sheet.columns })) })));
  if (url.pathname === "/__test/read" && method === "GET") {
    const file = getFile(String(url.searchParams.get("id") || ""));
    if (!file) return send(response, 404, { error: "unknown_test_workbook" });
    const result = readRange(file, String(url.searchParams.get("range") || ""));
    return result.status === 200 ? send(response, 200, result.body) : send(response, result.status, result.error);
  }
  if (url.pathname === "/__test/fault" && method === "POST") {
    const body = await receive(request);
    fault = typeof body.routeIncludes === "string" ? body.routeIncludes : "all_google";
    return send(response, 200, { ok: true, armed: true });
  }
  if (url.pathname === "/__test/shutdown" && method === "POST") {
    send(response, 200, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 100);
    return;
  }
  if (url.pathname === "/__test/mutate" && method === "POST") {
    const body = await receive(request);
    const file = getFile(String(body.id || ""));
    if (!file) return send(response, 404, { error: "unknown_test_workbook" });
    const written = writeRange(file, String(body.range || ""), Array.isArray(body.values) ? body.values : []);
    if (written.status !== 200) return send(response, written.status, written.error);
    return send(response, 200, { ok: true, version: String(file.version) });
  }

  const route = `${method} ${url.pathname}`;
  events.push({ route });
  if (fault && (fault === "all_google" || route.includes(fault))) {
    fault = null;
    return send(response, 503, { error: { message: "Synthetic local provider interruption" } });
  }
  if (url.pathname === "/token" && method === "POST") return send(response, 200, { access_token: "m03-loopback-access", token_type: "Bearer", expires_in: 3600, scope: "drive.file gmail.readonly" });

  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const owner = /jobhuntai_owner_id'\s+and\s+value\s*=\s*'([^']+)'/.exec(url.searchParams.get("q") || "")?.[1];
    const matches = [...files.values()].filter((file) => !owner || file.appProperties.jobhuntai_owner_id === owner);
    return send(response, 200, { files: matches.map(fileMetadata) });
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const body = await receive(request);
    const id = `m03-synthetic-sheet-${String(nextFile++).padStart(5, "0")}`;
    const initial = { id: 1, title: "Sheet1", rows: 1000, columns: 26, values: new Map() };
    const file = { id, name: String(body.name || "JobHuntAI"), appProperties: body.appProperties || {}, version: 1, sheets: new Map([[1, initial]]) };
    files.set(id, file);
    return send(response, 200, fileMetadata(file));
  }
  const driveId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
  if (driveId && method === "GET") {
    const file = getFile(decodeURIComponent(driveId));
    return file ? send(response, 200, fileMetadata(file)) : send(response, 404, { error: { message: "File not found" } });
  }
  if (driveId && method === "DELETE") {
    files.delete(decodeURIComponent(driveId));
    return send(response, 204);
  }

  const sheetId = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(url.pathname)?.[1];
  if (sheetId && method === "GET") {
    const file = getFile(decodeURIComponent(sheetId));
    return file ? send(response, 200, properties(file)) : send(response, 404, { error: { message: "Spreadsheet not found" } });
  }
  const batchId = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(url.pathname)?.[1];
  if (batchId && method === "POST") {
    const file = getFile(decodeURIComponent(batchId));
    if (!file) return send(response, 404, { error: { message: "Spreadsheet not found" } });
    const body = await receive(request);
    const replies = [];
    for (const operation of body.requests || []) {
      if (operation.addSheet) {
        const props = operation.addSheet.properties || {};
        const id = props.sheetId ?? nextSheet++;
        if ([...file.sheets.values()].some((sheet) => sheet.title === props.title)) return send(response, 400, { error: { message: "A tab with this title already exists" } });
        const sheet = { id, title: String(props.title || `Sheet${id}`), rows: props.gridProperties?.rowCount || 1000, columns: props.gridProperties?.columnCount || 26, values: new Map() };
        file.sheets.set(id, sheet);
        replies.push({ addSheet: { properties: { sheetId: id, title: sheet.title, gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns } } } });
      } else if (operation.updateSheetProperties) {
        const props = operation.updateSheetProperties.properties || {};
        const sheet = file.sheets.get(Number(props.sheetId));
        if (!sheet) return send(response, 400, { error: { message: "Unknown sheet id" } });
        if (props.title) sheet.title = props.title;
        if (props.gridProperties?.rowCount) sheet.rows = props.gridProperties.rowCount;
        if (props.gridProperties?.columnCount) sheet.columns = props.gridProperties.columnCount;
        replies.push({ updateSheetProperties: { properties: { sheetId: sheet.id, title: sheet.title, gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns } } } });
      } else if (operation.deleteSheet) {
        file.sheets.delete(Number(operation.deleteSheet.sheetId));
        replies.push({ deleteSheet: {} });
      } else if (operation.repeatCell?.range && operation.repeatCell.fields?.includes("userEnteredValue")) {
        const range = operation.repeatCell.range;
        const sheet = file.sheets.get(Number(range.sheetId));
        if (sheet) for (let rowIndex = range.startRowIndex || 0; rowIndex < Math.min(range.endRowIndex || sheet.rows, sheet.rows); rowIndex += 1) {
          const row = sheet.values.get(rowIndex) || [];
          for (let columnIndex = range.startColumnIndex || 0; columnIndex < Math.min(range.endColumnIndex || sheet.columns, sheet.columns); columnIndex += 1) row[columnIndex] = "";
          sheet.values.set(rowIndex, row);
        }
        replies.push({});
      } else if (operation.copyPaste?.source && operation.copyPaste?.destination) {
        const source = file.sheets.get(Number(operation.copyPaste.source.sheetId));
        const destination = file.sheets.get(Number(operation.copyPaste.destination.sheetId));
        if (!source || !destination) return send(response, 400, { error: { message: "Unknown copy-paste test sheet" } });
        const sourceRange = operation.copyPaste.source;
        const target = operation.copyPaste.destination;
        const rows = Math.max(0, (sourceRange.endRowIndex || 0) - (sourceRange.startRowIndex || 0));
        const columns = Math.max(0, (sourceRange.endColumnIndex || 0) - (sourceRange.startColumnIndex || 0));
        for (let rowOffset = 0; rowOffset < rows; rowOffset += 1) {
          const sourceRow = source.values.get((sourceRange.startRowIndex || 0) + rowOffset) || [];
          const targetRow = destination.values.get((target.startRowIndex || 0) + rowOffset) || [];
          for (let columnOffset = 0; columnOffset < columns; columnOffset += 1) targetRow[(target.startColumnIndex || 0) + columnOffset] = sourceRow[(sourceRange.startColumnIndex || 0) + columnOffset] ?? "";
          destination.values.set((target.startRowIndex || 0) + rowOffset, targetRow);
        }
        replies.push({});
      } else replies.push({});
    }
    file.version += 1;
    return send(response, 200, { spreadsheetId: file.id, replies });
  }

  const batchReadId = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(url.pathname)?.[1];
  if (batchReadId && method === "GET") {
    const file = getFile(decodeURIComponent(batchReadId));
    if (!file) return send(response, 404, { error: { message: "Spreadsheet not found" } });
    const valueRanges = [];
    for (const range of url.searchParams.getAll("ranges")) {
      const result = readRange(file, range);
      if (result.status !== 200) return send(response, result.status, result.error);
      valueRanges.push(result.body);
    }
    return send(response, 200, { spreadsheetId: file.id, valueRanges });
  }
  const batchWriteId = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/.exec(url.pathname)?.[1];
  if (batchWriteId && method === "POST") {
    const file = getFile(decodeURIComponent(batchWriteId));
    if (!file) return send(response, 404, { error: { message: "Spreadsheet not found" } });
    const body = await receive(request);
    const responses = [];
    for (const item of body.data || []) {
      const result = writeRange(file, item.range, item.values || []);
      if (result.status !== 200) return send(response, result.status, result.error);
      responses.push(result.body);
    }
    return send(response, 200, { spreadsheetId: file.id, totalUpdatedCells: responses.reduce((sum, item) => sum + item.updatedCells, 0), responses });
  }
  const valuesMatch = /^\/v4\/spreadsheets\/([^/:]+)\/values\/(.+)$/.exec(url.pathname);
  if (valuesMatch) {
    const file = getFile(decodeURIComponent(valuesMatch[1]));
    if (!file) return send(response, 404, { error: { message: "Spreadsheet not found" } });
    let range;
    try { range = decodeURIComponent(valuesMatch[2]); } catch { range = valuesMatch[2]; }
    if (method === "GET") {
      const result = readRange(file, range);
      return result.status === 200 ? send(response, 200, result.body) : send(response, result.status, result.error);
    }
    if (["PUT", "POST"].includes(method)) {
      const body = await receive(request);
      const result = writeRange(file, range, body.values || []);
      return result.status === 200 ? send(response, 200, result.body) : send(response, result.status, result.error);
    }
  }

  return send(response, 404, { error: { message: "Unsupported loopback test-provider route" } });
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`READY ${port}\n`));
server.on("close", () => process.exit(0));
