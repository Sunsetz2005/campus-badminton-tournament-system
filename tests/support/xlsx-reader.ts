import { crc32, inflateRawSync } from "node:zlib";

/**
 * 测试专用：独立于写出器的最小 ZIP/XLSX 读取。按中央目录定位每个条目、解压并校验 CRC，
 * 再从工作表 XML 里取出单元格文本，用来核对「文件里写的」与数据库一致。
 */
export function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("不是 ZIP 文件");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== checksum) throw new Error(`${name} CRC 不符`);
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unescape(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export interface ParsedSheet {
  name: string;
  xml: string;
  rows: string[][];
}

/** 按工作簿顺序返回每个工作表的名称、原始 XML 与逐行单元格文本（数字转成字符串）。 */
export function readXlsx(bytes: Buffer): ParsedSheet[] {
  const files = readZip(bytes);
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((match) => unescape(match[1]));
  return names.map((name, index) => {
    const xml = files.get(`xl/worksheets/sheet${index + 1}.xml`)?.toString("utf8") ?? "";
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/g)) {
      rows[Number(row[1]) - 1] = [...row[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)].reduce<string[]>((cells, cell) => {
        const column = cell[1].split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
        const inner = cell[2] ?? "";
        const text = /<t[^>]*>(.*?)<\/t>/s.exec(inner)?.[1] ?? /<v>(.*?)<\/v>/.exec(inner)?.[1] ?? "";
        cells[column] = unescape(text);
        return cells;
      }, []);
    }
    // 空行（写出器为分隔留下的行号空缺）按空数组返回。
    return { name, xml, rows: Array.from(rows, (row) => Array.from(row ?? [], (cell) => cell ?? "")) };
  });
}

/** 取某个工作表表头之后的数据行（表头按首列文字定位）。 */
export function tableRows(sheet: ParsedSheet, firstHeader: string) {
  const header = sheet.rows.findIndex((row) => row[0] === firstHeader);
  if (header < 0) throw new Error(`工作表「${sheet.name}」找不到表头「${firstHeader}」`);
  const rows: string[][] = [];
  for (const row of sheet.rows.slice(header + 1)) {
    if (!row.length || row.every((cell) => cell === "")) break;
    rows.push(row);
  }
  return { header: sheet.rows[header], rows };
}
