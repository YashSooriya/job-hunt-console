import { inflateSync, strFromU8, unzipSync, unzlibSync } from "fflate";

export type SupportedDocumentFormat = "pdf" | "docx" | "txt" | "markdown" | "rtf";

export type DocumentExtraction = {
  format: SupportedDocumentFormat | null;
  text: string;
  error: string | null;
};

function extension(fileName: string) {
  return fileName.toLowerCase().split(".").pop() || "";
}

function normalizeText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim()
    .slice(0, 120000);
}

function stripRtf(value: string) {
  return normalizeText(
    value
      .replace(/\\'[0-9a-f]{2}/gi, "")
      .replace(/\\(par|line|tab)\b/g, (_, control: string) => (control === "tab" ? "\t" : "\n"))
      .replace(/\\[a-z]+-?\d* ?/gi, "")
      .replace(/[{}]/g, ""),
  );
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractDocx(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const documentXml = files["word/document.xml"];
  if (!documentXml) throw new Error("DOCX document.xml is missing.");
  const xml = strFromU8(documentXml);
  const paragraphs: string[] = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi;
  let paragraphMatch: RegExpExecArray | null;
  while ((paragraphMatch = paragraphPattern.exec(xml))) {
    const body = paragraphMatch[1]
      .replace(/<w:tab\s*\/?>(?:<\/w:tab>)?/gi, "\t")
      .replace(/<w:br\s*\/?>(?:<\/w:br>)?/gi, "\n");
    const text = [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)]
      .map((match) => decodeXml(match[1]))
      .join("");
    if (text.trim()) paragraphs.push(text);
  }
  if (!paragraphs.length) {
    paragraphs.push(
      ...[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map((match) => decodeXml(match[1])),
    );
  }
  return normalizeText(paragraphs.join("\n"));
}

function binaryString(bytes: Uint8Array) {
  let result = "";
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    result += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return result;
}

function decodePdfLiteral(value: string) {
  const body = value.slice(1, -1);
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = body[++index];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "\r") {
      if (body[index + 1] === "\n") index += 1;
    } else if (next === "\n") {
      // PDF line continuation.
    } else if (/[0-7]/.test(next)) {
      const octal = (next + (body[index + 1] || "") + (body[index + 2] || "")).match(/^[0-7]{1,3}/)?.[0] || next;
      output += String.fromCharCode(parseInt(octal, 8));
      index += octal.length - 1;
    } else output += next;
  }
  return output;
}

function decodePdfHex(value: string) {
  const hex = value.slice(1, -1).replace(/\s/g, "");
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2).padEnd(2, "0"), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function pdfOperatorText(content: string) {
  const chunks: string[] = [];
  const token = /(\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-f\s]+>)/gi;
  const pushTokens = (value: string) => {
    let match: RegExpExecArray | null;
    while ((match = token.exec(value))) chunks.push(match[1][0] === "(" ? decodePdfLiteral(match[1]) : decodePdfHex(match[1]));
  };
  const direct = /(\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-f\s]+>)\s*T[Jj]/gi;
  let directMatch: RegExpExecArray | null;
  while ((directMatch = direct.exec(content))) pushTokens(directMatch[1]);
  const arrays = /\[([\s\S]*?)\]\s*TJ/gi;
  let arrayMatch: RegExpExecArray | null;
  while ((arrayMatch = arrays.exec(content))) pushTokens(arrayMatch[1]);
  return chunks.join(" ");
}

function extractPdf(bytes: Uint8Array) {
  const binary = binaryString(bytes);
  const streams: string[] = [binary];
  let cursor = 0;
  while (cursor < binary.length) {
    const streamIndex = binary.indexOf("stream", cursor);
    if (streamIndex < 0) break;
    const dataStart = binary[streamIndex + 6] === "\r" && binary[streamIndex + 7] === "\n"
      ? streamIndex + 8
      : streamIndex + 6;
    const dataEnd = binary.indexOf("endstream", dataStart);
    if (dataEnd < 0) break;
    const compressed = bytes.subarray(dataStart, dataEnd);
    const header = binary.slice(Math.max(0, streamIndex - 260), streamIndex);
    if (/\/FlateDecode/.test(header)) {
      try {
        streams.push(strFromU8(unzlibSync(compressed)));
      } catch {
        try {
          streams.push(strFromU8(inflateSync(compressed)));
        } catch {
          // Keep scanning other streams; some PDFs contain unsupported filters.
        }
      }
    } else {
      streams.push(binary.slice(dataStart, dataEnd));
    }
    cursor = dataEnd + 9;
  }
  return normalizeText(streams.map(pdfOperatorText).filter(Boolean).join("\n"));
}

export function detectDocumentFormat(fileName: string, mimeType = ""): SupportedDocumentFormat | null {
  const ext = extension(fileName);
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (ext === "md" || ext === "markdown" || mimeType === "text/markdown") return "markdown";
  if (ext === "txt" || mimeType.startsWith("text/plain")) return "txt";
  if (ext === "rtf" || mimeType === "application/rtf" || mimeType === "text/rtf") return "rtf";
  return null;
}

export function extractDocumentText(bytes: Uint8Array, fileName: string, mimeType = ""): DocumentExtraction {
  const format = detectDocumentFormat(fileName, mimeType);
  if (!format) return { format: null, text: "", error: "Supported formats are PDF, DOCX, TXT, Markdown or RTF." };
  try {
    const raw = format === "docx"
      ? extractDocx(bytes)
      : format === "pdf"
        ? extractPdf(bytes)
        : format === "rtf"
          ? stripRtf(new TextDecoder().decode(bytes))
          : normalizeText(new TextDecoder().decode(bytes));
    return raw.length >= 40
      ? { format, text: raw, error: null }
      : { format, text: raw, error: "No selectable text was found. Upload an accessible document with a text layer." };
  } catch (error) {
    return { format, text: "", error: error instanceof Error ? error.message : "Document extraction failed." };
  }
}
